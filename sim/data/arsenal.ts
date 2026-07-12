import { CONFIG } from "../config";
import type { DeployableDef, Player, State, WeaponDef } from "../types";
import { DEPLOYABLE_TYPES, deployableCount } from "./deployables";
import { UPGRADES } from "./upgrades";
import { isUpgradeableWeapon, WEAPON_ORDER, WEAPONS } from "./weapons";

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
 * Resolve a mouse-wheel weapon step to an absolute `order` slot index.
 * `eligible(id)` decides which slots are cyclable (owned && non-melee). Starting from
 * `currentId`'s position among the eligible slots, move `step` (±1) with wrap-around and
 * return the resulting absolute index into `order`. Returns null when there is no move:
 * ≤1 eligible slot, or the destination equals the current slot.
 * If `currentId` is not itself eligible (e.g. the knife, equipped via number key), enter the
 * nearest eligible weapon in the step direction: the first for step>0, the last for step<0.
 */
export function cycleWeaponSlot(
  order: readonly string[],
  eligible: (id: string) => boolean,
  currentId: string,
  step: number,
): number | null {
  const slots: number[] = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    if (id !== undefined && eligible(id)) slots.push(i);
  }
  if (slots.length <= 1) return null;

  const curSlot = order.indexOf(currentId);
  const curPos = slots.indexOf(curSlot);
  const destPos =
    curPos === -1
      ? step > 0
        ? 0
        : slots.length - 1
      : (curPos + step + slots.length) % slots.length;

  const dest = slots[destPos];
  if (dest === undefined || dest === curSlot) return null;
  return dest;
}

/** A single player's banked share of a run's SALVAGE pot, split evenly across the `recipients`
 *  that actually bank it (the non-absent players == host + connected clients). Floored so co-op
 *  never over-banks; `Math.max(1, …)` guards the impossible zero-recipient case. */
export function salvageShare(total: number, recipients: number): number {
  return Math.floor(total / Math.max(1, recipients));
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

/** Build the Fortify (deployables) store list for `buyer`. Weapon upgrades and perks moved to the
 *  nightly draft (draftPool); this now returns only the spatial fortifications, priced off the
 *  buyer's own wallet. `applyBuy` still resolves these by id. */
export function storeItems(state: State, buyer: Player): StoreItem[] {
  const items: StoreItem[] = [];
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
  const unlocked = state.unlockedCards;
  for (const u of UPGRADES) {
    if (!u.starter && !unlocked[`card:${u.id}`]) continue;
    const it = cardItem(state, buyer, `perk:${u.id}`);
    if (it) items.push(it);
  }
  for (const id of WEAPON_ORDER) {
    if (!isUpgradeableWeapon(id) || !state.owned[id]) continue;
    const it = cardItem(state, buyer, `lvl:${id}`); // undefined if maxed → skipped
    if (it) items.push(it);
  }
  return items;
}

/**
 * Pick up to `n` DISTINCT cards from `pool` (minus `exclude` ids) using a partial Fisher–Yates.
 * `rng` is injected (default Math.random) so tests are deterministic — this is the one place we
 * break the project's "Math.random direct-call" habit, because the test方針 requires it.
 */
export function rollOffer(
  pool: StoreItem[],
  n: number,
  exclude: string[] = [],
  rng: () => number = Math.random,
): StoreItem[] {
  const avail = pool.filter((it) => !exclude.includes(it.id));
  const picked: StoreItem[] = [];
  for (let i = 0; i < avail.length && picked.length < n; i++) {
    const j = i + Math.floor(rng() * (avail.length - i));
    const tmp = avail[i] as StoreItem;
    avail[i] = avail[j] as StoreItem;
    avail[j] = tmp;
    picked.push(avail[i] as StoreItem);
  }
  return picked;
}

/** SCRAP cost of the next reroll given how many rerolls were already done this night. */
export function rerollCost(rerolls: number): number {
  return CONFIG.arsenal.rerollBase + rerolls * CONFIG.arsenal.rerollStep;
}

/**
 * Stable wire order of every possible draft card id (perk cards then weapon-upgrade cards).
 * APPEND-ONLY — this is the snapshot index for Player.draftOffer (see snapshot.ts). Adding a perk
 * or weapon appends; never reorder.
 */
export const CARD_ORDER: string[] = [
  ...UPGRADES.map((u) => `perk:${u.id}`),
  ...WEAPON_ORDER.filter(isUpgradeableWeapon).map((id) => `lvl:${id}`),
];
