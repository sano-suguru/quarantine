import { describe, expect, it } from "vitest";
import type { Segment } from "../types";
import { buildFlowField, sampleFlow } from "./navfield";

const bounds = { minX: -200, minY: -200, maxX: 200, maxY: 200 };

describe("flow field", () => {
  it("points straight at the target in open space", () => {
    const f = buildFlowField([], [{ x: 100, y: 0 }], bounds, 20, 10);
    const g = sampleFlow(f, -100, 0);
    expect(g.hx).toBeGreaterThan(0.7); // mostly +x toward target
    expect(Math.abs(g.hy)).toBeLessThan(0.3);
  });

  it("routes around a wall instead of into it (gradient not straight through)", () => {
    // vertical wall between sampler and target, with a gap at the top
    const walls: Segment[] = [{ x1: 0, y1: -200, x2: 0, y2: 60 }];
    const f = buildFlowField(walls, [{ x: 120, y: 0 }], bounds, 20, 8);
    const g = sampleFlow(f, -120, 0);
    // must gain a +y component to head for the gap, not point straight +x into the wall
    expect(g.hy).toBeGreaterThan(0.1);
  });

  it("passes through a 60px opening (walkable cells exist in the gap)", () => {
    // wall along x=0 with a 60px gap centered at y=0
    const walls: Segment[] = [
      { x1: 0, y1: -200, x2: 0, y2: -30 },
      { x1: 0, y1: 30, x2: 0, y2: 200 },
    ];
    const f = buildFlowField(walls, [{ x: 120, y: 0 }], bounds, 15, 6);
    const g = sampleFlow(f, -120, 0);
    expect(g.hx).toBeGreaterThan(0.3); // reaches target through the gap
  });

  it("passes a 60px door at PRODUCTION cell/clearance (guards phase-dependence)", () => {
    // Same 60px gap, but at the values the game actually ships (Task 5 config).
    // With cell=24, clearance=14 the walkable band is ±(30-14)=±16 (32px) > cell 24,
    // so a walkable cell column through the gap is guaranteed regardless of grid phase.
    const walls: Segment[] = [
      { x1: 0, y1: -200, x2: 0, y2: -30 },
      { x1: 0, y1: 30, x2: 0, y2: 200 },
    ];
    const f = buildFlowField(walls, [{ x: 120, y: 0 }], bounds, 24, 14);
    const g = sampleFlow(f, -120, 0);
    expect(g.hx).toBeGreaterThan(0.3);
  });
});
