// worker/arena.ts
// Authoritative game arena as a Durable Object. Runs the headless sim on a fixed-dt setInterval
// loop and broadcasts binary snapshots to every connected client over one WebSocket each.
// Standard WebSocket API (not Hibernation): the loop is non-hibernatable anyway, and an in-memory
// socket map mirrors the proven room.ts pattern.
import { CONFIG } from "../sim/config";
import { clearFx } from "../sim/events";
import { frameSnap } from "../sim/net/wire";
import { encodeSnapshot } from "../sim/snapshot";
import { newState } from "../sim/state";
import { stepSim } from "../sim/step";
import { startNight } from "../sim/systems/siege";
import type { State } from "../sim/types";

export interface Env {
  ARENA: DurableObjectNamespace;
}

const STEP_MS = 1000 / CONFIG.simHz;
// ticks per broadcast. With CONFIG.net.sendHz=30 this is 2 → 30 Hz broadcast (existing rate).
// The umbrella spec suggested starting ~20 Hz to widen the per-DO message budget margin at 12
// players; if the gate shows inbound+outbound pressure, lower sendHz (or add a net.broadcastHz).
const BROADCAST_EVERY = Math.max(1, Math.round(CONFIG.simHz / CONFIG.net.sendHz));

export class Arena {
  private sockets = new Set<WebSocket>();
  private state: State | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  // metrics (spec §feel gate): effective tick rate + last snapshot size, logged periodically.
  private ticksThisWindow = 0;
  private windowStartMs = 0;
  private lastSnapBytes = 0;

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
      s.heldNight = true;
      s.day = CONFIG.siege.heldNightDay;
      startNight(s); // begin already in the held night (no day→night transition, no banner)
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
    stepSim(s, 1 / CONFIG.simHz); // fixed-dt, one tick one step (no wall-clock accumulator)
    clearFx(s); // 2a: zero fxEvents on the wire — cues are all client-derived
    this.tick++;
    this.ticksThisWindow++;
    if (this.tick % BROADCAST_EVERY === 0) this.broadcast();
    // effective tick-rate log every ~5 s (spec: the 30 Hz-fallback trigger + gate instrument)
    const now = Date.now();
    if (now - this.windowStartMs >= 5000) {
      const hz = (this.ticksThisWindow * 1000) / (now - this.windowStartMs);
      console.log(
        `[arena] effective ${hz.toFixed(1)} Hz · snap ${this.lastSnapBytes} B · clients ${this.sockets.size}`,
      );
      this.ticksThisWindow = 0;
      this.windowStartMs = now;
    }
  }

  private broadcast(): void {
    const s = this.state;
    if (!s || this.sockets.size === 0) return;
    const buf = encodeSnapshot(s, this.tick);
    this.lastSnapBytes = buf.byteLength;
    const framed = frameSnap(buf);
    for (const ws of this.sockets) {
      try {
        ws.send(framed);
      } catch {
        /* socket mid-close — the close handler prunes it */
      }
    }
  }

  private attach(ws: WebSocket): void {
    this.sockets.add(ws);
    this.ensureRunning();
    // Task 7 adds the join/rejoin/input message handling. Skeleton: just keep the socket
    // so it receives broadcasts; drop it on close and stop the loop when empty.
    ws.addEventListener("close", () => this.detach(ws));
    ws.addEventListener("error", () => this.detach(ws));
  }

  private detach(ws: WebSocket): void {
    this.sockets.delete(ws);
    if (this.sockets.size === 0) this.stop();
  }

  private stop(): void {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    this.state = null; // 2a: a fully-empty arena resets (persistence = 2b)
    this.tick = 0;
  }
}
