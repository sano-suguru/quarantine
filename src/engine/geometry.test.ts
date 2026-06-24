import { describe, expect, it } from "vitest";
import { circlePushFromSegment, closestPointOnSegment, segmentHitsSegment } from "./geometry";

describe("closestPointOnSegment", () => {
  it("projects onto the interior of the segment", () => {
    expect(closestPointOnSegment(5, 5, 0, 0, 10, 0)).toEqual({ x: 5, y: 0 });
  });
  it("clamps past the end to the endpoint", () => {
    expect(closestPointOnSegment(20, 5, 0, 0, 10, 0)).toEqual({ x: 10, y: 0 });
  });
  it("handles a degenerate (point) segment", () => {
    expect(closestPointOnSegment(3, 4, 1, 1, 1, 1)).toEqual({ x: 1, y: 1 });
  });
});

describe("circlePushFromSegment", () => {
  const seg = { x1: 0, y1: 0, x2: 10, y2: 0 };

  it("returns null when the circle does not reach the segment", () => {
    expect(circlePushFromSegment(5, 5, 4, seg)).toBeNull();
  });

  it("pushes a penetrating circle out along the normal", () => {
    const p = circlePushFromSegment(5, 2, 5, seg);
    expect(p).not.toBeNull();
    expect(p?.dx).toBeCloseTo(0);
    expect(p?.dy).toBeCloseTo(3); // r 5 - distance 2, pushed +y
  });

  it("after applying the push the circle no longer overlaps", () => {
    const p = circlePushFromSegment(5, 2, 5, seg);
    const ny = 2 + (p?.dy ?? 0);
    expect(Math.abs(ny)).toBeGreaterThanOrEqual(5 - 1e-6);
  });
});

describe("segmentHitsSegment", () => {
  it("detects a clean crossing", () => {
    expect(segmentHitsSegment(0, 0, 10, 10, 0, 10, 10, 0)).toBe(true);
  });
  it("returns false for non-crossing segments", () => {
    expect(segmentHitsSegment(0, 0, 1, 0, 0, 5, 1, 5)).toBe(false);
  });
  it("detects a T-touch", () => {
    expect(segmentHitsSegment(0, 0, 10, 0, 5, 0, 5, 5)).toBe(true);
  });
});
