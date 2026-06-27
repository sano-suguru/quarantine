import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { newState } from "../state";
import type { Player, State } from "../types";
import { PICKUP_TYPES } from "./pickups";
import { WEAPONS } from "./weapons";

function setup(): { s: State; p: Player } {
  const s = newState();
  return { s, p: s.players[0] as Player };
}

describe("PICKUP_TYPES.apply", () => {
  it("ammo: tops off the held gun's reserve by mag * ammoMagMul, clamped to its cap", () => {
    const { s, p } = setup();
    p.weapon = "pistol";
    p.reserve.pistol = 0;
    const pistol = WEAPONS.pistol;
    if (!pistol) throw new Error("no pistol");
    PICKUP_TYPES.ammo?.apply(s, p);
    const add = Math.round(pistol.mag * CONFIG.ammo.ammoMagMul);
    expect(p.reserve.pistol).toBe(add);

    // clamps to round(reserveMax * reserveMul)
    const cap = Math.round(pistol.reserveMax * s.reserveMul);
    p.reserve.pistol = cap - 1;
    PICKUP_TYPES.ammo?.apply(s, p);
    expect(p.reserve.pistol).toBe(cap);
  });

  it("ammo: resupplies the pistol when a melee weapon is equipped (never wasted)", () => {
    const { s, p } = setup();
    p.weapon = "knife"; // melee
    p.reserve.pistol = 0;
    PICKUP_TYPES.ammo?.apply(s, p);
    expect(p.reserve.pistol).toBeGreaterThan(0);
  });

  it("health: grants one carried medkit, clamped to the max", () => {
    const { s, p } = setup();
    p.medkits = 0;
    PICKUP_TYPES.health?.apply(s, p);
    expect(p.medkits).toBe(1);

    p.medkits = CONFIG.heal.maxMedkits;
    PICKUP_TYPES.health?.apply(s, p);
    expect(p.medkits).toBe(CONFIG.heal.maxMedkits);
  });

  it("battery: refills to full, clamped to batteryMax", () => {
    const { s, p } = setup();
    p.battery = 10;
    PICKUP_TYPES.battery?.apply(s, p);
    expect(p.battery).toBe(CONFIG.flashlight.batteryMax);
  });
});
