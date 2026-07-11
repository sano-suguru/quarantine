import { CONFIG } from "../config";
import type { PickupDef, Player } from "../types";
import { WEAPONS } from "./weapons";

/**
 * Data-driven pickup catalogue. Adding a new collectible = one entry here;
 * the systems/draw/audio layers stay untouched (they look up by defId).
 */
export const PICKUP_TYPES: Record<string, PickupDef> = {
  ammo: {
    id: "ammo",
    label: "AMMO",
    color: [1.0, 0.82, 0.3],
    glow: [1.0, 0.7, 0.2],
    shape: "box",
    apply: (_s, p) => refillAmmo(p),
  },
  health: {
    id: "health",
    label: "MEDKIT",
    color: [1.0, 0.32, 0.36],
    glow: [1.0, 0.2, 0.25],
    shape: "cross",
    // grants a carried medkit (deliberate, used later via H) rather than an instant heal
    apply: (_s, p) => {
      p.medkits = Math.min(CONFIG.heal.maxMedkits, p.medkits + 1);
    },
  },
  battery: {
    id: "battery",
    label: "BATTERY",
    color: [0.6, 0.95, 1.0],
    glow: [0.4, 0.85, 1.0],
    shape: "battery",
    apply: (_s, p) => {
      p.battery = Math.min(CONFIG.flashlight.batteryMax, p.battery + CONFIG.flashlight.batteryMax);
    },
  },
};

/**
 * Top up the spare ammo for whatever gun the player is holding (clamped to its
 * reserveMax). If a melee weapon is equipped, the pistol is resupplied so the
 * pickup is never wasted.
 */
function refillAmmo(p: Player): void {
  const cur = WEAPONS[p.weapon];
  const targetId = cur && !cur.melee ? p.weapon : "pistol";
  const w = WEAPONS[targetId];
  if (!w) return;
  const add = Math.round(w.mag * CONFIG.ammo.ammoMagMul);
  const cap = Math.round(w.reserveMax * p.reserveMul);
  p.reserve[targetId] = Math.min(cap, (p.reserve[targetId] ?? 0) + add);
}
