export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const len = (x: number, y: number): number => Math.hypot(x, y);
/** Move `cur` toward `target` by at most `maxStep`, never overshooting (linear ramp). */
export const approach = (cur: number, target: number, maxStep: number): number => {
  const d = target - cur;
  return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep;
};
