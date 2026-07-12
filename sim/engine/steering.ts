import type { Segment } from "../types";
import { closestPointOnSegment } from "./geometry";

export interface AvoidOpts {
  look: number; // how far ahead to probe
  whiskerAngle: number; // radians offset of side whiskers
  strength: number; // how hard to steer away
}

/** nearest wall-clearance penalty along a probe direction from (x,y) */
function probe(
  x: number,
  y: number,
  dx: number,
  dy: number,
  look: number,
  walls: Segment[],
): number {
  const px = x + dx * look;
  const py = y + dy * look;
  let worst = 0;
  for (const w of walls) {
    const c = closestPointOnSegment(px, py, w.x1, w.y1, w.x2, w.y2);
    const d = Math.hypot(px - c.x, py - c.y);
    const pen = Math.max(0, 1 - d / look); // 0 far, →1 as it nears the probe tip
    if (pen > worst) worst = pen;
  }
  return worst;
}

/**
 * Find the wall tangent (slide direction) for the most-blocking wall hit by the center probe.
 * Returns the tangent component that best steers around the blockage — the component of the
 * original heading projected onto the wall segment, giving a "slide along the wall" direction.
 */
function slideTangent(
  x: number,
  y: number,
  dx: number,
  dy: number,
  look: number,
  walls: Segment[],
): { tx: number; ty: number } {
  const px = x + dx * look;
  const py = y + dy * look;
  let worstPen = -1;
  // fallback: turn perpendicular to current heading (90° rotation, biased toward +y)
  let tx = -dy;
  let ty = dx;
  for (const w of walls) {
    const c = closestPointOnSegment(px, py, w.x1, w.y1, w.x2, w.y2);
    const d = Math.hypot(px - c.x, py - c.y);
    const pen = Math.max(0, 1 - d / look);
    if (pen > worstPen) {
      worstPen = pen;
      // wall tangent vector (normalized)
      const ex = w.x2 - w.x1;
      const ey = w.y2 - w.y1;
      const el = Math.hypot(ex, ey) || 1;
      const wtx = ex / el;
      const wty = ey / el;
      // project original heading onto the wall tangent — gives the slide direction.
      // If the dot product is negative, flip to keep the zombie moving "forward" along the wall.
      const dot = dx * wtx + dy * wty;
      const sign = dot >= 0 ? 1 : -1;
      tx = wtx * sign;
      ty = wty * sign;
    }
  }
  return { tx, ty };
}

/** Nudge a desired heading away from walls using three forward whiskers. Pure. */
export function avoidHeading(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  walls: Segment[],
  opts: AvoidOpts,
): { hx: number; hy: number } {
  if (walls.length === 0) return { hx: dirX, hy: dirY };
  const base = Math.atan2(dirY, dirX);
  const center = probe(x, y, Math.cos(base), Math.sin(base), opts.look, walls);
  if (center === 0) return { hx: dirX, hy: dirY };
  const la = base + opts.whiskerAngle;
  const ra = base - opts.whiskerAngle;
  const left = probe(x, y, Math.cos(la), Math.sin(la), opts.look, walls);
  const right = probe(x, y, Math.cos(ra), Math.sin(ra), opts.look, walls);
  // turn toward the clearer side, proportional to the blockage
  const whiskerDiff = right - left;
  if (Math.abs(whiskerDiff) > 0.05) {
    // asymmetric blockage: rotate toward the clearer whisker
    const turn = whiskerDiff * opts.strength * center;
    const a = base + turn;
    return { hx: Math.cos(a), hy: Math.sin(a) };
  }
  // symmetric (or near-symmetric) blockage: slide along the wall tangent
  const { tx, ty } = slideTangent(x, y, Math.cos(base), Math.sin(base), opts.look, walls);
  const blend = center * opts.strength;
  let hx = dirX + tx * blend;
  let hy = dirY + ty * blend;
  const l = Math.hypot(hx, hy) || 1;
  hx /= l;
  hy /= l;
  return { hx, hy };
}
