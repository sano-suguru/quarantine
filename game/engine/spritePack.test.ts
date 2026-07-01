import { describe, expect, it } from "vitest";
import { packSprites, uvRect } from "./spritePack";

describe("packSprites", () => {
  it("puts a single sprite at the origin in the smallest fitting pow2 atlas", () => {
    const p = packSprites([{ w: 100, h: 100 }], 2, 2048);
    expect(p.atlas).toBe(128); // 100 + gutter = 102 > 64, fits 128
    expect(p.rects).toEqual([{ x: 0, y: 0, w: 100, h: 100 }]);
  });

  it("advances x by width+gutter for the next sprite on the same shelf", () => {
    const p = packSprites(
      [
        { w: 40, h: 40 },
        { w: 30, h: 30 },
      ],
      2,
      2048,
    );
    expect(p.rects[0]).toEqual({ x: 0, y: 0, w: 40, h: 40 });
    expect(p.rects[1]).toEqual({ x: 42, y: 0, w: 30, h: 30 });
  });

  it("escalates to the next pow2 atlas when a shelf would overflow the smaller size", () => {
    // two 42-wide cells: 84 > 64 so atlas 64 fails; 128 holds both on ONE shelf (y stays 0)
    const p = packSprites(
      [
        { w: 40, h: 40 },
        { w: 40, h: 40 },
      ],
      2,
      2048,
    );
    expect(p.atlas).toBe(128);
    expect(p.rects[1]).toEqual({ x: 42, y: 0, w: 40, h: 40 });
  });

  it("advances to a new shelf (y += rowH) when a row fills the chosen atlas width", () => {
    // 4 cells of 62x42 in atlas 128: 2 fit per row (x=0, x=62; 124+62=186 > 128 → wrap),
    // so #2 and #3 land on the second shelf at y=42. This exercises the y-advance path.
    const p = packSprites(
      [
        { w: 60, h: 40 },
        { w: 60, h: 40 },
        { w: 60, h: 40 },
        { w: 60, h: 40 },
      ],
      2,
      2048,
    );
    expect(p.atlas).toBe(128);
    expect(p.rects[2]).toEqual({ x: 0, y: 42, w: 60, h: 40 });
    expect(p.rects[3]).toEqual({ x: 62, y: 42, w: 60, h: 40 });
  });

  it("throws when the sprites cannot fit within maxAtlas", () => {
    expect(() => packSprites([{ w: 100, h: 100 }], 2, 64)).toThrow("sprite atlas over budget");
  });
});

describe("uvRect", () => {
  it("insets by half a texel on every side", () => {
    expect(uvRect({ x: 0, y: 0, w: 100, h: 100 }, 128)).toEqual([
      0.5 / 128,
      0.5 / 128,
      99 / 128,
      99 / 128,
    ]);
  });
});
