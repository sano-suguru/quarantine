import { describe, expect, it } from "vitest";
import { DEPLOYABLE_TYPES, deployableCount, placeDeployable } from "../data/deployables";
import { newState } from "../state";
import type { State } from "../types";
import { sysDeployables } from "./deployables";
import { spawnZombie } from "./wave";

describe("placeDeployable / deployableCount", () => {
  it("places a deployable and counts it by type", () => {
    const s = newState();
    expect(deployableCount(s, "sentry")).toBe(0);
    placeDeployable(s, "sentry");
    expect(s.deployables).toHaveLength(1);
    expect(deployableCount(s, "sentry")).toBe(1);
    expect(s.deployables[0]?.defId).toBe("sentry");
  });

  it("ignores an unknown defId", () => {
    const s = newState();
    placeDeployable(s, "nope");
    expect(s.deployables).toHaveLength(0);
  });
});

describe("sysDeployables", () => {
  it("turret: fires a bullet at a zombie within range", () => {
    const s = newState();
    placeDeployable(s, "sentry");
    const d = s.deployables[0] as State["deployables"][number];
    // a zombie right next to the turret (well within range)
    spawnZombie(s, "walker", 1, 1);
    const z = s.zombies[0] as State["zombies"][number];
    z.x = d.x + 50;
    z.y = d.y;
    s.bullets = [];
    sysDeployables(s, 0.016); // cd starts at 0 → fires this tick
    expect(s.bullets.length).toBe(1);
    // barrel tracked the target (aim points roughly +x toward the zombie)
    expect(Math.abs(d.aim)).toBeLessThan(0.1);
  });

  it("turret: holds fire with no zombie in range", () => {
    const s = newState();
    placeDeployable(s, "sentry");
    s.zombies = [];
    s.bullets = [];
    sysDeployables(s, 0.016);
    expect(s.bullets.length).toBe(0);
  });

  it("emitter: drops a pickup on its interval", () => {
    const s = newState();
    placeDeployable(s, "ammostation");
    s.pickups = [];
    sysDeployables(s, 0.016); // cd 0 → emits immediately
    expect(s.pickups.length).toBe(1);
    expect(s.pickups[0]?.defId).toBe("ammo");
    // does not emit again until the interval elapses
    sysDeployables(s, 0.016);
    expect(s.pickups.length).toBe(1);
    sysDeployables(s, (DEPLOYABLE_TYPES.ammostation?.interval ?? 8) + 0.1);
    expect(s.pickups.length).toBe(2);
  });
});
