export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const len = (x: number, y: number): number => Math.hypot(x, y);
/** Linear interpolation: `a` at t=0, `b` at t=1. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
/** Per-channel lerp between two RGB triples. */
export const mixRGB = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
/** Move `cur` toward `target` by at most `maxStep`, never overshooting (linear ramp). */
export const approach = (cur: number, target: number, maxStep: number): number => {
  const d = target - cur;
  return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep;
};
