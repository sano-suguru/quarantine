import { describe, expect, it } from "vitest";
import { cellOffset, packFragCell, unpackFragCell } from "./fragment";

describe("fragCell pack/unpack", () => {
  it("packs cell (0,0) to 1 (0 is reserved for whole-sprite)", () => {
    expect(packFragCell(0, 0, 4)).toBe(1);
  });
  it("round-trips every cell of a 4x4 grid", () => {
    for (let cy = 0; cy < 4; cy++)
      for (let cx = 0; cx < 4; cx++) {
        const p = packFragCell(cx, cy, 4);
        expect(unpackFragCell(p, 4)).toEqual({ cx, cy });
      }
  });
  it("max cell of a 4x4 grid stays small (mediump-safe)", () => {
    expect(packFragCell(3, 3, 4)).toBe(16); // <= 17, safe for fp16
  });
});

describe("cellOffset (Y-flip matches shader 0.5 - v_local.y)", () => {
  it("top row (cy=0) is on the POSITIVE local-Y side", () => {
    // shader: atlas row 0 (PNG top) maps to +v_local.y side → cellOffset.ly must be positive for cy=0
    expect(cellOffset(0, 0, 4, 100).ly).toBeGreaterThan(0);
  });
  it("bottom row (cy=gridN-1) is on the NEGATIVE local-Y side", () => {
    expect(cellOffset(0, 3, 4, 100).ly).toBeLessThan(0);
  });
  it("left column negative X, right column positive X", () => {
    expect(cellOffset(0, 0, 4, 100).lx).toBeLessThan(0);
    expect(cellOffset(3, 0, 4, 100).lx).toBeGreaterThan(0);
  });
  it("center of an even grid is offset half a cell from origin (no cell sits exactly at center)", () => {
    // cx=2 of N=4 → ((2+0.5)/4 - 0.5)*100 = 12.5
    expect(cellOffset(2, 0, 4, 100).lx).toBeCloseTo(12.5, 5);
  });
});
