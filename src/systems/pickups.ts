import { CONFIG } from "../config";
import { PICKUP_TYPES } from "../data/pickups";
import { Audio } from "../engine/audio";
import { clamp, len, rand } from "../engine/math";
import { allocId } from "../state";
import type { Player, State } from "../types";
import { fxPickup } from "./fx";

/** Drop a pickup of the given type on the ground (with a little scatter). */
export function spawnPickup(state: State, x: number, y: number, defId: string): void {
  if (!PICKUP_TYPES[defId]) return;
  state.pickups.push({
    id: allocId(state),
    x: clamp(x + rand(-6, 6), -CONFIG.arena, CONFIG.arena),
    y: clamp(y + rand(-6, 6), -CONFIG.arena, CONFIG.arena),
    defId,
    life: CONFIG.ammo.pickupLife,
    maxLife: CONFIG.ammo.pickupLife,
    bob: rand(0, Math.PI * 2),
  });
}

/** Roll for a loot drop when a zombie dies. Brutes are far more generous. */
export function dropFromKill(state: State, x: number, y: number, big: boolean): void {
  const ammoChance = big ? CONFIG.ammo.bruteDropChance : CONFIG.ammo.dropChance;
  if (Math.random() < ammoChance) {
    spawnPickup(state, x, y, "ammo");
  } else if (Math.random() < CONFIG.flashlight.dropChance) {
    spawnPickup(state, x, y, "battery");
  } else if (Math.random() < CONFIG.ammo.healDropChance) {
    spawnPickup(state, x, y, "health");
  }
}

/** Decay pickups and auto-collect any that an alive player walks over. */
export function sysPickups(state: State, dt: number): void {
  const P = state.pickups;
  for (let i = P.length - 1; i >= 0; i--) {
    const pk = P[i] as (typeof P)[number];
    pk.life -= dt;
    if (pk.life <= 0) {
      P[i] = P[P.length - 1] as (typeof P)[number];
      P.pop();
      continue;
    }
    // first alive player within grab range collects it
    let collector: Player | null = null;
    for (const pl of state.players) {
      if (pl.hp <= 0) continue;
      if (len(pk.x - pl.x, pk.y - pl.y) < CONFIG.ammo.pickupRadius + pl.r) {
        collector = pl;
        break;
      }
    }
    if (collector) {
      const def = PICKUP_TYPES[pk.defId];
      if (def) {
        def.apply(state, collector);
        fxPickup(state, pk.x, pk.y, def.glow);
        Audio.pickup();
      }
      P[i] = P[P.length - 1] as (typeof P)[number];
      P.pop();
    }
  }
}
