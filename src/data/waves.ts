import type { WaveDefinition } from "../types";

export function waveDef(n: number): WaveDefinition {
  const list: string[] = [];
  const walkers = Math.round(6 + n * 2.4);
  const runners = n >= 2 ? Math.round((n - 1) * 1.6) : 0;
  const brutes = n >= 4 ? Math.floor(n / 3) : 0;
  for (let i = 0; i < walkers; i++) list.push("walker");
  for (let i = 0; i < runners; i++) list.push("runner");
  for (let i = 0; i < brutes; i++) list.push("brute");
  const hpScale = 1 + n * 0.06;
  const spdScale = 1 + n * 0.015;
  return { spawn: list, hpScale, spdScale, interval: Math.max(0.18, 0.7 - n * 0.03) };
}
