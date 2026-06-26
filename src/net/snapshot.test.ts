import { describe, expect, it } from "vitest";
import { addPlayer } from "../engine/players";
import { allocId } from "../state";
import { newState } from "../state";
import { spawnPickup } from "../systems/pickups";
import { spawnZombie } from "../systems/wave";
import type { Bullet, State } from "../types";
import { applySnapshot, captureSnapshot, decode, encode } from "./snapshot";

/** A populated world: 2 players, a few zombies, a bullet, a pickup, damage + search progress. */
function populated(): State {
  const s = newState();
  s.phase = "night";
  s.money = 137;
  s.kills = 9;
  addPlayer(s, 1, 250, -120);
  (s.players[1] as State["players"][number]).hp = 64;
  (s.players[1] as State["players"][number]).absent = true; // disconnected, body held (P4)
  spawnZombie(s, "walker", 1, 1);
  spawnZombie(s, "runner", 1.5, 1.2);
  spawnZombie(s, "brute", 2, 1);
  const b: Bullet = {
    id: allocId(s),
    x: 40,
    y: -10,
    px: 32,
    py: -12,
    vx: 800,
    vy: 0,
    r: 4,
    dmg: 12,
    life: 1,
    pierce: 0,
    knockback: 5,
    color: [1, 0.8, 0.3],
  };
  s.bullets.push(b);
  spawnPickup(s, 100, 100, "ammo");
  (s.barricades[0] as State["barricades"][number]).hp = 73;
  (s.barricades[0] as State["barricades"][number]).flash = 0.06;
  (s.caches[0] as State["caches"][number]).searchT = 0.9;
  return s;
}

const POS_TOL = 0.5; // int16 quantization is ~0.05px; allow 0.5px

describe("snapshot binary round-trip", () => {
  it("encode → decode preserves scalars, counts, and quantized positions", () => {
    const s = populated();
    const snap = captureSnapshot(s, 42);
    const back = decode(encode(snap));

    expect(back.tick).toBe(42);
    expect(back.phase).toBe("night");
    expect(back.isFull).toBe(true);
    expect(back.money).toBe(137);
    expect(back.kills).toBe(9);
    expect(back.day).toBe(snap.day);
    expect(back.players).toHaveLength(2);
    expect(back.zombies).toHaveLength(3);
    expect(back.bullets).toHaveLength(1);
    expect(back.pickups).toHaveLength(1);

    // player floats survive (kept full precision)
    expect(back.players[1]?.id).toBe(1);
    expect(back.players[1]?.hp).toBeCloseTo(64, 5);
    expect(back.players[1]?.x).toBeCloseTo(250, 3);

    // absent flag (packed into the player flag byte alongside lightOn) survives the round-trip,
    // and the byte-packing doesn't bleed into the neighbouring player
    expect(back.players[1]?.absent).toBe(true);
    expect(back.players[0]?.absent).toBe(false);

    // zombie positions within quantization tolerance, ids + type intact
    for (const a of snap.zombies) {
      const z = back.zombies.find((q) => q.id === a.id);
      expect(z).toBeTruthy();
      if (!z) continue;
      expect(z.type).toBe(a.type);
      expect(Math.abs(z.x - a.x)).toBeLessThanOrEqual(POS_TOL);
      expect(Math.abs(z.y - a.y)).toBeLessThanOrEqual(POS_TOL);
      expect(Math.abs(z.hp - a.hp)).toBeLessThanOrEqual(1);
    }

    // bullet endpoints + color
    expect(Math.abs((back.bullets[0]?.px ?? 0) - 32)).toBeLessThanOrEqual(POS_TOL);
    expect(back.bullets[0]?.color[0]).toBeCloseTo(1, 1);

    // barricade / cache index sync
    expect(back.barricades[0]?.hp).toBeCloseTo(73, 3);
    expect(back.caches[0]?.searchT).toBeGreaterThan(0);
  });

  it("golden: encoded byte layout is stable (bump PROTOCOL_VERSION if this changes)", () => {
    // A fully deterministic snapshot (no RNG / zombies): newState() + fixed scalars + 2 players.
    // The encoded bytes are hashed; if the wire layout changes the hash drifts and this test fails
    // — a forcing function so a `snapshot.ts` format change is paired with a conscious
    // PROTOCOL_VERSION bump in net.ts (silent desync is the failure mode we're guarding against).
    const s = newState();
    s.phase = "night";
    s.day = 3;
    s.money = 200;
    s.kills = 5;
    addPlayer(s, 1, 120, -80);
    const p1 = s.players[1] as State["players"][number];
    p1.hp = 50;
    p1.absent = true;
    const bytes = new Uint8Array(encode(captureSnapshot(s, 100)));
    let h = 0x811c9dc5; // FNV-1a over the bytes
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 0x01000193);
    }
    expect(`len=${bytes.length} fnv=${(h >>> 0).toString(16)}`).toMatchInlineSnapshot(
      `"len=248 fnv=d2e62e"`,
    );
  });

  it("stays under the 16KB SCTP message limit for a heavy night", () => {
    const s = newState();
    for (let i = 0; i < 60; i++) spawnZombie(s, "walker", 1, 1);
    const buf = encode(captureSnapshot(s, 1));
    expect(buf.byteLength).toBeLessThan(16 * 1024);
  });
});

describe("applySnapshot (id-matched apply to a client state)", () => {
  it("reconstructs players, zombies, pickups onto a fresh state", () => {
    const host = populated();
    const snap = decode(encode(captureSnapshot(host, 7)));

    const client = newState(); // starts with 1 player, no zombies
    applySnapshot(client, snap);

    expect(client.players.map((p) => p.id).sort()).toEqual([0, 1]);
    expect(client.zombies).toHaveLength(3);
    expect(client.zombies[0]?.color).toBeTruthy(); // visuals reconstructed from the table
    expect(client.zombies[0]?.r).toBeGreaterThan(0);
    expect(client.pickups).toHaveLength(1);
    expect(client.money).toBe(137);
    expect(client.phase).toBe("night");
  });

  it("matches entities across snapshots: removed ids drop, new ids appear, identity kept", () => {
    const host = populated();
    const client = newState();
    applySnapshot(client, decode(encode(captureSnapshot(host, 1))));
    const keptId = (host.zombies[0] as State["zombies"][number]).id;
    const keptObj = client.zombies.find((z) => z.id === keptId);
    expect(keptObj).toBeTruthy();

    // remove one zombie, add another on the host, re-snapshot
    host.zombies.splice(1, 1);
    spawnZombie(host, "walker", 1, 1);
    applySnapshot(client, decode(encode(captureSnapshot(host, 2))));

    const ids = new Set(client.zombies.map((z) => z.id));
    expect(ids.has(keptId)).toBe(true);
    expect(client.zombies).toHaveLength(3);
    // the surviving zombie kept its object identity (matched by id, not recreated)
    expect(client.zombies.find((z) => z.id === keptId)).toBe(keptObj);
  });

  it("skipLocalId leaves the predicted local player untouched", () => {
    const host = populated();
    const client = newState();
    applySnapshot(client, decode(encode(captureSnapshot(host, 1))));
    const me = client.players.find((p) => p.id === 0) as State["players"][number];
    me.x = 9999; // local prediction moved us
    // host says we're elsewhere, but skipLocalId=0 must not overwrite
    (host.players[0] as State["players"][number]).x = -500;
    applySnapshot(client, decode(encode(captureSnapshot(host, 2))), { skipLocalId: 0 });
    expect(client.players.find((p) => p.id === 0)?.x).toBe(9999);
  });
});
