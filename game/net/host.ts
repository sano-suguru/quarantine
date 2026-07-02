import { CONFIG } from "../config";
import { HOME_SPAWN } from "../data/map";
import { addPlayer, removePlayer } from "../engine/players";
import {
  applyBuy,
  applyDraftReroll,
  applyDraftTake,
  applyPlace,
  getState,
  rollDraft,
  shopDeploy,
} from "../game";
import { type NetMsg, PROTOCOL_VERSION } from "./net";
import { encodeSnapshot } from "./snapshot";
import type { PeerLink } from "./transport";

interface HostPeer {
  link: PeerLink;
  /** assigned player id (1..3). -1 until the client's first rel (join/rejoin) decides it. */
  pid: number;
  open: boolean;
  decided: boolean;
  /** reconnect token sent in Hello; the client replays it on rejoin to re-claim this slot. */
  nonce: string;
  /** when this peer's link dropped (performance.now); the body is held until +graceMs. 0 = live. */
  goneAt: number;
  /** fallback timer: if no first rel arrives shortly after open, treat the peer as a fresh join. */
  claimTimer: ReturnType<typeof setTimeout> | null;
}

/** Max simultaneous clients (host is pid 0; clients claim pids 1..MAX_CLIENTS). */
export const MAX_CLIENTS = 3;

/** After sending `roomfull`, give the client this long to close its own link before the host
 *  force-closes it (covers an old client that ignores the message). */
const REJECT_CLOSE_MS = 2000;

export type SlotDecision = { kind: "assign"; pid: number } | { kind: "full" };

/**
 * Pure slot picker — the single source of truth for the room cap. Returns the lowest free client
 * slot (1..MAX_CLIENTS), or `full` when every slot is taken. A slot counts as occupied by ANY
 * decided peer, whether currently `open` or held `absent` for reconnect — a held body's slot is
 * reserved for its owner (we do NOT evict it; see the design doc, feel-first).
 */
export function pickSlot(decidedPids: Iterable<number>): SlotDecision {
  const used = new Set(decidedPids);
  for (let n = 1; n <= MAX_CLIENTS; n++) if (!used.has(n)) return { kind: "assign", pid: n };
  return { kind: "full" };
}

let nonceSeq = 0;
function makeNonce(): string {
  // cooperative (not adversarial) — just needs to be unique enough to not collide across a session
  return `${(nonceSeq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Host role: owns the authoritative sim and fans world snapshots out to every client.
 *
 * Identity is decided from the client's FIRST reliable message after a P2P open (not on connect):
 *   - `join`   → a fresh peer; the host assigns a free slot (1..3) and a reconnect nonce.
 *   - `rejoin` → a reconnect; the host matches pid+nonce to the dropped player's still-held body
 *                and re-attaches the new link in place (no respawn, gear/hp/pos kept).
 * A dropped link does NOT remove the player immediately: the body is marked `absent` (inert) and
 * held for CONFIG.net.reconnect.graceMs so a quick reconnect re-attaches; past that it's removed
 * and a later rejoin becomes a fresh respawn. This is the listen-server reconnect (P4).
 */
export class Host {
  readonly links: PeerLink[] = [];
  /** Roster-change notifier: invoked whenever connectedPids() could change (a peer decided,
   *  dropped, was refused, re-attached, or a held body expired). The lobby squad refreshes from
   *  THIS — the host's authoritative roster — so its badges never lag a connection event. */
  onRoster: (() => void) | null = null;
  private peers: HostPeer[] = [];
  private started = false;
  private disposed = false;
  // when set, broadcasts are suppressed until this time (?netlog test hook to force snap starvation)
  private broadcastPausedUntil = 0;

  private notifyRoster(): void {
    this.onRoster?.();
  }

  add(link: PeerLink): void {
    if (this.disposed) {
      try {
        link.close(); // a stale createHostLink()/signaling callback landed after teardown — refuse it
      } catch {
        /* already closing — ignore */
      }
      return;
    }
    const peer: HostPeer = {
      link,
      pid: -1,
      open: false,
      decided: false,
      nonce: "",
      goneAt: 0,
      claimTimer: null,
    };
    this.peers.push(peer);
    this.links.push(link);

    link.onOpen(() => {
      peer.open = true;
      if (!this.started) {
        // lobby: no reconnect is possible before the game starts → decide a slot immediately
        // (the client's `join` first-rel then no-ops on the already-decided peer)
        this.decideFresh(peer);
      } else {
        // mid-game: wait for the client's first rel to tell a rejoin (re-attach a held body)
        // from a fresh join; fall back to fresh if it never arrives
        peer.claimTimer = setTimeout(
          () => this.decideFresh(peer),
          CONFIG.net.reconnect.rejoinClaimTimeoutMs,
        );
      }
    });

    link.onRel((m) => {
      if (!this.peers.includes(peer)) return; // stale link after a re-attach — ignore
      const msg = m as NetMsg;
      const st = getState();
      if (msg.t === "join" || msg.t === "rejoin") {
        if (peer.decided) return; // duplicate claim
        if (peer.claimTimer) clearTimeout(peer.claimTimer);
        peer.claimTimer = null;
        if (msg.t === "rejoin") this.tryRejoin(peer, msg.pid, msg.nonce);
        else this.decideFresh(peer);
        return;
      }
      if (!peer.decided) return; // gameplay messages before identity is decided are dropped
      if (msg.t === "input") {
        const p = st.players.find((pl) => pl.id === peer.pid);
        if (p) p.input = msg.input;
      } else if (msg.t === "buy") {
        applyBuy(
          st,
          msg.itemId,
          st.players.find((pl) => pl.id === peer.pid),
        );
      } else if (msg.t === "place") {
        applyPlace(
          st,
          st.players.find((pl) => pl.id === peer.pid),
        ); // host drops the requester's queued deployable at their feet (validated, idempotent-safe)
      } else if (msg.t === "deploy") {
        shopDeploy(); // idempotent (no-op unless the shop is open)
      } else if (msg.t === "draftTake") {
        applyDraftTake(
          st,
          st.players.find((pl) => pl.id === peer.pid),
          msg.cardId,
        );
      } else if (msg.t === "draftReroll") {
        applyDraftReroll(
          st,
          st.players.find((pl) => pl.id === peer.pid),
        );
      } else if (msg.t === "ping") {
        link.sendRel({ t: "pong", id: msg.id }); // RTT probe echo (see client netStats)
      }
    });

    link.onClose(() => {
      if (peer.claimTimer) clearTimeout(peer.claimTimer);
      peer.claimTimer = null;
      if (!this.peers.includes(peer)) return; // already re-attached/untracked
      peer.open = false;
      const li = this.links.indexOf(link);
      if (li >= 0) this.links.splice(li, 1); // stop broadcasting to the dead link
      if (this.started && peer.decided) {
        const p = getState().players.find((pl) => pl.id === peer.pid);
        if (p) {
          // hold the body: inert + a grace clock. A rejoin within graceMs re-attaches in place;
          // tickGrace() removes it past graceMs.
          p.absent = true;
          peer.goneAt = performance.now();
        } else {
          this.peers = this.peers.filter((x) => x !== peer); // body already gone
        }
      } else {
        this.peers = this.peers.filter((x) => x !== peer); // pre-game / undecided drop
      }
      this.notifyRoster(); // peer.open is now false (or the peer is gone) → squad shrinks
    });
  }

  /**
   * Terminal teardown: drop every peer and close every link. Idempotent and re-entrancy-safe —
   * peers/links are cleared BEFORE close() so the onClose handler (guarded by peers.includes) is a
   * no-op when the real link fires it synchronously. Also cancels any pending rejoin claim timers.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const peer of this.peers) {
      if (peer.claimTimer) clearTimeout(peer.claimTimer);
      peer.claimTimer = null;
    }
    const links = [...this.links];
    this.peers = [];
    this.links.length = 0;
    this.started = false;
    for (const link of links) {
      try {
        link.close();
      } catch {
        /* already closing — teardown must not throw */
      }
    }
  }

  /** Assign a fresh slot + nonce, send Hello, and (if running) spawn the player. Rejects when the
   *  room is full. NOTE: must stay synchronous — pickSlot reads the live peer set and the result is
   *  applied before any other onOpen/onRel runs; an `await` here would let two joins claim one slot. */
  private decideFresh(peer: HostPeer): void {
    if (peer.decided || !this.peers.includes(peer)) return;
    if (peer.claimTimer) clearTimeout(peer.claimTimer);
    peer.claimTimer = null;
    const slot = pickSlot(this.decidedPids());
    if (slot.kind === "full") {
      this.reject(peer);
      return;
    }
    peer.pid = slot.pid;
    peer.nonce = makeNonce();
    peer.decided = true;
    this.sendHello(peer);
    if (this.started) this.spawnFresh(peer.pid);
    this.notifyRoster(); // a new open+decided peer → squad gains a badge
  }

  /** Room is at capacity. Tell the client, then untrack the peer at once: a refused peer is a
   *  non-participant (not a held body), so it must drop out of broadcast() and the headcount
   *  immediately. We deliberately do NOT close the link here — closing before the rel flushes could
   *  drop `roomfull` from the DataChannel buffer, so the client closes its own link on receipt. The
   *  timer is a fail-safe close for an old client that ignores the message; untracking already
   *  happened, so it has nothing to do but close. */
  private reject(peer: HostPeer): void {
    peer.link.sendRel({ t: "roomfull" } satisfies NetMsg);
    this.untrack(peer);
    setTimeout(() => {
      try {
        peer.link.close();
      } catch {
        /* already closing / closed by the client */
      }
    }, REJECT_CLOSE_MS);
  }

  /** A reconnect claim: match pid+nonce to the held body and re-attach in place; else fresh. */
  private tryRejoin(peer: HostPeer, pid: number, nonce: string): void {
    const st = getState();
    const old = this.peers.find(
      (x) => x !== peer && x.decided && x.pid === pid && x.nonce === nonce,
    );
    const body = st.players.find((p) => p.id === pid);
    if (old && body) {
      // re-attach to the live (held) body — no respawn, gear/hp/pos preserved
      peer.pid = pid;
      peer.nonce = nonce; // stable identity for further reconnects
      peer.decided = true;
      peer.goneAt = 0;
      body.absent = false; // resume the body
      this.dropOld(old); // untrack + close the old link FIRST so its onClose no-ops
      this.sendHello(peer);
      this.notifyRoster(); // re-attached peer is present again → squad restores the badge
    } else {
      if (old) this.dropOld(old);
      this.decideFresh(peer); // grace expired / unknown token → fresh slot
    }
  }

  /** Drop a peer from both tracking arrays (peers + the broadcast link list). Does NOT close the
   *  link — callers decide whether/when to close (reject() defers it; dropOld() closes at once). */
  private untrack(peer: HostPeer): void {
    this.peers = this.peers.filter((x) => x !== peer);
    const li = this.links.indexOf(peer.link);
    if (li >= 0) this.links.splice(li, 1);
    this.notifyRoster(); // a refused/superseded peer left the roster → squad refreshes
  }

  /** Untrack a superseded peer and close its (dead) link, guarded so its callbacks no-op. */
  private dropOld(old: HostPeer): void {
    if (old.claimTimer) clearTimeout(old.claimTimer);
    this.untrack(old);
    try {
      old.link.close();
    } catch {
      /* already closing */
    }
  }

  private sendHello(peer: HostPeer): void {
    const st = getState();
    const hello: NetMsg = {
      t: "hello",
      localId: peer.pid,
      owned: st.owned,
      nonce: peer.nonce,
      v: PROTOCOL_VERSION,
    };
    peer.link.sendRel(hello);
  }

  /** Spawn a fresh player for a slot: alive at HOME by day/shop; a downed spectator at night
   *  (revived at the next dawn by openShop) so a mid-night arrival matches the death/respawn feel. */
  private spawnFresh(pid: number): void {
    const st = getState();
    if (st.players.some((p) => p.id === pid)) return;
    const x = HOME_SPAWN.x + ((pid % 4) - 1.5) * 36;
    const p = addPlayer(st, pid, x, HOME_SPAWN.y, `P${pid + 1}`);
    if (st.phase === "night" && !st.inShop) p.hp = 0;
    if (st.inShop) rollDraft(st, p); // entering mid-shop → roll an offer so their draft UI isn't empty
  }

  /** Deploy: the host's fresh game state exists now — spawn a player for each connected peer. */
  start(): void {
    this.started = true;
    for (const peer of this.peers) {
      if (peer.open && peer.decided) this.spawnFresh(peer.pid);
    }
  }

  /** Remove held bodies whose grace window has elapsed (called each host tick). */
  tickGrace(now: number): void {
    if (!this.started) return;
    const st = getState();
    const grace = CONFIG.net.reconnect.graceMs;
    let removed = false;
    for (const peer of [...this.peers]) {
      if (peer.open || !peer.decided || peer.goneAt === 0) continue;
      if (now - peer.goneAt > grace) {
        removePlayer(st, peer.pid);
        this.peers = this.peers.filter((x) => x !== peer);
        removed = true;
      }
    }
    if (removed) this.notifyRoster(); // a held slot finally freed → registry/squad refresh
  }

  /** How many peers are currently connected (for the lobby squad display). */
  get connected(): number {
    return this.peers.filter((p) => p.open).length;
  }

  /** pids of currently-connected, decided peers (for the lobby squad badges). */
  connectedPids(): number[] {
    return this.peers.filter((p) => p.open && p.decided).map((p) => p.pid);
  }

  /** Client pids holding a slot — every decided peer, whether currently open or held absent for
   *  reconnect. This is the exact set pickSlot treats as occupied, so the cap and the advertised
   *  count share one definition. */
  private decidedPids(): number[] {
    return this.peers.filter((p) => p.decided).map((p) => p.pid);
  }

  /** Authoritative headcount for the public registry: occupied client slots (incl. held-absent
   *  ghosts mid-reconnect) + the host. Mirrors pickSlot's occupancy, so a full room is never
   *  advertised as joinable. (connectedPids() is the lobby badge set — who's present right now.) */
  playerCount(): number {
    return this.decidedPids().length + 1;
  }

  /** ?netlog test hook: stop broadcasting for `ms` to force a client snapshot-starvation reconnect. */
  pauseBroadcast(ms: number): void {
    this.broadcastPausedUntil = performance.now() + ms;
  }

  /** Broadcast the current world to all peers (called at CONFIG.net.sendHz after start). */
  broadcast(tick: number): void {
    if (this.links.length === 0) return;
    if (performance.now() < this.broadcastPausedUntil) return;
    const buf = encodeSnapshot(getState(), tick);
    for (const l of this.links) l.sendSnap(buf);
  }

  /** Tell every client the run ended so they bank their salvage share + show the debrief. */
  broadcastGameOver(salvage: number, day: number, kills: number, money: number): void {
    const msg: NetMsg = { t: "gameover", salvage, day, kills, money };
    for (const l of this.links) l.sendRel(msg);
  }
}
