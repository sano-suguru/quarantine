// worker/arena.ts
// Authoritative game arena as a Durable Object. Runs the headless sim on a fixed-dt setInterval
// loop and broadcasts binary snapshots to every connected client over one WebSocket each.
// Standard WebSocket API (not Hibernation): the loop is non-hibernatable anyway, and an in-memory
// socket map mirrors the proven room.ts pattern.
import { CONFIG } from "../sim/config";
import { HOME_SPAWN } from "../sim/data/map";
import { addPlayer, removePlayer } from "../sim/engine/players";
import { clearFx } from "../sim/events";
import { applyCycle, type CycleBlob, SCHEMA_VERSION, serializeCycle } from "../sim/net/persist";
import { PROTOCOL_VERSION } from "../sim/net/protocol";
import { makeNonce, pickSlot, rejoinMatches } from "../sim/net/roster";
import { frameRel, frameSnap, unframe } from "../sim/net/wire";
import { encodeSnapshot } from "../sim/snapshot";
import { newState } from "../sim/state";
import { stepSim } from "../sim/step";
import { sysDawn } from "../sim/systems/dawn";
import {
  applyBuy,
  applyDraftReroll,
  applyDraftTake,
  applyPlace,
  rollDraft,
} from "../sim/systems/shop";
import { rearmThaw, resetArena, startDay } from "../sim/systems/siege";
import type { State } from "../sim/types";

// No Env export: the Arena class takes no env binding in 2a (the DO itself is looked up by name
// in wrangler.toml; env is not threaded through the constructor).

const STEP_MS = 1000 / CONFIG.simHz;
// ticks per broadcast. With CONFIG.net.sendHz=30 this is 2 → 30 Hz broadcast (existing rate).
// The umbrella spec suggested starting ~20 Hz to widen the per-DO message budget margin at 12
// players; if the gate shows inbound+outbound pressure, lower sendHz (or add a net.broadcastHz).
const BROADCAST_EVERY = Math.max(1, Math.round(CONFIG.simHz / CONFIG.net.sendHz));

interface Peer {
  ws: WebSocket;
  pid: number; // -1 until decided
  decided: boolean;
  nonce: string;
  goneAt: number; // Date.now() when the socket dropped; 0 = live
}

export class Arena {
  private peers = new Map<WebSocket, Peer>();
  private state: State | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  // metrics (spec §feel gate): effective tick rate + last snapshot size, logged periodically.
  private ticksThisWindow = 0;
  private windowStartMs = 0;
  private lastSnapBytes = 0;
  private ctx: DurableObjectState;
  private saved: CycleBlob | null = null;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
    // Cold start: hydrate the frozen cycle before any request is processed. Must not throw
    // (that would abort the DO) — a missing/corrupt/stale blob just means "fresh Day-1".
    ctx.blockConcurrencyWhile(async () => {
      try {
        const blob = await ctx.storage.get<CycleBlob>("cycle");
        this.saved = blob && blob.schemaVersion === SCHEMA_VERSION ? blob : null;
      } catch {
        this.saved = null;
      }
    });
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1] as WebSocket;
    // CRITICAL (verified vs CF changelog 2026-04-21): with a compat date >= 2026-03-17 (ours is
    // 2026-06-01) the STANDARD WebSocket API delivers binary frames as Blob by default. Our
    // onMessage does `new Uint8Array(data)` on an ArrayBuffer — a Blob would silently break every
    // input/join frame (snapshots still broadcast, so it looks alive but no one spawns). Opt back
    // into ArrayBuffer per-socket BEFORE accept(). (The DO hibernatable handler is unaffected, but
    // we use the standard API.)
    server.binaryType = "arraybuffer";
    server.accept();
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private ensureRunning(): void {
    if (!this.state) {
      const s = newState();
      s.running = true;
      if (this.saved) {
        applyCycle(s, this.saved); // restore the frozen communal cycle (day/phase/phaseT/…)
        rearmThaw(s); // re-arm the phase's spawner WITHOUT touching restored phaseT/caches
      } else {
        startDay(s); // brand-new arena → fresh Day-1
      }
      this.state = s;
    }
    if (!this.loop) {
      this.windowStartMs = Date.now();
      this.loop = setInterval(() => this.step(), STEP_MS);
    }
  }

  private step(): void {
    const s = this.state;
    if (!s) return;
    const outcome = stepSim(s, 1 / CONFIG.simHz); // fixed-dt, one tick one step
    if (outcome === "dawn") {
      // living cycle: advance the day, bank SALVAGE to present players, revive stragglers, re-enter day.
      const payouts = sysDawn(s);
      for (const { pid, salvage } of payouts) {
        if (salvage <= 0) continue;
        const peer = [...this.peers.values()].find((p) => p.decided && p.pid === pid);
        if (peer) this.send(peer.ws, { t: "banked", salvage });
      }
    } else if (outcome === "reset") {
      // fortress fell → rebuild to a fresh Day-1. Communal only; per-player SALVAGE is client meta.
      resetArena(s); // the settled Day-1 is persisted by the persist() call below
    }
    // "breached"/"night"/null need no DO reaction — the frozen tableau keeps broadcasting and the
    // client derives the beat + reset from the synced phase edge.
    if (outcome === "dawn" || outcome === "night" || outcome === "reset") this.persist();
    clearFx(s); // zero fxEvents on the wire — cues are all client-derived
    this.tick++;
    this.ticksThisWindow++;

    // Retire held bodies whose grace window has expired.
    const grace = CONFIG.net.reconnect.graceMs;
    const now = Date.now();
    for (const p of [...this.peers.values()]) {
      if (!p.decided || p.goneAt === 0) continue;
      if (now - p.goneAt > grace) {
        removePlayer(s, p.pid);
        this.peers.delete(p.ws);
      }
    }

    // Stop the loop when the last held body expires (empty-arena stop).
    if (this.peers.size === 0) {
      this.stop();
      return;
    }

    if (this.tick % BROADCAST_EVERY === 0) this.broadcast();
    // effective tick-rate log every ~5 s (spec: the 30 Hz-fallback trigger + gate instrument)
    if (now - this.windowStartMs >= 5000) {
      const hz = (this.ticksThisWindow * 1000) / (now - this.windowStartMs);
      console.log(
        `[arena] effective ${hz.toFixed(1)} Hz · snap ${this.lastSnapBytes} B · clients ${this.peers.size}`,
      );
      this.ticksThisWindow = 0;
      this.windowStartMs = now;
    }
  }

  private broadcast(): void {
    const s = this.state;
    if (!s || this.peers.size === 0) return;
    const buf = encodeSnapshot(s, this.tick);
    this.lastSnapBytes = buf.byteLength;
    const framed = frameSnap(buf);
    for (const { ws } of this.peers.values()) {
      try {
        ws.send(framed);
      } catch {
        /* socket mid-close — the close handler prunes it */
      }
    }
  }

  private attach(ws: WebSocket): void {
    const peer: Peer = { ws, pid: -1, decided: false, nonce: "", goneAt: 0 };
    this.peers.set(ws, peer);
    this.ensureRunning();
    ws.addEventListener("message", (ev) => this.onMessage(peer, ev.data as ArrayBuffer));
    ws.addEventListener("close", () => this.onClose(peer));
    ws.addEventListener("error", () => this.onClose(peer));
  }

  // onMessage, decideFresh, and tryRejoin are all non-async (: void) — the synchronous path
  // from pickSlot → peer.decided = true is the only thing preventing a double-claim race.
  // DO message handlers are sequential/non-reentrant, so this holds only if no await sneaks in.
  private onMessage(peer: Peer, data: ArrayBuffer): void {
    const u = unframe(data);
    if (u.kind !== "rel") return; // clients only send rel (input/join/…) — snapshots are server→client
    const msg = u.obj as { t: string; [k: string]: unknown };
    const s = this.state;
    if (!s) return;
    if (msg.t === "join" || msg.t === "rejoin") {
      if (peer.decided) return; // duplicate claim
      if (msg.t === "rejoin") this.tryRejoin(peer, msg.pid as number, msg.nonce as string);
      else this.decideFresh(peer);
      return;
    }
    if (!peer.decided) return; // gameplay before identity is dropped
    if (msg.t === "input") {
      const p = s.players.find((pl) => pl.id === peer.pid);
      // No validation: PlayerInput is all JSON-safe primitives, and 2a is cooperative (not
      // adversarial). A malformed client could NaN-poison sysPlayer; accepted for 2a scope.
      if (p) p.input = msg.input as State["players"][number]["input"];
    } else if (msg.t === "ping") {
      this.send(peer.ws, { t: "pong", id: msg.id });
    } else if (msg.t === "buy") {
      applyBuy(
        s,
        msg.itemId as string,
        s.players.find((pl) => pl.id === peer.pid),
      );
    } else if (msg.t === "place") {
      applyPlace(
        s,
        s.players.find((pl) => pl.id === peer.pid),
      );
    } else if (msg.t === "draftTake") {
      applyDraftTake(
        s,
        s.players.find((pl) => pl.id === peer.pid),
        msg.cardId as string,
      );
    } else if (msg.t === "draftReroll") {
      applyDraftReroll(
        s,
        s.players.find((pl) => pl.id === peer.pid),
      );
    }
    // "deploy" is retired in 2b: the day starts at dawn on the DO, and closing the shop overlay
    // is client-local. A stray "deploy" from an old client is ignored (no branch).
  }

  private decideFresh(peer: Peer): void {
    const s = this.state;
    if (!s || peer.decided) return;
    const decided = [...this.peers.values()].filter((p) => p.decided).map((p) => p.pid);
    const slot = pickSlot(decided, CONFIG.net.maxPlayers);
    if (slot.kind === "full") {
      this.send(peer.ws, { t: "roomfull" });
      return; // client tears down on receipt
    }
    peer.pid = slot.pid;
    peer.nonce = makeNonce();
    peer.decided = true; // committed synchronously — no await above this line
    this.spawnFresh(peer.pid);
    this.sendHello(peer);
  }

  private tryRejoin(peer: Peer, pid: number, nonce: string): void {
    const s = this.state;
    if (!s) return;
    const old = [...this.peers.values()].find((p) => p !== peer && rejoinMatches(p, pid, nonce));
    const body = s.players.find((p) => p.id === pid);
    if (old && body) {
      peer.pid = pid;
      peer.nonce = nonce;
      peer.decided = true;
      body.absent = false;
      old.goneAt = 0;
      this.dropPeer(old); // untrack the stale peer (its body is now owned by `peer`)
      this.sendHello(peer, true); // re-attached in place
    } else {
      this.decideFresh(peer); // grace expired / unknown token → fresh slot
    }
  }

  private spawnFresh(pid: number): void {
    const s = this.state;
    if (!s || s.players.some((p) => p.id === pid)) return;
    const x = HOME_SPAWN.x + ((pid % 4) - 1.5) * 36;
    // drop-in: spawn ALIVE at the fortress in the current phase (respawn/spectate handled by sysRespawn)
    addPlayer(s, pid, x, HOME_SPAWN.y, `P${pid + 1}`);
    // a joiner arriving mid-day missed the dawn roll — give them an offer now (stamped so the
    // next dawn's roll pass skips them and they don't get a second set of free picks).
    if (s.phase === "day") {
      const p = s.players.find((pl) => pl.id === pid);
      if (p) {
        rollDraft(s, p);
        p.draftRolledForDay = s.day;
      }
    }
  }

  private sendHello(peer: Peer, resumed = false): void {
    const s = this.state;
    if (!s) return;
    this.send(peer.ws, {
      t: "hello",
      localId: peer.pid,
      owned: s.owned,
      nonce: peer.nonce,
      v: PROTOCOL_VERSION,
      resumed,
    });
  }

  private send(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(frameRel(obj));
    } catch {
      /* mid-close */
    }
  }

  private onClose(peer: Peer): void {
    if (peer.decided) {
      const s = this.state;
      const body = s?.players.find((p) => p.id === peer.pid);
      if (body) {
        // Hold the body for reconnect grace window; retire in step() when graceMs expires.
        body.absent = true;
        peer.goneAt = Date.now();
        return; // keep the peer entry so tryRejoin can find it
      }
    }
    this.peers.delete(peer.ws);
    if (this.peers.size === 0) this.stop();
  }

  /** Remove a peer record without triggering stop() — used when a rejoin takes over a stale slot. */
  private dropPeer(peer: Peer): void {
    this.peers.delete(peer.ws);
  }

  /** Snapshot the communal cycle to the in-memory cache + DO storage. Skipped during the
   *  transient breached/resetting beat (never resume into it). Fire-and-forget: the sync step
   *  loop must not await; a rare one-tick broadcast delay at a boundary is acceptable. */
  private persist(): void {
    const s = this.state;
    if (!s || s.phase === "breached" || s.phase === "resetting") return;
    this.saved = serializeCycle(s);
    this.ctx.storage
      .put("cycle", this.saved)
      .catch((e) => console.log("[arena] persist failed", e));
  }

  private stop(): void {
    this.persist(); // freeze the cycle to storage before discarding in-memory state
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    this.state = null;
    this.tick = 0;
    // Reset metrics so stale numbers don't appear if this DO instance is reused.
    this.ticksThisWindow = 0;
    this.windowStartMs = 0;
    this.lastSnapBytes = 0;
    // Retire all peers immediately — held bodies must not linger across a reset
    // (the frozen-clock hazard: goneAt timestamps become meaningless after stop()).
    this.peers.clear();
  }
}
