/**
 * Pure flashlight cone intensity, split out for unit testing.
 * Off or dead battery → 0 (cone gone, only the dim personal pool remains).
 * Otherwise the cone always flickers a little (a failing bulb): it dips by
 * `baseFlickerDepth * noise` at a healthy charge, and by the deeper `flickerDepth * noise`
 * once the battery falls below `lowThreshold`.
 *
 * `noise` is injected (caller passes a time-correlated 0..1 value) so this stays
 * deterministic and the flicker reads as a tremor rather than per-frame static.
 */
export function flashlightIntensity(
  batteryFrac: number,
  on: boolean,
  lowThreshold: number,
  flickerDepth: number,
  baseFlickerDepth: number,
  noise: number,
): number {
  if (!on || batteryFrac <= 0) return 0;
  const depth = batteryFrac < lowThreshold ? flickerDepth : baseFlickerDepth;
  return Math.max(0, Math.min(1, 1 - depth * noise));
}
