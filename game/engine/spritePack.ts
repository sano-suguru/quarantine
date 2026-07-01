/** Pure atlas geometry: deterministic shelf packing + half-texel-inset UVs. No GL, no I/O. */

export interface Size {
  w: number;
  h: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Packed {
  atlas: number;
  rects: Rect[];
}

/**
 * Shelf-pack `sizes` IN INPUT ORDER (so the caller's stable index maps to rects[i]) into the
 * smallest pow2 square atlas (from 64) that fits within `maxAtlas`. `gutter` px of trailing
 * spacing separates neighbors so NEAREST sampling can't bleed. Throws if nothing fits.
 */
export function packSprites(sizes: Size[], gutter: number, maxAtlas: number): Packed {
  for (let atlas = 64; atlas <= maxAtlas; atlas *= 2) {
    const rects = tryPack(sizes, gutter, atlas);
    if (rects) return { atlas, rects };
  }
  throw new Error("sprite atlas over budget");
}

function tryPack(sizes: Size[], gutter: number, atlas: number): Rect[] | null {
  const rects: Rect[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const s of sizes) {
    const cellW = s.w + gutter;
    const cellH = s.h + gutter;
    if (x + cellW > atlas) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    if (y + cellH > atlas) return null;
    rects.push({ x, y, w: s.w, h: s.h });
    x += cellW;
    if (cellH > rowH) rowH = cellH;
  }
  return rects;
}

/** UV rect [u0, v0, uWidth, vHeight] for a packed rect, inset half a texel so NEAREST stays inside. */
export function uvRect(r: Rect, atlas: number): [number, number, number, number] {
  return [(r.x + 0.5) / atlas, (r.y + 0.5) / atlas, (r.w - 1) / atlas, (r.h - 1) / atlas];
}
