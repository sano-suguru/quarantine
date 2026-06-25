import { CONFIG } from "../config";
import type { State, WeaponDef } from "../types";
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

/**
 * The weapon's effective stats this run: base table plus the run-scoped upgrade
 * level (damage and magazine only). WEAPONS itself is never mutated.
 */
export function effWeapon(state: State, id: string): WeaponDef {
  const base = WEAPONS[id] as WeaponDef;
  const lvl = state.wlevel[id] ?? 0;
  if (lvl <= 0) return base;
  return { ...base, dmg: scaledDmg(base.dmg, lvl), mag: scaledMag(base.mag, lvl) };
}

/** A purchasable line in the between-nights arsenal store. */
export interface StoreItem {
  id: string;
  name: string;
  desc: string;
  price: number;
  canBuy: (s: State) => boolean;
  buy: (s: State) => void;
}

/** Build the store list for the current run: weapon upgrades + field perks. */
export function storeItems(state: State): StoreItem[] {
  const items: StoreItem[] = [];
  const a = CONFIG.arsenal;

  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id];
    if (!w || w.melee || !state.owned[id]) continue;
    const lvl = state.wlevel[id] ?? 0;
    if (lvl >= a.maxLevel) continue;
    const price = levelCost(lvl);
    items.push({
      id: `lvl:${id}`,
      name: `${w.name} ▸ Mk ${lvl + 2}`,
      desc: `+${Math.round(a.dmgPerLevel * 100)}% dmg · +${Math.round(a.magPerLevel * 100)}% mag`,
      price,
      canBuy: (s) => s.money >= price && (s.wlevel[id] ?? 0) < a.maxLevel,
      buy: (s) => {
        s.wlevel[id] = (s.wlevel[id] ?? 0) + 1;
      },
    });
  }

  for (const u of UPGRADES) {
    items.push({
      id: `perk:${u.name}`,
      name: u.name,
      desc: u.desc,
      price: a.perkCost,
      canBuy: (s) => s.money >= a.perkCost,
      buy: (s) => u.apply(s),
    });
  }

  return items;
}
