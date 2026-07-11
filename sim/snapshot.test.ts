import { describe, expect, it } from "vitest";
import { CONFIG } from "./config";
import { CARD_ORDER } from "./data/arsenal";
import { DEPLOYABLE_TYPES } from "./data/deployables";
import { addPlayer } from "./engine/players";
import { applySnapshot, captureSnapshot, decode, encode, lerpSnapshots } from "./snapshot";
import { allocId, newState } from "./state";
import { spawnPickup } from "./systems/pickups";
import { spawnZombie } from "./systems/wave";
import type { Bullet, State } from "./types";

/** A populated world: 2 players, a few zombies, a bullet, a pickup, damage + search progress. */
function populated(): State {
  const s = newState();
  s.phase = "night";
  (s.players[0] as State["players"][number]).money = 137; // per-player wallet
  (s.players[0] as State["players"][number]).deployQueue = ["sentry", "ammostation", "sentry"];
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
    expect(back.players.find((p) => p.id === 0)?.money).toBe(137); // per-player wallet
    // bought-but-unplaced deployable queue survives as DEPLOYABLE_ORDER indices, order preserved
    expect(back.players.find((p) => p.id === 0)?.deployQueue).toEqual([1, 0, 1]);
    expect(back.players.find((p) => p.id === 1)?.deployQueue).toEqual([]);
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

    // absent flag (packed into the player flag byte) survives the round-trip,
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
    // A fully deterministic snapshot (no RNG / zombies): newState() + fixed scalars + 2 players +
    // one deployable (so the per-deployable byte layout is hashed too — without it a per-deployable
    // format change like `ammoFrac` slips past this guard). If the wire layout changes the hash
    // drifts and this test fails — a forcing function so a `snapshot.ts` format change is paired
    // with a conscious PROTOCOL_VERSION bump in net.ts (silent desync is the failure mode we guard).
    const s = newState();
    s.phase = "night";
    s.day = 3;
    (s.players[0] as State["players"][number]).money = 200; // per-player wallet
    s.kills = 5;
    addPlayer(s, 1, 120, -80);
    const p1 = s.players[1] as State["players"][number];
    p1.hp = 50;
    p1.absent = true;
    s.deployables.push({
      id: 42,
      defId: "drone",
      x: 64,
      y: -32,
      aim: 1,
      hpFrac: 0.5,
      reloading: true,
      ammoFrac: 0.5,
    });
    const bytes = new Uint8Array(encode(captureSnapshot(s, 100)));
    let h = 0x811c9dc5; // FNV-1a over the bytes
    for (const b of bytes) {
      h ^= b;
      h = Math.imul(h, 0x01000193);
    }
    // +1 byte vs the pre-stalker golden: the stalker block always writes a presence byte (0 for null).
    // If this drifts again, bump PROTOCOL_VERSION in net.ts and regenerate here.
    expect(`len=${bytes.length} fnv=${(h >>> 0).toString(16)}`).toMatchInlineSnapshot(
      `"len=304 fnv=443aad37"`,
    );
  });

  it("round-trips placed deployables (id, type, position, aim, hp/reload status byte)", () => {
    const s = newState();
    s.deployables.push({
      id: 77,
      defId: "sentry",
      x: 120,
      y: -64,
      aim: 1.2,
      hpFrac: 0.5,
      reloading: true,
    });
    s.deployables.push({
      id: 78,
      defId: "ammostation",
      x: -40,
      y: 200,
      aim: 0,
      hpFrac: 1,
      reloading: false,
    });
    s.deployables.push({
      id: 79,
      defId: "drone",
      x: 0,
      y: 0,
      aim: 0,
      hpFrac: 1,
      reloading: false,
      ammoFrac: 0.5,
    });
    const back = decode(encode(captureSnapshot(s, 9)));
    expect(back.deployables).toHaveLength(3);
    const sentry = back.deployables.find((d) => d.id === 77);
    expect(sentry?.defId).toBe("sentry");
    expect(Math.abs((sentry?.x ?? 0) - 120)).toBeLessThanOrEqual(POS_TOL);
    expect(Math.abs((sentry?.y ?? 0) - -64)).toBeLessThanOrEqual(POS_TOL);
    expect(sentry?.aim ?? 0).toBeCloseTo(1.2, 1); // byte-quantized over TAU
    expect(sentry?.hpFrac ?? 0).toBeCloseTo(0.5, 2); // 7-bit quantized
    expect(sentry?.reloading).toBe(true);
    const station = back.deployables.find((d) => d.id === 78);
    expect(station?.defId).toBe("ammostation");
    expect(station?.hpFrac).toBeCloseTo(1, 2);
    expect(station?.reloading).toBe(false);
    const drone = back.deployables.find((d) => d.id === 79);
    expect(drone?.ammoFrac ?? 0).toBeCloseTo(0.5, 2); // 1-byte quantized
  });

  it("round-trips switchT (u8-quantized) through encode/decode", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    p.switchT = 0.4;
    const snap = decode(encode(captureSnapshot(s, 100)));
    // u8 over MAX_DRAWTIME (0.8): step ≈ 0.003, so 2-dp closeness is comfortable
    expect(snap.players[0]?.switchT).toBeCloseTo(0.4, 2);
  });

  it("round-trips draft offer fields incl. partial free-pick count", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    p.draftOffer = ["perk:hollowPoints", "lvl:pistol"];
    p.draftFreePicksUsed = 2; // a value the old 1-bit projection could not carry
    p.draftRerolls = 2;
    const back = decode(encode(captureSnapshot(s, 1)));
    const bp = back.players[0];
    if (!bp) throw new Error("decoded snapshot is missing player 0");
    expect(bp.draftOffer.map((i) => CARD_ORDER[i])).toEqual(["perk:hollowPoints", "lvl:pistol"]);
    expect(bp.draftFreePicksUsed).toBe(2);
    expect(bp.draftRerolls).toBe(2);
  });

  it("stays under the 16KB SCTP message limit for a heavy night", () => {
    const s = newState();
    for (let i = 0; i < 60; i++) spawnZombie(s, "walker", 1, 1);
    const buf = encode(captureSnapshot(s, 1));
    expect(buf.byteLength).toBeLessThan(16 * 1024);
  });

  it("stalker present: round-trips x/y/face/state; stalker absent: round-trips as not-present", () => {
    // Present stalker: encode → decode must reconstruct all fields within quantization tolerance
    const sPresent = newState();
    sPresent.stalker = {
      x: 123,
      y: -456,
      face: 1.2,
      state: "aggro",
      staggerT: 0,
      contactCd: 0.3,
      vis: 0.7,
    };
    const backPresent = decode(encode(captureSnapshot(sPresent, 7)));
    expect(backPresent.stalker.present).toBe(true);
    expect(Math.abs(backPresent.stalker.x - 123)).toBeLessThanOrEqual(POS_TOL);
    expect(Math.abs(backPresent.stalker.y - -456)).toBeLessThanOrEqual(POS_TOL);
    // face is byte-quantized over TAU: step ≈ 0.025 rad, allow 0.1
    expect(Math.abs(backPresent.stalker.face - 1.2)).toBeLessThanOrEqual(0.1);
    // state: 0=lull, 1=aggro, 2=stagger, 3=retreat
    expect(backPresent.stalker.state).toBe(1); // "aggro" → 1

    // Absent stalker: encode → decode must produce present=false
    const sAbsent = newState();
    expect(sAbsent.stalker).toBeNull();
    const backAbsent = decode(encode(captureSnapshot(sAbsent, 8)));
    expect(backAbsent.stalker.present).toBe(false);

    // vis round-trip: u8-quantized (step ~0.004); allow 0.01 tolerance
    expect(backPresent.stalker.vis).toBeCloseTo(0.7, 1);
    // contactCd round-trip: u8-quantized over CONFIG.stalker.contactCd (1.5); step ~0.006, allow 0.02
    expect(Math.abs(backPresent.stalker.contactCd - 0.3)).toBeLessThanOrEqual(0.02);

    // Byte-delta confirmation: absent stalker = +1 presence byte vs a snapshot with no stalker block.
    // (The test that verifies this is the golden above: len went 303→304 for the null case.)
    const lenAbsent = encode(captureSnapshot(sAbsent, 1)).byteLength;
    const lenPresent = encode(captureSnapshot(sPresent, 1)).byteLength;
    // present adds 8 more bytes (i16 x + i16 y + u8 face + u8 state + u8 vis + u8 contactCd = 2+2+1+1+1+1)
    expect(lenPresent - lenAbsent).toBe(8);
  });

  it("round-trips searching / swingT / swingKind", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    p.searching = true;
    p.swingT = CONFIG.actionFeel.swingDecay * 0.6;
    p.swingKind = "mateHeal";
    const out = decode(encode(captureSnapshot(s, 1)));
    const rp = out.players[0] as (typeof out.players)[number];
    expect(rp.searching).toBe(true);
    expect(rp.swingKind).toBe("mateHeal");
    expect(rp.swingT).toBeCloseTo(CONFIG.actionFeel.swingDecay * 0.6, 1);
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
    expect(client.players.find((p) => p.id === 0)?.money).toBe(137); // per-player wallet
    // queue indices are decoded back to defId strings on the client
    expect(client.players.find((p) => p.id === 0)?.deployQueue).toEqual([
      "sentry",
      "ammostation",
      "sentry",
    ]);
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

describe("deployable wire contract & interpolation", () => {
  it("DEPLOYABLE_ORDER (Object.keys) index is append-only stable", () => {
    // The key declaration order IS the snapshot defId wire index. Reordering desyncs silently
    // (the golden uses zero deployables, so it can't catch this) — pin it here.
    const order = Object.keys(DEPLOYABLE_TYPES);
    expect(order[0]).toBe("ammostation");
    expect(order[1]).toBe("sentry");
    expect(order[2]).toBe("drone");
  });

  it("CARD_ORDER index is append-only stable (perks first, then weapon upgrades)", () => {
    // CARD_ORDER IS the draftOffer wire index. Reordering UPGRADES or WEAPON_ORDER desyncs
    // silently (the golden uses an empty offer, so it can't catch this) — pin the layout here.
    expect(CARD_ORDER[0]).toBe("perk:fieldMedic"); // UPGRADES[0]
    expect(CARD_ORDER[6]).toBe("perk:scavenger"); // last perk (UPGRADES has 7)
    expect(CARD_ORDER[7]).toBe("lvl:pistol"); // first upgradeable weapon (knife is melee → excluded)
    expect(CARD_ORDER.filter((id) => id.startsWith("lvl:"))).not.toContain("lvl:knife");
  });

  it("lerpSnapshots interpolates a moving deployable's position + aim", () => {
    const s = newState();
    s.deployables.push({ id: 9, defId: "drone", x: 0, y: 0, aim: 0, hpFrac: 0.5, reloading: true });
    const a = captureSnapshot(s, 1);
    const d = s.deployables[0] as State["deployables"][number];
    d.x = 100;
    d.y = 40;
    d.aim = 1;
    d.hpFrac = 0.5;
    d.reloading = false;
    const b = captureSnapshot(s, 2);
    const mid = lerpSnapshots(a, b, 0.5);
    const md = mid.deployables.find((x) => x.id === 9);
    expect(md?.x).toBeCloseTo(50, 5);
    expect(md?.y).toBeCloseTo(20, 5);
    expect(md?.aim).toBeCloseTo(0.5, 5);
    expect(md?.reloading).toBe(false); // display state takes the latest (b)
  });

  it("lerpSnapshots is a no-op for a static deployable (a==b)", () => {
    const s = newState();
    s.deployables.push({
      id: 3,
      defId: "sentry",
      x: 12,
      y: -8,
      aim: 0.7,
      hpFrac: 1,
      reloading: false,
    });
    const snap = captureSnapshot(s, 1);
    const mid = lerpSnapshots(snap, snap, 0.5);
    const md = mid.deployables.find((x) => x.id === 3);
    expect(md?.x).toBeCloseTo(12, 5);
    expect(md?.y).toBeCloseTo(-8, 5);
    expect(md?.aim).toBeCloseTo(0.7, 5);
  });
});
