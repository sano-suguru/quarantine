import { describe, expect, it } from "vitest";
import type { Segment } from "../types";
import { avoidHeading } from "./steering";

const opts = { look: 40, whiskerAngle: 0.6, strength: 1 };

describe("avoidHeading", () => {
  it("passes through unchanged when no wall is ahead", () => {
    const r = avoidHeading(0, 0, 1, 0, [], opts);
    expect(r.hx).toBeCloseTo(1);
    expect(r.hy).toBeCloseTo(0);
  });

  it("steers away from a wall directly ahead", () => {
    // vertical wall at x=30 blocking rightward travel
    const wall: Segment = { x1: 30, y1: -50, x2: 30, y2: 50 };
    const r = avoidHeading(0, 0, 1, 0, [wall], opts);
    // heading should gain a vertical component (turn along the wall), not stay pure +x
    expect(Math.abs(r.hy)).toBeGreaterThan(0.2);
    const len = Math.hypot(r.hx, r.hy);
    expect(len).toBeCloseTo(1, 1); // returned heading is normalized
  });
});
