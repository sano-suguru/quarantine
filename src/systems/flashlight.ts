/**
 * Pure flashlight cone intensity, split out for unit testing.
 * Off or dead battery → 0 (cone gone, only the dim personal pool remains).
 * Low battery → flickers down by flickerDepth * noise.
 * Otherwise → full strength.
 *
 * `noise` is injected (caller passes Math.random()) so this stays deterministic.
 */
export function flashlightIntensity(
  batteryFrac: number,
  on: boolean,
  lowThreshold: number,
  flickerDepth: number,
  noise: number,
): number {
  if (!on || batteryFrac <= 0) return 0;
  if (batteryFrac < lowThreshold) {
    return Math.max(0, Math.min(1, 1 - flickerDepth * noise));
  }
  return 1;
}
