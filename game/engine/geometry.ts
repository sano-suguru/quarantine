import type { Segment } from "../types";

/** Closest point on segment AB to point P (clamped to the segment endpoints). */
export function closestPointOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number } {
  const ex = x2 - x1;
  const ey = y2 - y1;
  const len2 = ex * ex + ey * ey;
  if (len2 === 0) return { x: x1, y: y1 };
  let t = ((px - x1) * ex + (py - y1) * ey) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: x1 + ex * t, y: y1 + ey * t };
}

/**
 * If a circle (cx,cy,r) overlaps segment `s`, return the minimum push-out vector
 * that separates them; otherwise null. Used to keep the player/zombies out of walls.
 */
export function circlePushFromSegment(
  cx: number,
  cy: number,
  r: number,
  s: Segment,
): { dx: number; dy: number } | null {
  const cp = closestPointOnSegment(cx, cy, s.x1, s.y1, s.x2, s.y2);
  let nx = cx - cp.x;
  let ny = cy - cp.y;
  const d = Math.hypot(nx, ny);
  if (d >= r) return null;
  if (d > 1e-6) {
    nx /= d;
    ny /= d;
  } else {
    // dead-centre on the segment: push along its normal
    const ex = s.x2 - s.x1;
    const ey = s.y2 - s.y1;
    const el = Math.hypot(ex, ey) || 1;
    nx = -ey / el;
    ny = ex / el;
  }
  const push = r - d;
  return { dx: nx * push, dy: ny * push };
}

/**
 * If two circles overlap, return the vector that pushes circle A out of B
 * (full separation distance). Otherwise null. Callers can apply half to each
 * side for a symmetric resolve.
 */
export function circlePush(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): { dx: number; dy: number } | null {
  let nx = ax - bx;
  let ny = ay - by;
  const d = Math.hypot(nx, ny);
  const min = ar + br;
  if (d >= min) return null;
  const push = min - d;
  if (d > 1e-6) {
    nx /= d;
    ny /= d;
  } else {
    // exactly coincident: pick an arbitrary axis so they still separate
    nx = 1;
    ny = 0;
  }
  return { dx: nx * push, dy: ny * push };
}

/** Whether segment AB intersects segment CD (proper or touching). */
export function segmentHitsSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = cross(dx - cx, dy - cy, ax - cx, ay - cy);
  const d2 = cross(dx - cx, dy - cy, bx - cx, by - cy);
  const d3 = cross(bx - ax, by - ay, cx - ax, cy - ay);
  const d4 = cross(bx - ax, by - ay, dx - ax, dy - ay);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true;
  // collinear-touching cases
  if (d1 === 0 && onSeg(cx, cy, dx, dy, ax, ay)) return true;
  if (d2 === 0 && onSeg(cx, cy, dx, dy, bx, by)) return true;
  if (d3 === 0 && onSeg(ax, ay, bx, by, cx, cy)) return true;
  if (d4 === 0 && onSeg(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

function cross(ux: number, uy: number, vx: number, vy: number): number {
  return ux * vy - uy * vx;
}

/** Is point P on segment AB, given P is known to be collinear with AB? */
function onSeg(ax: number, ay: number, bx: number, by: number, px: number, py: number): boolean {
  return (
    Math.min(ax, bx) <= px &&
    px <= Math.max(ax, bx) &&
    Math.min(ay, by) <= py &&
    py <= Math.max(ay, by)
  );
}
