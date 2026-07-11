import { describe, expect, it } from "vitest";
import { phaseMods } from "./phaseMods";

describe("phaseMods", () => {
  it("day zombies are sluggish, short-sighted, non-lunging, non-aggro", () => {
    const m = phaseMods("day", 1);
    expect(m.speedMul).toBeLessThan(1);
    expect(m.senseMul).toBeLessThan(1);
    expect(m.lunge).toBe(false);
    expect(m.autoAggro).toBe(false);
    expect(m.wanderMul).toBeGreaterThan(1);
  });

  it("night zombies are at least base-speed, wide-sensed, lunging, auto-aggro", () => {
    const m = phaseMods("night", 1);
    expect(m.speedMul).toBeGreaterThanOrEqual(1);
    expect(m.senseMul).toBeGreaterThanOrEqual(1);
    expect(m.lunge).toBe(true);
    expect(m.autoAggro).toBe(true);
  });

  it("night ferocity ramps with the day number", () => {
    expect(phaseMods("night", 6).speedMul).toBeGreaterThan(phaseMods("night", 1).speedMul);
  });

  it("day ferocity does not ramp with the day number", () => {
    expect(phaseMods("day", 6).speedMul).toBe(phaseMods("day", 1).speedMul);
  });
});
