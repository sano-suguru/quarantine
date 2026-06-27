import { describe, expect, it } from "vitest";
import { DEPLOYABLE_TYPES, deployableCount, placeDeployable } from "../data/deployables";
import { len } from "../engine/math";
import { addPlayer } from "../engine/players";
import { newState } from "../state";
import type { Deployable, State } from "../types";
import { sysDeployables } from "./deployables";
import { spawnZombie } from "./wave";

/** Spawn a zombie and force it to an exact position (spawnZombie itself uses RNG placement). */
function zombieAt(s: State, x: number, y: number, hp = 50): State["zombies"][number] {
  spawnZombie(s, "walker", 1, 1);
  const z = s.zombies[s.zombies.length - 1] as State["zombies"][number];
  z.x = x;
  z.y = y;
  z.hp = hp;
  return z;
}

function place(s: State, defId: string): Deployable {
  placeDeployable(s, defId, 0, 0);
  return s.deployables[s.deployables.length - 1] as Deployable;
}

describe("placeDeployable / deployableCount", () => {
  it("places a deployable and counts it by type", () => {
    const s = newState();
    expect(deployableCount(s, "sentry")).toBe(0);
    placeDeployable(s, "sentry", 0, 0);
    expect(s.deployables).toHaveLength(1);
    expect(deployableCount(s, "sentry")).toBe(1);
    expect(s.deployables[0]?.defId).toBe("sentry");
  });

  it("initialises capability state (weapon magazine / destructible hp / display defaults)", () => {
    const s = newState();
    const sentry = place(s, "sentry");
    expect(sentry.ammoLeft).toBe(DEPLOYABLE_TYPES.sentry?.weapon?.magSize);
    expect(sentry.hp).toBe(DEPLOYABLE_TYPES.sentry?.destructible?.maxHp);
    expect(sentry.hpFrac).toBe(1);
    expect(sentry.reloading).toBe(false);
    const station = place(s, "ammostation");
    expect(station.hp).toBeUndefined(); // emitter is indestructible
    expect(station.emitCd).toBe(0);
  });

  it("ignores an unknown defId", () => {
    const s = newState();
    placeDeployable(s, "nope", 0, 0);
    expect(s.deployables).toHaveLength(0);
  });
});

describe("sysDeployables — weapon (refactor equivalence + magazine)", () => {
  it("turret fires a bullet at a zombie within range and tracks the barrel", () => {
    const s = newState();
    const d = place(s, "sentry");
    const z = zombieAt(s, d.x + 50, d.y);
    expect(z).toBeDefined();
    s.bullets = [];
    sysDeployables(s, 0.016); // weaponCd starts at 0 → fires this tick
    expect(s.bullets.length).toBe(1);
    expect(Math.abs(d.aim)).toBeLessThan(0.1); // aimed roughly +x toward the zombie
  });

  it("turret holds fire with no zombie in range", () => {
    const s = newState();
    place(s, "sentry");
    s.zombies = [];
    s.bullets = [];
    sysDeployables(s, 0.016);
    expect(s.bullets.length).toBe(0);
  });

  it("magazine: empties, holds fire while reloading, then fires immediately on refill", () => {
    const s = newState();
    const d = place(s, "sentry");
    zombieAt(s, d.x + 50, d.y, 1e9); // huge hp so it survives (sysBullets isn't run here)
    const reload = DEPLOYABLE_TYPES.sentry?.weapon?.reloadTime ?? 0;
    d.ammoLeft = 1;
    d.weaponCd = 0;
    s.bullets = [];

    sysDeployables(s, 0.016); // fires the last round
    expect(s.bullets.length).toBe(1);
    expect(d.ammoLeft).toBe(0);
    expect(d.reloadT).toBeGreaterThan(0);
    expect(d.reloading).toBe(true);

    sysDeployables(s, 0.1); // mid-reload: no fire
    expect(s.bullets.length).toBe(1);

    sysDeployables(s, reload); // reload completes → immediate fire on the same tick
    expect(s.bullets.length).toBe(2);
    expect(d.reloading).toBe(false);
    expect(d.ammoLeft).toBe((DEPLOYABLE_TYPES.sentry?.weapon?.magSize ?? 0) - 1);
  });
});

describe("sysDeployables — emitter (refactor equivalence)", () => {
  it("drops a pickup on its interval", () => {
    const s = newState();
    place(s, "ammostation");
    s.pickups = [];
    sysDeployables(s, 0.016); // emitCd 0 → emits immediately
    expect(s.pickups.length).toBe(1);
    expect(s.pickups[0]?.defId).toBe("ammo");
    sysDeployables(s, 0.016); // not yet
    expect(s.pickups.length).toBe(1);
    sysDeployables(s, (DEPLOYABLE_TYPES.ammostation?.emitter?.interval ?? 8) + 0.1);
    expect(s.pickups.length).toBe(2);
  });
});

describe("sysDeployables — destruction", () => {
  it("takes contact damage and is removed at hp<=0; indestructible types survive", () => {
    const s = newState();
    s.zombies = [];
    const sentry = place(s, "sentry");
    const station = place(s, "ammostation");
    zombieAt(s, sentry.x, sentry.y, 1e9); // overlapping the sentry, unkillable by its bullets
    for (let i = 0; i < 300 && deployableCount(s, "sentry") > 0; i++) sysDeployables(s, 0.1);
    expect(deployableCount(s, "sentry")).toBe(0); // destroyed
    expect(deployableCount(s, "ammostation")).toBe(1); // emitter has no destructible block
    expect(station.hpFrac).toBe(1);
  });

  it("does not lose hp without an adjacent zombie", () => {
    const s = newState();
    s.zombies = [];
    const d = place(s, "sentry");
    sysDeployables(s, 1);
    expect(d.hp).toBe(DEPLOYABLE_TYPES.sentry?.destructible?.maxHp);
  });
});

describe("sysDeployables — drone movement & anchor", () => {
  it("leashes within leashMax of its anchor", () => {
    const s = newState(); // player 0 at (0,0)
    s.zombies = [];
    const d = place(s, "drone");
    d.x = 600;
    d.y = 600; // start far away
    const leashMax = DEPLOYABLE_TYPES.drone?.movement?.leashMax ?? 160;
    for (let i = 0; i < 400; i++) sysDeployables(s, 0.05);
    const p0 = s.players[0] as State["players"][number];
    expect(len(d.x - p0.x, d.y - p0.y)).toBeLessThanOrEqual(leashMax + 1);
  });

  it("anchor selection is sticky within switchMargin and re-resolves when the anchor leaves", () => {
    const s = newState(); // player 0 at (0,0)
    s.zombies = [];
    const p1 = addPlayer(s, 1, 140, 0);
    const d = place(s, "drone");

    const reset = () => {
      d.x = 0;
      d.y = 0;
      d.anchorId = 0;
    };
    // p1 farther than p0 → stays on p0
    reset();
    sysDeployables(s, 0.001);
    expect(d.anchorId).toBe(0);
    // p1 closer but within switchMargin (100-50 < 80) → stays on p0
    reset();
    p1.x = 50;
    (s.players[0] as State["players"][number]).x = 100;
    sysDeployables(s, 0.001);
    expect(d.anchorId).toBe(0);
    // p1 much closer (100-10 > 80) → switches to p1
    reset();
    p1.x = 10;
    sysDeployables(s, 0.001);
    expect(d.anchorId).toBe(1);
    // anchor dies → re-resolve to the only alive player
    reset();
    (s.players[0] as State["players"][number]).hp = 0;
    sysDeployables(s, 0.001);
    expect(d.anchorId).toBe(1);
    // anchor goes absent → re-resolve
    (s.players[0] as State["players"][number]).hp = 100;
    d.anchorId = 1;
    p1.absent = true;
    sysDeployables(s, 0.001);
    expect(d.anchorId).toBe(0);
  });

  it("holds position and does not throw when no player can anchor it", () => {
    const s = newState();
    s.zombies = [];
    (s.players[0] as State["players"][number]).hp = 0;
    const d = place(s, "drone");
    d.x = 300;
    d.y = 0;
    expect(() => sysDeployables(s, 0.05)).not.toThrow();
    expect(d.x).toBe(300);
    expect(d.y).toBe(0);
  });
});

describe("sysDeployables — target hysteresis & invalidation", () => {
  it("keeps the current target unless another is >15% closer, and survives target death", () => {
    const s = newState(); // anchor at origin
    s.zombies = [];
    const d = place(s, "drone");
    d.x = 0;
    d.y = 0;
    const a = zombieAt(s, 100, 0, 1e9);
    const b = zombieAt(s, 90, 0, 1e9);
    d.targetId = a.id;
    sysDeployables(s, 0.001); // b at 90 is not < 85 → keep a
    expect(d.targetId).toBe(a.id);

    b.x = 80; // now < 85 → switch to b
    d.x = 0;
    d.y = 0;
    sysDeployables(s, 0.001);
    expect(d.targetId).toBe(b.id);

    // target dies (removed from the array) → re-acquire without throwing
    s.zombies = s.zombies.filter((z) => z.id !== d.targetId);
    d.x = 0;
    d.y = 0;
    expect(() => sysDeployables(s, 0.001)).not.toThrow();
    expect(d.targetId).toBe(a.id);
  });
});

describe("sysDeployables — composition smoke", () => {
  it("a drone (weapon+movement+destructible) moves, fires, and takes damage in one tick set", () => {
    const s = newState();
    s.zombies = [];
    const d = place(s, "drone");
    d.x = 0;
    d.y = 0;
    zombieAt(s, 30, 0, 1e9); // in weapon range and within contact radius
    s.bullets = [];
    const hp0 = d.hp ?? 0;
    for (let i = 0; i < 5; i++) sysDeployables(s, 0.016);
    expect(s.bullets.length).toBeGreaterThan(0); // fired
    expect(d.hp).toBeLessThan(hp0); // took contact damage
  });
});
