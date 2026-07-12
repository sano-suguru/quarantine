/** A light the renderer could draw this frame. `priority` higher = kept first (players high). */
export interface LightCandidate {
  x: number;
  y: number;
  ax: number;
  ay: number;
  intens: number;
  range: number;
  cosHalf: number;
  priority: number;
}

/** circle (center, r) vs axis-aligned rect [cx±hx, cy±hy] (+ small margin) intersection. */
function reachesView(
  lx: number,
  ly: number,
  r: number,
  camX: number,
  camY: number,
  hx: number,
  hy: number,
): boolean {
  const margin = 24; // hysteresis so cones don't pop right at the screen edge
  const dx = Math.max(Math.abs(lx - camX) - (hx + margin), 0);
  const dy = Math.max(Math.abs(ly - camY) - (hy + margin), 0);
  return dx * dx + dy * dy <= r * r;
}

/** Two-stage light selection: (1) drop lights whose lit region can't reach the view; (2) if still
 *  over `max`, keep by priority then nearest-to-camera. Cost is thus bounded by `max` regardless of
 *  world light count. Returns the kept lights (input order is not preserved). */
export function selectLights(
  cands: LightCandidate[],
  camX: number,
  camY: number,
  hx: number,
  hy: number,
  max: number,
): LightCandidate[] {
  const visible = cands.filter((c) => reachesView(c.x, c.y, c.range, camX, camY, hx, hy));
  if (visible.length <= max) return visible;
  const d2 = (c: LightCandidate) => (c.x - camX) ** 2 + (c.y - camY) ** 2;
  visible.sort((a, b) => b.priority - a.priority || d2(a) - d2(b));
  return visible.slice(0, max);
}
