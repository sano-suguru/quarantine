import { CONFIG } from "../config";
import type { DeployableDef, Player, State, WeaponDef } from "../types";
import { DEPLOYABLE_TYPES, deployableCount, placeDeployable } from "./deployables";
import { UPGRADES } from "./upgrades";
import { WEAPONS, WEAPON_ORDER } from "./weapons";

/* ---- pure stat scaling (unit-tested) ---- */
export function scaledDmg(base: number, level: number): number {
  return base * (1 + level * CONFIG.arsenal.dmgPerLevel);
}
export function scaledMag(base: number, level: number): number {
  return Math.round(base * (1 + level * CONFIG.arsenal.magPerLevel));
}
/** credits to go from `level` to `level + 1` */
export function levelCost(level: number): number {
  return CONFIG.arsenal.levelBaseCost + level * CONFIG.arsenal.levelStep;
}

/** SALVAGE banked for a run lasting `day` nights with `kills` total kills. */
export function salvageEarned(day: number, kills: number): number {
  return Math.round(day * CONFIG.arsenal.salvagePerDay + kills * CONFIG.arsenal.salvagePerKill);
}

/**
 * The weapon's effective stats this run: base table plus the player's run-scoped upgrade
 * level (damage and magazine only). Upgrades are per-player now, so this reads the player's
 * own wlevel. WEAPONS itself is never mutated.
 */
export function effWeapon(p: Player, id: string): WeaponDef {
  const base = WEAPONS[id] as WeaponDef;
  const lvl = p.wlevel[id] ?? 0;
  if (lvl <= 0) return base;
  return { ...base, dmg: scaledDmg(base.dmg, lvl), mag: scaledMag(base.mag, lvl) };
}

/** A purchasable line in the between-nights arsenal store. */
export interface StoreItem {
  id: string;
  name: string;
  desc: string;
  price: number;
  /** can `buyer` afford + still upgrade this? Money and weapon levels are per-player now. */
  canBuy: (s: State, buyer: Player) => boolean;
  /** apply the purchase to `buyer` (the player who paid): their money, weapon level, perks. */
  buy: (s: State, buyer: Player) => void;
}

/** Build the store list for `buyer`: weapon upgrades + field perks priced off their own
 *  wallet/levels (the shop is each player's personal locker). `owned` is still shared. */
export function storeItems(state: State, buyer: Player): StoreItem[] {
  const items: StoreItem[] = [];
  const a = CONFIG.arsenal;

  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id];
    if (!w || w.melee || !state.owned[id]) continue;
    const lvl = buyer.wlevel[id] ?? 0;
    if (lvl >= a.maxLevel) continue;
    const price = levelCost(lvl);
    items.push({
      id: `lvl:${id}`,
      name: `${w.name} ▸ Mk ${lvl + 2}`,
      desc: `+${Math.round(a.dmgPerLevel * 100)}% dmg · +${Math.round(a.magPerLevel * 100)}% mag`,
      price,
      canBuy: (_s, b) => b.money >= price && (b.wlevel[id] ?? 0) < a.maxLevel,
      buy: (_s, b) => {
        b.wlevel[id] = (b.wlevel[id] ?? 0) + 1;
      },
    });
  }

  for (const u of UPGRADES) {
    items.push({
      id: `perk:${u.name}`,
      name: u.name,
      desc: u.desc,
      price: a.perkCost,
      canBuy: (_s, b) => b.money >= a.perkCost,
      buy: (s, b) => u.apply(s, b),
    });
  }

  // Fortify: buy with your own credits, auto-placed at the base, benefits the whole squad
  // (the buyer included — the turret/station guards the shelter they're in too).
  for (const id of Object.keys(DEPLOYABLE_TYPES)) {
    const d = DEPLOYABLE_TYPES[id] as DeployableDef;
    items.push({
      id: `deploy:${id}`,
      name: `${d.name} (Fortify)`,
      desc: `${d.desc} · ${deployableCount(state, id)}/${d.cap} built`,
      price: d.cost,
      canBuy: (s, b) => b.money >= d.cost && deployableCount(s, id) < d.cap,
      buy: (s) => placeDeployable(s, id),
    });
  }

  return items;
}
