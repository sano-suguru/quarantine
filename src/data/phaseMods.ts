import type { SiegePhase } from "../types";

/**
 * Day/night behaviour modifiers applied as FACTORS in sysAI's existing multiplier chain —
 * not special-case branches. Day = sluggish, short-sighted shamblers you can slip past while
 * looting; night = ferocious, wide-sensed, lunging, latched-on. Night ferocity ramps with the
 * day number (survivability comes from the dawn clock + barricades, not weakened enemies).
 *
 * Global (no enemy-type axis) on purpose — every type rides the same day/night feel for now.
 * If a specific type ever needs its own day behaviour, add a type-keyed override here.
 */
export interface PhaseMod {
  speedMul: number;
  senseMul: number;
  lunge: boolean;
  wanderMul: number;
  autoAggro: boolean;
}

export function phaseMods(phase: SiegePhase, day: number): PhaseMod {
  if (phase === "day") {
    // slow, near-blind, extra-wandery, never auto-aggro — easy to read and avoid
    return { speedMul: 0.6, senseMul: 0.45, lunge: false, wanderMul: 1.6, autoAggro: false };
  }
  // night: at/above base speed, wide sense, lunging, latched aggro — ramps with the day
  return {
    speedMul: 1 + Math.min(0.4, (day - 1) * 0.04),
    senseMul: 1.15,
    lunge: true,
    wanderMul: 1,
    autoAggro: true,
  };
}
