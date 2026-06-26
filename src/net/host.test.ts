import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { makePlayer } from "../engine/players";
import { getState } from "../game";
import type { State } from "../types";
import { Host } from "./host";
import type { NetMsg } from "./net";
import { emptyInput } from "./playerInput";
import type { PeerLink } from "./transport";

/**
 * Drives the host's reconnect state machine (P4) with a scripted PeerLink — no WebRTC. This
 * covers the deterministic logic the rubber-duck flagged as risky: lazy identity from the
 * first rel, the grace window (a dropped body is held, not removed), rejoin re-attach in place
 * (same pid, no new player), the stale-link membership guard, and grace expiry. It does NOT
 * (cannot) verify the real connection re-establishing or the feel — that's the playtest.
 */
class FakePeerLink implements PeerLink {
  private relCbs: ((o: unknown) => void)[] = [];
  private snapCbs: ((b: ArrayBuffer) => void)[] = [];
  private openCbs: (() => void)[] = [];
  private closeCbs: (() => void)[] = [];
  private closed = false;
  sent: NetMsg[] = [];

  sendSnap(): void {}
  sendRel(o: unknown): void {
    this.sent.push(o as NetMsg);
  }
  onSnap(cb: (b: ArrayBuffer) => void): void {
    this.snapCbs.push(cb);
  }
  onRel(cb: (o: unknown) => void): void {
    this.relCbs.push(cb);
  }
  onOpen(cb: () => void): void {
    this.openCbs.push(cb);
  }
  onClose(cb: () => void): void {
    this.closeCbs.push(cb);
  }
  close(): void {
    this.fireClose();
  }

  // --- test drivers ---
  fireOpen(): void {
    for (const cb of this.openCbs) cb();
  }
  fireClose(): void {
    if (this.closed) return; // mirror the real link's idempotent close
    this.closed = true;
    for (const cb of this.closeCbs) cb();
  }
  recv(m: NetMsg): void {
    for (const cb of this.relCbs) cb(m);
  }
  hello(): Extract<NetMsg, { t: "hello" }> | undefined {
    return [...this.sent]
      .reverse()
      .find((m): m is Extract<NetMsg, { t: "hello" }> => m.t === "hello");
  }
}

/** Reset the shared game-state singleton (the host operates on getState()) to a clean run. */
function resetState(phase: State["phase"] = "day"): State {
  const s = getState();
  s.players.length = 0;
  s.players.push(makePlayer(0, 0, 0)); // host is player 0
  s.localId = 0;
  s.phase = phase;
  s.inShop = false;
  s.running = true;
  return s;
}

beforeEach(() => resetState());

describe("Host identity + spawn", () => {
  it("lobby join then deploy spawns the peer's player", () => {
    const s = getState();
    const host = new Host();
    const link = new FakePeerLink();
    host.add(link);
    link.fireOpen(); // pre-game open → decide a slot immediately, send Hello, don't spawn yet
    expect(link.hello()?.localId).toBe(1);
    expect(s.players.some((p) => p.id === 1)).toBe(false);

    host.start(); // Deploy
    expect(s.players.some((p) => p.id === 1)).toBe(true);
  });

  it("mid-game join spawns only after the client's join first-rel", () => {
    const s = getState();
    const host = new Host();
    host.start(); // running, no peers
    const link = new FakePeerLink();
    host.add(link);
    link.fireOpen();
    expect(s.players.some((p) => p.id === 1)).toBe(false); // waits for the first rel
    link.recv({ t: "join" });
    expect(s.players.some((p) => p.id === 1)).toBe(true);
  });

  it("a mid-night fresh join arrives downed (spectator → dawn revive)", () => {
    resetState("night");
    const s = getState();
    const host = new Host();
    host.start();
    const link = new FakePeerLink();
    host.add(link);
    link.fireOpen();
    link.recv({ t: "join" });
    expect(s.players.find((p) => p.id === 1)?.hp).toBe(0);
  });
});

describe("Host grace + reconnect", () => {
  it("a dropped client's body is held (absent), not removed", () => {
    const s = getState();
    const host = new Host();
    host.start();
    const link = new FakePeerLink();
    host.add(link);
    link.fireOpen();
    link.recv({ t: "join" });

    link.fireClose();
    const body = s.players.find((p) => p.id === 1);
    expect(body).toBeTruthy(); // still present
    expect(body?.absent).toBe(true); // but inert
    host.tickGrace(performance.now()); // within grace → still held
    expect(s.players.some((p) => p.id === 1)).toBe(true);
  });

  it("a rejoin within grace re-attaches the SAME body in place (no respawn)", () => {
    const s = getState();
    const host = new Host();
    host.start();
    const link = new FakePeerLink();
    host.add(link);
    link.fireOpen();
    link.recv({ t: "join" });
    const token = host && link.hello();
    const pid = token?.localId as number;
    const nonce = token?.nonce as string;
    const body = s.players.find((p) => p.id === pid) as State["players"][number];
    body.hp = 37; // gear/hp must be preserved across the re-attach
    body.x = 555;

    link.fireClose();
    expect(body.absent).toBe(true);

    // reconnect: a NEW link claims the same identity
    const link2 = new FakePeerLink();
    host.add(link2);
    link2.fireOpen();
    link2.recv({ t: "rejoin", pid, nonce });

    expect(s.players.filter((p) => p.id === pid)).toHaveLength(1); // no duplicate body
    expect(body.absent).toBe(false); // resumed in place
    expect(body.hp).toBe(37); // preserved
    expect(body.x).toBe(555);
    expect(link2.hello()?.localId).toBe(pid); // same slot
  });

  it("a stale rel on the OLD link after re-attach is ignored (membership guard)", () => {
    const s = getState();
    const host = new Host();
    host.start();
    const link = new FakePeerLink();
    host.add(link);
    link.fireOpen();
    link.recv({ t: "join" });
    const pid = link.hello()?.localId as number;
    const nonce = link.hello()?.nonce as string;
    link.fireClose();

    const link2 = new FakePeerLink();
    host.add(link2);
    link2.fireOpen();
    link2.recv({ t: "rejoin", pid, nonce });
    const body = s.players.find((p) => p.id === pid) as State["players"][number];
    body.x = 111;

    // a late input that was in flight on the dead old link must NOT drive the re-attached body
    link.recv({ t: "input", input: { ...emptyInput(), moveX: 1 }, seq: 9 });
    expect(s.players.find((p) => p.id === pid)).toBe(body); // still one body, untouched identity
  });

  it("past graceMs the held body is removed; a later rejoin becomes a fresh slot", () => {
    const s = getState();
    const host = new Host();
    host.start();
    const link = new FakePeerLink();
    host.add(link);
    link.fireOpen();
    link.recv({ t: "join" });
    const pid = link.hello()?.localId as number;
    const nonce = link.hello()?.nonce as string;
    link.fireClose();

    host.tickGrace(performance.now() + CONFIG.net.reconnect.graceMs + 1000); // expire
    expect(s.players.some((p) => p.id === pid)).toBe(false); // removed

    // the stale token no longer matches → fresh respawn (slot may be reused since it's free)
    const link2 = new FakePeerLink();
    host.add(link2);
    link2.fireOpen();
    link2.recv({ t: "rejoin", pid, nonce });
    expect(s.players.some((p) => p.id === link2.hello()?.localId)).toBe(true);
  });
});
