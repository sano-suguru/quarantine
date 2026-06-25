import { describe, expect, it } from "vitest";
import {
  circlePush,
  circlePushFromSegment,
  closestPointOnSegment,
  segmentHitsSegment,
} from "./geometry";

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

describe("circlePush", () => {
  it("returns null when circles do not overlap", () => {
    expect(circlePush(0, 0, 5, 20, 0, 5)).toBeNull();
  });
  it("pushes A out of B along the centre line", () => {
    // centres 6 apart, radii 5+5=10 → overlap 4, push +x
    const p = circlePush(6, 0, 5, 0, 0, 5);
    expect(p?.dx).toBeCloseTo(4);
    expect(p?.dy).toBeCloseTo(0);
  });
  it("after applying half to each the circles just touch", () => {
    const p = circlePush(6, 0, 5, 0, 0, 5);
    const ax = 6 + (p?.dx ?? 0) / 2;
    const bx = 0 - (p?.dx ?? 0) / 2;
    expect(Math.abs(ax - bx)).toBeCloseTo(10);
  });
  it("separates coincident circles along a fallback axis", () => {
    const p = circlePush(0, 0, 4, 0, 0, 4);
    expect(p).not.toBeNull();
    expect(Math.hypot(p?.dx ?? 0, p?.dy ?? 0)).toBeCloseTo(8);
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
