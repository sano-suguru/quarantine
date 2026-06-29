import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import {
  canPlaceAt,
  DEPLOYABLE_TYPES,
  deployableCount,
  placeDeployable,
  placeSpot,
} from "../data/deployables";
import { len } from "../engine/math";
import { addPlayer } from "../engine/players";
import { newState } from "../state";
import type { Deployable, DeployableDef, State } from "../types";
import { deployDmgScale, deployRetired, reloadRefill, sysDeployables } from "./deployables";
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
    // first drop is scheduled at the next interval grid boundary (placed at t=0 → t=interval)
    expect(station.emitAt).toBe(DEPLOYABLE_TYPES.ammostation?.emitter?.interval);
  });

  it("ignores an unknown defId", () => {
    const s = newState();
    placeDeployable(s, "nope", 0, 0);
    expect(s.deployables).toHaveLength(0);
  });
});

describe("canPlaceAt (pure placement validity)", () => {
  const SENTRY = DEPLOYABLE_TYPES.sentry as DeployableDef; // has a collider body
  const STATION = DEPLOYABLE_TYPES.ammostation as DeployableDef; // bodyless

  it("rejects out-of-bounds for any type", () => {
    const s = newState();
    expect(canPlaceAt(s, CONFIG.arena, 0, SENTRY)).toBe(false);
    expect(canPlaceAt(s, 0, CONFIG.arena, STATION)).toBe(false);
  });

  it("a body type can't overlap a solid wall; a bodyless type ignores walls", () => {
    const s = newState();
    s.walls = [{ x1: 0, y1: -50, x2: 0, y2: 50 }]; // vertical wall through the origin
    s.deployables = [];
    expect(canPlaceAt(s, 0, 0, SENTRY)).toBe(false); // sitting on the wall
    expect(canPlaceAt(s, 100, 0, SENTRY)).toBe(true); // clear of it
    expect(canPlaceAt(s, 0, 0, STATION)).toBe(true); // no body → walls don't matter
  });

  it("a body type can't stack on another body", () => {
    const s = newState();
    s.walls = [];
    s.deployables = [{ id: 1, defId: "sentry", x: 200, y: 0, aim: 0, hpFrac: 1, reloading: false }];
    expect(canPlaceAt(s, 205, 0, SENTRY)).toBe(false); // overlaps the existing sentry (12+12 > 5)
    expect(canPlaceAt(s, 260, 0, SENTRY)).toBe(true); // 60 apart > 24 → clear
  });
});

describe("placeSpot (forward offset with feet fallback)", () => {
  const SENTRY = DEPLOYABLE_TYPES.sentry as DeployableDef;

  it("lands the spot in front of the player along their aim", () => {
    const s = newState();
    s.walls = [];
    s.deployables = [];
    const p = s.players[0] as State["players"][number];
    p.x = 0;
    p.y = 0;
    p.aim = 0; // facing +x
    const spot = placeSpot(s, p, SENTRY);
    expect(spot).not.toBeNull();
    expect((spot as { x: number }).x).toBeGreaterThan(0);
    expect(Math.abs((spot as { y: number }).y)).toBeLessThan(1);
  });

  it("steps back toward the feet when the forward spot is blocked by a wall", () => {
    const s = newState();
    s.deployables = [];
    const p = s.players[0] as State["players"][number];
    p.x = 0;
    p.y = 0;
    p.aim = 0;
    s.walls = [{ x1: 25, y1: -50, x2: 25, y2: 50 }]; // wall just ahead blocks the full offset (~34)
    const spot = placeSpot(s, p, SENTRY);
    expect(spot).not.toBeNull();
    expect((spot as { x: number }).x).toBeLessThan(34); // fell back to a closer clear spot
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

describe("sysDeployables — emitter (drops on the absolute state.time grid, in sync with the beacon)", () => {
  it("schedules the first drop at the next grid boundary, then every interval — not on placement", () => {
    const s = newState();
    const interval = DEPLOYABLE_TYPES.ammostation?.emitter?.interval ?? 8;
    s.time = 2.5; // placed mid-cycle
    const st = place(s, "ammostation");
    s.pickups = [];
    // the beacon resets on absolute grid boundaries (state.time % interval); the first drop
    // is scheduled at the next one (t=interval), NOT immediately on placement.
    expect(st.emitAt).toBe(interval);

    sysDeployables(s, 0.016); // t still 2.5 → before the boundary → no drop
    expect(s.pickups.length).toBe(0);

    s.time = interval; // cross the boundary the beacon resets on
    sysDeployables(s, 0.016);
    expect(s.pickups.length).toBe(1);
    expect(s.pickups[0]?.defId).toBe("ammo");
    expect(st.emitAt).toBe(interval * 2); // advanced one grid step, still aligned

    s.time = interval * 2; // next boundary
    sysDeployables(s, 0.016);
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

describe("sysDeployables — drone orbit-on-watch", () => {
  it("orbits the anchor over time instead of holding a fixed angle behind it", () => {
    const s = newState(); // player 0 at (0,0)
    s.zombies = [];
    const d = place(s, "drone");
    const p0 = s.players[0] as State["players"][number];
    const hoverDist = DEPLOYABLE_TYPES.drone?.movement?.hoverDist ?? 46;

    // settle at time 0
    for (let i = 0; i < 80; i++) sysDeployables(s, 0.05);
    const r0 = len(d.x - p0.x, d.y - p0.y);
    expect(r0).toBeLessThanOrEqual(hoverDist + 4); // sits on the orbit ring (+ deadzone slack)
    const angle0 = Math.atan2(d.y - p0.y, d.x - p0.x);

    // advance sim time → the orbit angle must sweep (a fixed-angle hover would not move)
    s.time = 3;
    for (let i = 0; i < 80; i++) sysDeployables(s, 0.05);
    const angle1 = Math.atan2(d.y - p0.y, d.x - p0.x);
    const dA = Math.abs(((angle1 - angle0 + Math.PI) % (2 * Math.PI)) - Math.PI);
    expect(dA).toBeGreaterThan(0.3);
  });

  it("releases targetId when the last zombie leaves weapon range (returns to orbit)", () => {
    const s = newState();
    s.zombies = [];
    const d = place(s, "drone");
    d.x = 0;
    d.y = 0;
    const z = zombieAt(s, 100, 0, 1e9); // inside drone weapon range (320)
    sysDeployables(s, 0.016);
    expect(d.targetId).toBe(z.id); // acquired

    z.x = 5000; // alive but far outside weapon range
    sysDeployables(s, 0.016); // tickWeapon must clear the stale target
    expect(d.targetId).toBeUndefined();
  });
});

describe("deployDmgScale", () => {
  it("scales with the night number at night (matches enemy hpScale)", () => {
    expect(deployDmgScale("night", 1, 0.1)).toBeCloseTo(1.1);
    expect(deployDmgScale("night", 5, 0.1)).toBeCloseTo(1.5);
    expect(deployDmgScale("night", 10, 0.1)).toBeCloseTo(2.0);
  });
  it("does NOT scale during the day (roamers are base HP)", () => {
    expect(deployDmgScale("day", 1, 0.1)).toBe(1);
    expect(deployDmgScale("day", 10, 0.1)).toBe(1);
  });
});

describe("reloadRefill", () => {
  it("refills a full magazine when the reserve covers it", () => {
    expect(reloadRefill(90, 24)).toBe(24);
  });
  it("refills only the remaining reserve on the last (partial) magazine", () => {
    expect(reloadRefill(10, 24)).toBe(10);
  });
  it("refills nothing when the reserve is empty", () => {
    expect(reloadRefill(0, 24)).toBe(0);
    expect(reloadRefill(-5, 24)).toBe(0);
  });
});

describe("deployRetired", () => {
  it("retires a budgeted unit only when reserve AND magazine are empty", () => {
    expect(deployRetired(true, 0, 0)).toBe(true);
    expect(deployRetired(true, 0, 3)).toBe(false); // still has rounds in the mag
    expect(deployRetired(true, 5, 0)).toBe(false); // still has reserve to reload
  });
  it("never retires an infinite-reserve unit (the sentry)", () => {
    expect(deployRetired(false, 0, 0)).toBe(false);
  });
});
