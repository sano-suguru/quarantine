import { CONFIG } from "../config";
import type { DeployableDef, Player, State, WeaponDef } from "../types";
import { DEPLOYABLE_TYPES, deployableCount } from "./deployables";
import { UPGRADES } from "./upgrades";
import { WEAPON_ORDER, WEAPONS } from "./weapons";

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

/** Melee cone half-angle (radians) — weapon's own value, or the CONFIG fallback. */
export function meleeArc(wd: WeaponDef): number {
  return wd.meleeArc ?? CONFIG.feel.meleeArcDefault;
}
/** Melee reach in world units for a player of radius `r` — weapon range (or CONFIG fallback) + r. */
export function meleeReach(wd: WeaponDef, r: number): number {
  return (wd.meleeRange ?? CONFIG.feel.meleeRangeDefault) + r;
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

  // Fortify: buy with your own credits into your personal deploy queue, then drop it at your
  // feet in the field (Q). A placed structure benefits the whole squad. The cap is the shared
  // world-placed limit; the buy gate is the per-player view (placed + what you already hold), so
  // you can't stockpile beyond what you could place — the hard cap is re-checked at place time.
  for (const id of Object.keys(DEPLOYABLE_TYPES)) {
    const d = DEPLOYABLE_TYPES[id] as DeployableDef;
    const queued = (b: Player) => b.deployQueue.reduce((n, q) => (q === id ? n + 1 : n), 0);
    items.push({
      id: `deploy:${id}`,
      name: `${d.name} (Fortify)`,
      desc: `${d.desc} · ${deployableCount(state, id)}/${d.cap} built${queued(buyer) ? ` · ${queued(buyer)} queued` : ""}`,
      price: d.cost,
      canBuy: (s, b) => b.money >= d.cost && deployableCount(s, id) + queued(b) < d.cap,
      buy: (_s, b) => {
        b.deployQueue.push(id);
      },
    });
  }

  return items;
}

/**
 * Resolve a single draft card id to a StoreItem (used by host to apply and by client to render).
 * `perk:<perkId>` → a perk card; `lvl:<weaponId>` → that weapon's next-Mk upgrade (undefined if
 * the weapon is melee/unknown or already at maxLevel). Reuses the StoreItem abstraction — no new type.
 */
export function cardItem(_state: State, buyer: Player, id: string): StoreItem | undefined {
  const a = CONFIG.arsenal;
  if (id.startsWith("perk:")) {
    const perkId = id.slice("perk:".length);
    const u = UPGRADES.find((x) => x.id === perkId);
    if (!u) return undefined;
    return {
      id,
      name: u.name,
      desc: u.desc,
      price: a.perkCost,
      canBuy: (_s, b) => b.money >= a.perkCost,
      buy: (s, b) => u.apply(s, b),
    };
  }
  if (id.startsWith("lvl:")) {
    const wid = id.slice("lvl:".length);
    const w = WEAPONS[wid];
    if (!w || w.melee) return undefined;
    const lvl = buyer.wlevel[wid] ?? 0;
    if (lvl >= a.maxLevel) return undefined;
    const price = levelCost(lvl);
    return {
      id,
      name: `${w.name} ▸ Mk ${lvl + 2}`,
      desc: `+${Math.round(a.dmgPerLevel * 100)}% dmg · +${Math.round(a.magPerLevel * 100)}% mag`,
      price,
      canBuy: (_s, b) => b.money >= price && (b.wlevel[wid] ?? 0) < a.maxLevel,
      buy: (_s, b) => {
        b.wlevel[wid] = (b.wlevel[wid] ?? 0) + 1;
      },
    };
  }
  return undefined;
}

/**
 * The eligible draft cards for `buyer` this run: unlocked perk cards (starter perks + SALVAGE-
 * unlocked) plus every owned, non-maxed weapon's upgrade card. Host/single only (the roll source);
 * clients render from the synced offer ids via cardItem. Pure — no RNG here.
 */
export function draftPool(state: State, buyer: Player): StoreItem[] {
  const items: StoreItem[] = [];
  const unlocked = (state as { unlockedCards?: Record<string, boolean> }).unlockedCards ?? {};
  for (const u of UPGRADES) {
    if (!u.starter && !unlocked[`card:${u.id}`]) continue;
    const it = cardItem(state, buyer, `perk:${u.id}`);
    if (it) items.push(it);
  }
  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id];
    if (!w || w.melee || !state.owned[id]) continue;
    const it = cardItem(state, buyer, `lvl:${id}`); // undefined if maxed → skipped
    if (it) items.push(it);
  }
  return items;
}

/**
 * Stable wire order of every possible draft card id (perk cards then weapon-upgrade cards).
 * APPEND-ONLY — this is the snapshot index for Player.draftOffer (see snapshot.ts). Adding a perk
 * or weapon appends; never reorder.
 */
export const CARD_ORDER: string[] = [
  ...UPGRADES.map((u) => `perk:${u.id}`),
  ...WEAPON_ORDER.filter((id) => !WEAPONS[id]?.melee).map((id) => `lvl:${id}`),
];
