import { describe, expect, it } from "vitest";
import { phantomRateScale } from "./stalkerPhantom";

describe("phantomRateScale", () => {
  it("is 1 at zero dread (the quiet → max fake rate)", () => {
    expect(phantomRateScale(0, 1.5)).toBeCloseTo(1, 6);
  });
  it("is 0 at full dread (real approach → fakes suppressed)", () => {
    expect(phantomRateScale(1, 1.5)).toBeCloseTo(0, 6);
  });
  it("with exp=1 falls off linearly", () => {
    expect(phantomRateScale(0.25, 1)).toBeCloseTo(0.75, 6);
  });
  it("clamps out-of-range dread", () => {
    expect(phantomRateScale(-0.5, 1.5)).toBeCloseTo(1, 6);
    expect(phantomRateScale(2, 1.5)).toBeCloseTo(0, 6);
  });
  it("is monotonically non-increasing in dread", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let d = 0; d <= 1.0001; d += 0.1) {
      const v = phantomRateScale(d, 1.5);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });
});
