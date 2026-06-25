import { CONFIG } from "../config";
import type { State } from "../types";
import { spawnPickup } from "./pickups";

/** Reset every cache to unsearched — called at the start of each day. */
export function restockCaches(state: State): void {
  for (const c of state.caches) {
    c.looted = false;
    c.searchT = 0;
  }
}

/**
 * Award a searched cache's loot: richer tiers spit out more, with credits and a
 * higher chance of a battery/medkit. Loot is emitted as normal pickups so the
 * existing pickup/HUD/audio path handles collection.
 */
export function lootCache(state: State, x: number, y: number, tier: number): void {
  const drops = 1 + tier; // tier 1→2 items, tier 3→4 items
  for (let i = 0; i < drops; i++) {
    const roll = Math.random();
    const id = roll < 0.18 ? "battery" : roll < 0.34 ? "health" : "ammo";
    // spread the loot a little so it doesn't stack on one pixel
    spawnPickup(state, x + (i - drops / 2) * 14, y - 10, id);
  }
  state.money += 10 * tier; // credits to spend on repairs/upgrades
}

/** seconds of holding interact (and standing still) needed to crack a cache */
export const SEARCH_TIME = CONFIG.cache.searchTime;
