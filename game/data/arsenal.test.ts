import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { localPlayer } from "../engine/players";
import { newState } from "../state";
import type { State, WeaponDef } from "../types";
import type { StoreItem } from "./arsenal";
import {
  CARD_ORDER,
  cardItem,
  draftPool,
  effWeapon,
  levelCost,
  meleeArc,
  meleeReach,
  rerollCost,
  rollOffer,
  salvageEarned,
  scaledDmg,
  scaledMag,
  storeItems,
} from "./arsenal";
import { isUpgradeableWeapon, WEAPONS } from "./weapons";

const fake = (id: string): StoreItem => ({
  id,
  name: id,
  desc: "",
  price: 0,
  canBuy: () => true,
  buy: () => {},
});

describe("melee accessors", () => {
  const knife = WEAPONS.knife as WeaponDef; // explicit meleeArc 0.95, meleeRange 30
  const bareMelee = { melee: true } as WeaponDef; // omits meleeArc/meleeRange

  it("meleeArc returns the weapon's explicit half-angle", () => {
    expect(meleeArc(knife)).toBe(0.95);
  });
  it("meleeArc falls back to the CONFIG default when omitted", () => {
    expect(meleeArc(bareMelee)).toBe(CONFIG.feel.meleeArcDefault);
  });
  it("meleeReach adds the player radius to the weapon's explicit range", () => {
    expect(meleeReach(knife, 16)).toBe(30 + 16);
  });
  it("meleeReach falls back to the CONFIG default range when omitted", () => {
    expect(meleeReach(bareMelee, 16)).toBe(CONFIG.feel.meleeRangeDefault + 16);
  });
});

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

describe("cardItem", () => {
  it("resolves a starter perk card", () => {
    const s = newState();
    const item = cardItem(s, localPlayer(s), "perk:hollowPoints");
    expect(item?.name).toBe("Hollow Points");
    expect(item?.price).toBe(80);
  });
  it("resolves a weapon upgrade card with the right Mk label and price", () => {
    const s = newState();
    const p = localPlayer(s);
    const item = cardItem(s, p, "lvl:pistol");
    expect(item?.name).toBe("PISTOL ▸ Mk 2");
    expect(item?.price).toBe(60); // levelBaseCost at level 0
  });
  it("returns undefined for a maxed weapon", () => {
    const s = newState();
    const p = localPlayer(s);
    p.wlevel.pistol = 3; // maxLevel
    expect(cardItem(s, p, "lvl:pistol")).toBeUndefined();
  });
  it("returns undefined for an unknown id", () => {
    const s = newState();
    expect(cardItem(s, localPlayer(s), "bogus:x")).toBeUndefined();
  });
  it("CARD_ORDER lists perk then weapon cards, no melee", () => {
    expect(CARD_ORDER).toContain("perk:fieldMedic");
    expect(CARD_ORDER).toContain("lvl:shotgun");
    expect(CARD_ORDER).not.toContain("lvl:knife");
  });
});

describe("draftPool", () => {
  it("fresh save: 3 starter perks + 3 starter weapon upgrades", () => {
    const s = newState(); // owned = pistol/smg/shotgun/knife; unlockedCards = {}
    const ids = draftPool(s, localPlayer(s))
      .map((it) => it.id)
      .sort();
    expect(ids).toEqual([
      "lvl:pistol",
      "lvl:shotgun",
      "lvl:smg",
      "perk:adrenaline",
      "perk:fieldMedic",
      "perk:hollowPoints",
    ]);
  });
  it("unlocked perk card enters the pool", () => {
    const s = newState();
    s.unlockedCards = { "card:scavenger": true };
    expect(draftPool(s, localPlayer(s)).map((it) => it.id)).toContain("perk:scavenger");
  });
  it("maxed weapon drops out of the pool", () => {
    const s = newState();
    const p = localPlayer(s);
    p.wlevel.pistol = 3;
    expect(draftPool(s, p).map((it) => it.id)).not.toContain("lvl:pistol");
  });
  it("knife (melee) never appears", () => {
    const s = newState();
    expect(draftPool(s, localPlayer(s)).map((it) => it.id)).not.toContain("lvl:knife");
  });
});

describe("rollOffer", () => {
  it("returns n distinct items", () => {
    const pool = ["a", "b", "c", "d", "e"].map(fake);
    const seq = [0, 0, 0];
    let i = 0;
    const out = rollOffer(pool, 3, [], () => seq[i++] ?? 0);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((x) => x.id)).size).toBe(3);
  });
  it("clamps to pool size when pool < n", () => {
    expect(rollOffer(["a", "b"].map(fake), 3, [], () => 0)).toHaveLength(2);
  });
  it("honors exclude", () => {
    const out = rollOffer(["a", "b", "c"].map(fake), 3, ["b"], () => 0);
    expect(out.map((x) => x.id)).not.toContain("b");
  });
  it("is deterministic under a fixed rng", () => {
    const pool = ["a", "b", "c", "d"].map(fake);
    const r1 = rollOffer(pool.slice(), 2, [], () => 0.5).map((x) => x.id);
    const r2 = rollOffer(pool.slice(), 2, [], () => 0.5).map((x) => x.id);
    expect(r1).toEqual(r2);
  });
});

describe("rerollCost", () => {
  it("monotonically increases with reroll count", () => {
    expect(rerollCost(0)).toBe(30);
    expect(rerollCost(1)).toBe(55);
    expect(rerollCost(2)).toBe(80);
  });
});

describe("storeItems is fortify-only", () => {
  it("returns only deploy: items", () => {
    const s = newState();
    const ids = storeItems(s, localPlayer(s)).map((it) => it.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("deploy:"))).toBe(true);
  });
});

describe("isUpgradeableWeapon", () => {
  it("includes a ranged weapon defined in WEAPONS", () => {
    expect(isUpgradeableWeapon("pistol")).toBe(true);
  });
  it("excludes the melee weapon", () => {
    expect(isUpgradeableWeapon("knife")).toBe(false);
  });
  it("excludes an id with no WEAPONS entry", () => {
    expect(isUpgradeableWeapon("nonexistent")).toBe(false);
  });
});
