import type { Segment } from "../types";
import { closestPointOnSegment } from "./geometry";

export interface FlowField {
  cell: number;
  minX: number;
  minY: number;
  cols: number;
  rows: number;
  cost: Float32Array; // BFS distance to nearest target; Infinity = wall/unreachable
}

function idx(f: { cols: number }, c: number, r: number): number {
  return r * f.cols + c;
}

/**
 * Returns false if any wall passes within `clearance` of the cell whose center is at (x, y).
 * `halfCell` is added to clearance so that a wall passing through the cell's footprint (not
 * just within clearance of its centre) also blocks it — this guarantees that the grid blocks
 * any direct crossing of a wall, regardless of where grid phase places the cell centres.
 */
function walkable(
  walls: Segment[],
  x: number,
  y: number,
  clearance: number,
  halfCell: number,
): boolean {
  const eff = clearance + halfCell;
  for (const w of walls) {
    // AABB early-reject: most cells are far from most walls, so skip the sqrt when the
    // point is outside the wall's bounding box padded by `eff`. Keeps the grid
    // build ~O(cells) instead of O(cells × walls).
    if (x < Math.min(w.x1, w.x2) - eff || x > Math.max(w.x1, w.x2) + eff) continue;
    if (y < Math.min(w.y1, w.y2) - eff || y > Math.max(w.y1, w.y2) + eff) continue;
    const p = closestPointOnSegment(x, y, w.x1, w.y1, w.x2, w.y2);
    if (Math.hypot(x - p.x, y - p.y) < eff) return false;
  }
  return true;
}

export function buildFlowField(
  walls: Segment[],
  targets: { x: number; y: number }[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cell: number,
  clearance: number,
): FlowField {
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
  const rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cell));
  const f: FlowField = {
    cell,
    minX: bounds.minX,
    minY: bounds.minY,
    cols,
    rows,
    cost: new Float32Array(cols * rows),
  };
  f.cost.fill(Number.POSITIVE_INFINITY);

  // mark walkable cells (effective clearance = clearance + halfCell so walls block the full
  // cell footprint, not just the cell centre — prevents direct wall crossings at any grid phase)
  const halfCell = cell * 0.5;
  const walk = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wx = bounds.minX + (c + 0.5) * cell;
      const wy = bounds.minY + (r + 0.5) * cell;
      walk[idx(f, c, r)] = walkable(walls, wx, wy, clearance, halfCell) ? 1 : 0;
    }
  }

  // multi-source BFS (4-neighbour; cost in cells)
  const q: number[] = [];
  for (const t of targets) {
    const c = Math.floor((t.x - bounds.minX) / cell);
    const r = Math.floor((t.y - bounds.minY) / cell);
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    const i = idx(f, c, r);
    if (walk[i]) {
      f.cost[i] = 0;
      q.push(i);
    }
  }
  for (let head = 0; head < q.length; head++) {
    const i = q[head] as number;
    const c = i % cols;
    const r = (i / cols) | 0;
    const base = f.cost[i] as number;
    const nb: [number, number][] = [
      [c - 1, r],
      [c + 1, r],
      [c, r - 1],
      [c, r + 1],
    ];
    for (const [nc, nr] of nb) {
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = idx(f, nc, nr);
      if (!walk[ni]) continue;
      if (base + 1 < (f.cost[ni] as number)) {
        f.cost[ni] = base + 1;
        q.push(ni);
      }
    }
  }
  return f;
}

function costAt(f: FlowField, c: number, r: number): number {
  if (c < 0 || r < 0 || c >= f.cols || r >= f.rows) return Number.POSITIVE_INFINITY;
  return f.cost[idx(f, c, r)] as number;
}

/** Unit heading descending the cost field toward the nearest target. Returns {0,0} if unreachable/outside. */
export function sampleFlow(f: FlowField, x: number, y: number): { hx: number; hy: number } {
  const c = Math.floor((x - f.minX) / f.cell);
  const r = Math.floor((y - f.minY) / f.cell);
  const here = costAt(f, c, r);
  if (!Number.isFinite(here)) return { hx: 0, hy: 0 };
  // gradient via finite differences on the cost field (descend = negative gradient)
  // Math.min(cost, 1e9) keeps Infinity from producing NaN in subtraction while still repelling
  const gx = Math.min(costAt(f, c + 1, r), 1e9) - Math.min(costAt(f, c - 1, r), 1e9);
  const gy = Math.min(costAt(f, c, r + 1), 1e9) - Math.min(costAt(f, c, r - 1), 1e9);
  const hx = -gx;
  const hy = -gy;
  const l = Math.hypot(hx, hy);
  if (l < 1e-6) return { hx: 0, hy: 0 };
  return { hx: hx / l, hy: hy / l };
}
