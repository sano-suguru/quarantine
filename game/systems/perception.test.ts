import { describe, expect, it } from "vitest";
import type { Segment } from "../types";
import { hasLineOfSight, heard } from "./perception";

describe("perception", () => {
  it("has LOS across open space", () => {
    expect(hasLineOfSight(0, 0, 100, 0, [])).toBe(true);
  });
  it("loses LOS through a wall", () => {
    const wall: Segment = { x1: 50, y1: -50, x2: 50, y2: 50 };
    expect(hasLineOfSight(0, 0, 100, 0, [wall])).toBe(false);
  });
  it("keeps LOS when the wall is off to the side", () => {
    const wall: Segment = { x1: 50, y1: 40, x2: 50, y2: 90 };
    expect(hasLineOfSight(0, 0, 100, 0, [wall])).toBe(true);
  });
  it("hears within the noise radius, not beyond", () => {
    expect(heard(0, 0, 120, 100, 0)).toBe(true);
    expect(heard(0, 0, 120, 200, 0)).toBe(false);
  });
  it("hearing is LOS-independent (heard through a wall)", () => {
    // heard() takes no walls: noise carries through walls by design (that's the point of hearing).
    expect(heard(0, 0, 150, 100, 0)).toBe(true);
  });
});
