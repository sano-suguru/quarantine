import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG } from "../../sim/config";
import { makePlayer } from "../../sim/engine/players";
import type { State } from "../../sim/types";
import { getState } from "../game";
import { Host, pickSlot } from "./host";
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

describe("Host roster notifications (lobby squad source of truth)", () => {
  it("fires onRoster AFTER a lobby peer is decided, with the peer already present", () => {
    const host = new Host();
    const seen: number[][] = [];
    host.onRoster = () => seen.push(host.connectedPids().sort());
    const link = new FakePeerLink();
    host.add(link);
    link.fireOpen(); // pre-game open → decideFresh → open+decided
    // the callback must observe the NEW roster (the peer is already counted), not a stale one
    expect(seen.at(-1)).toEqual([1]);
  });

  it("fires onRoster AFTER a pre-game drop, with the peer already gone", () => {
    const host = new Host();
    const seen: number[][] = [];
    const link = new FakePeerLink();
    host.add(link);
    link.fireOpen();
    host.onRoster = () => seen.push(host.connectedPids().sort());
    link.fireClose(); // pre-game drop → peer removed
    expect(seen.at(-1)).toEqual([]); // squad refresh sees the emptied roster, not a ghost
  });

  it("fires onRoster on a mid-game drop so the badge shrinks (absent peer uncounted)", () => {
    const host = new Host();
    host.start();
    const link = new FakePeerLink();
    host.add(link);
    link.fireOpen();
    link.recv({ t: "join" });
    const seen: number[][] = [];
    host.onRoster = () => seen.push(host.connectedPids().sort());
    link.fireClose(); // held absent → not connected
    expect(seen.at(-1)).toEqual([]);
  });

  it("fires onRoster when a held body is removed at grace expiry", () => {
    const host = new Host();
    host.start();
    const link = new FakePeerLink();
    host.add(link);
    link.fireOpen();
    link.recv({ t: "join" });
    link.fireClose();
    let fired = 0;
    host.onRoster = () => fired++;
    host.tickGrace(performance.now() + CONFIG.net.reconnect.graceMs + 1000);
    expect(fired).toBeGreaterThan(0);
  });
});

describe("pickSlot", () => {
  it("assigns the lowest free client slot starting at 1", () => {
    expect(pickSlot([])).toEqual({ kind: "assign", pid: 1 });
    expect(pickSlot([1])).toEqual({ kind: "assign", pid: 2 });
    expect(pickSlot([1, 2])).toEqual({ kind: "assign", pid: 3 });
  });

  it("fills the lowest gap, not the next-highest", () => {
    expect(pickSlot([1, 3])).toEqual({ kind: "assign", pid: 2 });
    expect(pickSlot([2, 3])).toEqual({ kind: "assign", pid: 1 });
  });

  it("is full when all three client slots are occupied (held/absent peers still count)", () => {
    expect(pickSlot([1, 2, 3])).toEqual({ kind: "full" });
  });

  it("ignores the host slot (0) and never returns it", () => {
    expect(pickSlot([0])).toEqual({ kind: "assign", pid: 1 });
  });
});

describe("Host room cap", () => {
  it("rejects a 4th client: sends roomfull, assigns no slot, spawns no body", () => {
    const s = getState();
    const host = new Host();
    const links = [new FakePeerLink(), new FakePeerLink(), new FakePeerLink(), new FakePeerLink()];
    for (const l of links) host.add(l);
    for (const l of links) l.fireOpen(); // lobby → decide a slot immediately on open
    host.start(); // Deploy

    expect(host.connectedPids().sort()).toEqual([1, 2, 3]);
    expect(s.players.map((p) => p.id).sort()).toEqual([0, 1, 2, 3]); // host(0) + 3 clients, no 4th
    for (const l of links.slice(0, 3)) {
      expect(l.hello()).toBeTruthy();
      expect(l.sent.some((m) => m.t === "roomfull")).toBe(false);
    }
    expect(links[3]?.hello()).toBeUndefined(); // 4th got no slot
    expect(links[3]?.sent.some((m) => m.t === "roomfull")).toBe(true);
  });

  it("a pre-game drop frees its slot for the next join (no held body before deploy)", () => {
    const host = new Host();
    const [a, b, c] = [new FakePeerLink(), new FakePeerLink(), new FakePeerLink()];
    for (const l of [a, b, c]) {
      host.add(l);
      l.fireOpen();
    }
    expect(host.connectedPids().sort()).toEqual([1, 2, 3]);

    a.fireClose(); // pre-game (host not started) → peer fully removed, slot 1 freed
    const d = new FakePeerLink();
    host.add(d);
    d.fireOpen();
    expect(d.hello()?.localId).toBe(1); // reuses the freed slot
    expect(d.sent.some((m) => m.t === "roomfull")).toBe(false);
  });

  it("a refused peer is untracked at once: dropped from links (no wasted broadcast), uncounted", () => {
    const host = new Host();
    const links = [new FakePeerLink(), new FakePeerLink(), new FakePeerLink(), new FakePeerLink()];
    for (const l of links) host.add(l);
    for (const l of links) l.fireOpen(); // lobby → 1,2,3 assigned; 4th rejected

    const rejected = links[3] as FakePeerLink;
    expect(rejected.sent.some((m) => m.t === "roomfull")).toBe(true);
    expect(host.links.includes(rejected)).toBe(false); // out of the broadcast list immediately
    expect(host.playerCount()).toBe(4); // host + 3 — the refused peer never inflates the count
  });

  it("playerCount holds steady through a mid-game drop so the registry never under-advertises", () => {
    const host = new Host();
    host.start();
    const links = [new FakePeerLink(), new FakePeerLink(), new FakePeerLink()];
    for (const l of links) {
      host.add(l);
      l.fireOpen();
      l.recv({ t: "join" });
    }
    expect(host.playerCount()).toBe(4); // host + 3 clients

    links[0]?.fireClose(); // pid 1 drops mid-game → body held absent within grace
    expect(host.connectedPids()).toHaveLength(2); // only 2 present now (badges shrink)
    expect(host.playerCount()).toBe(4); // but the held slot still counts → room stays "full" to joiners
  });

  it("a held (absent) ghost keeps its slot — a fresh join is refused, the ghost is NOT evicted", () => {
    const s = getState();
    const host = new Host();
    host.start();
    const links = [new FakePeerLink(), new FakePeerLink(), new FakePeerLink()];
    for (const l of links) {
      host.add(l);
      l.fireOpen();
      l.recv({ t: "join" });
    }
    expect(s.players.map((p) => p.id).sort()).toEqual([0, 1, 2, 3]);

    links[0]?.fireClose(); // pid 1 drops mid-game → body held absent, slot reserved within grace
    expect(s.players.find((p) => p.id === 1)?.absent).toBe(true);

    const fresh = new FakePeerLink();
    host.add(fresh);
    fresh.fireOpen();
    fresh.recv({ t: "join" }); // mid-game fresh join while the room is full of (live + ghost)
    expect(fresh.sent.some((m) => m.t === "roomfull")).toBe(true); // ghost protected (feel-first)
    expect(fresh.hello()).toBeUndefined();
  });
});

describe("Host.dispose", () => {
  it("closes every connected link and clears the roster", () => {
    resetState("day");
    const host = new Host();
    const a = new FakePeerLink();
    const b = new FakePeerLink();
    host.add(a);
    host.add(b);
    a.fireOpen();
    b.fireOpen();
    let aClosed = 0;
    let bClosed = 0;
    a.onClose(() => aClosed++);
    b.onClose(() => bClosed++);

    host.dispose();

    expect(aClosed).toBe(1);
    expect(bClosed).toBe(1);
    expect(host.connectedPids()).toEqual([]);
    expect(host.links.length).toBe(0); // links array emptied, not just callbacks fired
  });

  it("tears down a started host with a decided peer without running the normal drop path", () => {
    // Re-entrancy proof: dispose() closes links synchronously, which fires the real Host.onClose.
    // Because peers/links are cleared BEFORE close(), that onClose sees no tracked peer and no-ops —
    // it must NOT run the started+decided "mark absent / remove player" branch. Player state (the
    // shared singleton) is therefore left untouched by the teardown.
    const s = resetState("day");
    const host = new Host();
    const a = new FakePeerLink();
    host.add(a);
    a.fireOpen(); // lobby → decided immediately (pid assigned)
    host.start(); // spawns the decided peer's player into state
    expect(host.connectedPids().length).toBe(1);
    const playersAfterStart = s.players.length;

    host.dispose();

    expect(host.links.length).toBe(0);
    expect(host.connectedPids()).toEqual([]);
    expect(s.players.length).toBe(playersAfterStart); // no re-entrant removal ran
  });

  it("is idempotent — a second dispose is a no-op", () => {
    resetState("day");
    const host = new Host();
    const a = new FakePeerLink();
    host.add(a);
    a.fireOpen();
    let closes = 0;
    a.onClose(() => closes++);

    host.dispose();
    host.dispose();

    expect(closes).toBe(1);
  });

  it("rejects and closes links added after dispose", () => {
    resetState("day");
    const host = new Host();
    host.dispose();
    const late = new FakePeerLink();
    let closed = 0;
    late.onClose(() => closed++);

    host.add(late);

    expect(closed).toBe(1);
    expect(host.connectedPids()).toEqual([]);
  });
});
