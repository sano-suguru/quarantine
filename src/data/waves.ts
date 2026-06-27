import { CONFIG } from "../config";
import type { WaveDefinition } from "../types";

/**
 * The night-`n` horde definition. `players` (squad size) scales spawn COUNTS only — each
 * extra player adds CONFIG.econ.waveCountPerPlayer to every type's count — so more guns
 * meet more bodies. HP/speed/interval are unchanged. `players = 1` (single-player) yields
 * a multiplier of 1, so SP waves are byte-identical to before.
 */
export function waveDef(n: number, players = 1): WaveDefinition {
  const list: string[] = [];
  const mul = 1 + (Math.max(1, players) - 1) * CONFIG.econ.waveCountPerPlayer;
  const scale = (c: number): number => Math.round(c * mul);
  const walkers = scale(Math.round(6 + n * 2.4));
  const runners = scale(n >= 2 ? Math.round((n - 1) * 1.6) : 0);
  const brutes = scale(n >= 4 ? Math.floor(n / 3) : 0);
  for (let i = 0; i < walkers; i++) list.push("walker");
  for (let i = 0; i < runners; i++) list.push("runner");
  for (let i = 0; i < brutes; i++) list.push("brute");
  const hpScale = 1 + n * 0.06;
  const spdScale = 1 + n * 0.015;
  return { spawn: list, hpScale, spdScale, interval: Math.max(0.18, 0.7 - n * 0.03) };
}
