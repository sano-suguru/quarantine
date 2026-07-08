/**
 * Pure helpers for real-image sprite fragmentation (gore death-shatter). No GL — unit-tested.
 * `fragCell` is the per-instance encoding the renderer/shader use: 0 = whole sprite, otherwise
 * `cellY*gridN + cellX + 1`. `cellOffset` gives a cell's LOCAL offset from the sprite center,
 * Y-flipped to match the fragment shader's `0.5 - v_local.y` mapping (so a fragment spawns where
 * its pixels render on the intact sprite). The caller rotates this local offset by the sprite's
 * draw angle to get the world spawn position.
 */
export function packFragCell(cx: number, cy: number, gridN: number): number {
  return cy * gridN + cx + 1;
}

export function unpackFragCell(fragCell: number, gridN: number): { cx: number; cy: number } {
  const i = fragCell - 1;
  return { cx: i % gridN, cy: Math.floor(i / gridN) };
}

export function cellOffset(
  cx: number,
  cy: number,
  gridN: number,
  drawSize: number,
): { lx: number; ly: number } {
  return {
    lx: ((cx + 0.5) / gridN - 0.5) * drawSize,
    // Y-flip: cy=0 (atlas top / PNG top rows) → shader maps to the +v_local.y side, so +ly.
    ly: (0.5 - (cy + 0.5) / gridN) * drawSize,
  };
}
