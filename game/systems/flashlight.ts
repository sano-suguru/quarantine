/**
 * Pure flashlight cone intensity, split out for unit testing.
 * Off or dead battery → 0 (cone gone, only the dim personal pool remains).
 *
 * Steady brightness eases down with the charge: full at/above `dimStart`, ramping to
 * `dimFloor` as the battery empties — a continuously weakening beam stands in for the old
 * battery meter (the encroaching dark). `dimFloor` is a real usable lower bound, so the
 * steady level is never unfairly dark while lit.
 *
 * On top of that steady level a failing-bulb tremor dips by `baseFlickerDepth * noise`
 * at a healthy charge, and by the deeper `flickerDepth * noise` once the battery falls
 * below `lowThreshold`. The tremor may momentarily dip below `dimFloor` toward 0 (the
 * dying-bulb flicker) — that is intentional — while the steady level stays at `base`.
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
  dimFloor: number,
  dimStart: number,
): number {
  if (!on || batteryFrac <= 0) return 0;
  const t = Math.min(1, batteryFrac / dimStart);
  const base = dimFloor + (1 - dimFloor) * t;
  const depth = batteryFrac < lowThreshold ? flickerDepth : baseFlickerDepth;
  return Math.max(0, Math.min(1, base - depth * noise));
}
