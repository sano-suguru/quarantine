import { describe, expect, it } from "vitest";
import { SpatialHash } from "./spatialHash";

const collect = (h: SpatialHash, x: number, y: number, r: number): number[] => {
  const out: number[] = [];
  h.query(x, y, r, (i) => out.push(i));
  return out.sort((a, b) => a - b);
};

describe("SpatialHash", () => {
  it("finds an item inserted within the query radius", () => {
    const h = new SpatialHash(64);
    h.insert(0, 10, 10);
    expect(collect(h, 10, 10, 5)).toContain(0);
  });

  it("does not return items in cells outside the query window", () => {
    const h = new SpatialHash(64);
    h.insert(0, 0, 0);
    h.insert(1, 500, 500);
    // querying near the origin must not pick up the far item
    expect(collect(h, 0, 0, 10)).toEqual([0]);
  });

  it("returns nothing after clear()", () => {
    const h = new SpatialHash(64);
    h.insert(0, 10, 10);
    h.clear();
    expect(collect(h, 10, 10, 5)).toEqual([]);
  });

  it("picks up items across a cell boundary when the radius spans it", () => {
    const h = new SpatialHash(64);
    h.insert(0, 60, 10); // cell (0,0)
    h.insert(1, 70, 10); // cell (1,0)
    // a query straddling x=64 with enough radius sees both cells
    expect(collect(h, 64, 10, 8)).toEqual([0, 1]);
  });

  it("reports the same index multiple times only if inserted multiple times", () => {
    const h = new SpatialHash(64);
    h.insert(0, 10, 10);
    h.insert(1, 12, 12);
    expect(collect(h, 11, 11, 5)).toEqual([0, 1]);
  });
});
