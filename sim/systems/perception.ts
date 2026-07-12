import { segmentHitsSegment } from "../engine/geometry";
import type { Segment } from "../types";

/** True if no wall blocks the straight segment a→b. */
export function hasLineOfSight(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  walls: Segment[],
): boolean {
  for (const w of walls) {
    if (segmentHitsSegment(ax, ay, bx, by, w.x1, w.y1, w.x2, w.y2)) return false;
  }
  return true;
}

/** True if the zombie is within a player's current noise radius (hearing, LOS-independent). */
export function heard(
  px: number,
  py: number,
  noiseRadius: number,
  zx: number,
  zy: number,
): boolean {
  const dx = zx - px;
  const dy = zy - py;
  return dx * dx + dy * dy <= noiseRadius * noiseRadius;
}
