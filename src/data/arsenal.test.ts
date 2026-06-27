import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { newState } from "../state";
import type { State } from "../types";
import { effWeapon, levelCost, salvageEarned, scaledDmg, scaledMag } from "./arsenal";
import { WEAPONS } from "./weapons";

describe("weapon level scaling", () => {
  it("is the base value at level 0", () => {
    expect(scaledDmg(20, 0)).toBe(20);
    expect(scaledMag(30, 0)).toBe(30);
  });

  it("adds the per-level damage fraction", () => {
    // +15%/level by default
    expect(scaledDmg(20, 2)).toBeCloseTo(20 * (1 + 2 * CONFIG.arsenal.dmgPerLevel));
  });

  it("rounds magazine to a whole number", () => {
    // 30 * (1 + 0.2) = 36
    expect(scaledMag(30, 1)).toBe(36);
    expect(Number.isInteger(scaledMag(7, 1))).toBe(true);
  });

  it("level cost rises by the step each level", () => {
    expect(levelCost(1) - levelCost(0)).toBe(CONFIG.arsenal.levelStep);
  });
});

describe("effWeapon preserves moveMul (weapon weight)", () => {
  it("carries the base moveMul at level 0 and through level scaling", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    const baseMul = WEAPONS.lmg?.moveMul ?? 0;
    expect(effWeapon(p, "lmg").moveMul).toBe(baseMul); // lvl 0 → base
    p.wlevel.lmg = 2;
    const eff = effWeapon(p, "lmg");
    expect(eff.moveMul).toBe(baseMul); // weight is not level-scaled (preserved via ...base)
    expect(eff.dmg).toBeGreaterThan(WEAPONS.lmg?.dmg ?? 0); // but dmg is scaled
  });
});

describe("salvage earned per run", () => {
  const a = CONFIG.arsenal;
  it("is zero for a run that earned nothing", () => {
    expect(salvageEarned(0, 0)).toBe(0);
  });
  it("sums day + kill contributions, rounded", () => {
    expect(salvageEarned(3, 20)).toBe(Math.round(3 * a.salvagePerDay + 20 * a.salvagePerKill));
  });
});
