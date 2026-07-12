/**
 * Pure HP→world-desaturation grade. Full color (0) at or above `onset` (the calm zone that
 * keeps the day explore phase legible); rises to 1 as HP drains to 0. `gamma` shapes the
 * curve: 1 = linear, < 1 front-loads sensitivity so mid-HP damage is felt (not numb) rather
 * than the whole ramp bunching near death. The caller maps the grade onto a CSS
 * `saturate`/`brightness` filter; the heartbeat + red blood-vignette throb remain the alarm.
 *
 * Split out as a pure function (like `flashlightIntensity`) so the curve is unit-tested and
 * tunable from CONFIG without touching the renderer.
 */
export function integrityGrade(hpFrac: number, onset: number, gamma: number): number {
  if (hpFrac >= onset) return 0;
  if (hpFrac <= 0) return 1;
  return ((onset - hpFrac) / onset) ** gamma;
}
