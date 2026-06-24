import { describe, expect, it } from "vitest";
import { flashlightIntensity } from "./flashlight";

describe("flashlightIntensity", () => {
  it("is full strength with a healthy battery", () => {
    expect(flashlightIntensity(0.8, true, 0.25, 0.4, 0.5)).toBe(1);
  });

  it("is zero when switched off", () => {
    expect(flashlightIntensity(0.8, false, 0.25, 0.4, 0.5)).toBe(0);
  });

  it("is zero with a dead battery", () => {
    expect(flashlightIntensity(0, true, 0.25, 0.4, 0.5)).toBe(0);
  });

  it("flickers below the low threshold", () => {
    // 1 - 0.4 * 0.5 = 0.8
    expect(flashlightIntensity(0.1, true, 0.25, 0.4, 0.5)).toBeCloseTo(0.8);
  });

  it("never returns below zero on a deep flicker dip", () => {
    expect(flashlightIntensity(0.05, true, 0.25, 2, 1)).toBe(0);
  });
});
