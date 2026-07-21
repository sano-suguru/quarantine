import { CONFIG } from "../config";
import type { WaveDefinition } from "../types";

/**
 * The night-`n` horde definition: a continuous spawner spec, not a finite roster. `weights`
 * give the composition sampled per pulse (runners/brutes enter and grow with the day); `batch`
 * is how many spawn per pulse and `interval` the cadence — both scale with the day, and `batch`
 * scales with squad size (`players`) so more guns meet more bodies. `players = 1` (single-player)
 * yields a multiplier of 1. The night ends on the dawn clock; the cap (sysWave) bounds the crowd.
 */
export function waveDef(n: number, players = 1): WaveDefinition {
  const extra = Math.max(0, Math.max(1, players) - 1); // players beyond the first
  const mul = 1 + extra * CONFIG.econ.waveCountPerPlayer; // batch: ~linear (the mowing axis)
  // toughness/texture: sublinear via sqrt(extra). This makes INDIVIDUALS a bit tougher (harder),
  // NOT the per-person easing — per-person load eases via the sublinear nightMaxZombies cap.
  const tough = 1 + Math.sqrt(extra) * CONFIG.econ.toughPerPlayer;
  const weights: { type: string; w: number }[] = [{ type: "walker", w: 6 + n * 2.4 }];
  // composition shift: runner/brute weights rise with `tough`, walker stays flat → the mix
  // tilts toward tougher types as the party grows (qualitative, not just hp inflation).
  if (n >= 2) weights.push({ type: "runner", w: (n - 1) * 1.6 * tough });
  if (n >= 4) weights.push({ type: "brute", w: Math.floor(n / 3) * tough });
  const batch = Math.max(1, Math.round((1 + Math.floor(n / 3)) * mul));
  const interval = Math.max(0.45, 1.3 - n * 0.04);
  const hpScale = (1 + n * 0.1) * tough; // gentle flat bump layered on the day curve
  const spdScale = 1 + n * 0.015; // speed stays day-driven (sublinear tough on hp only)
  return { weights, batch, interval, hpScale, spdScale };
}
