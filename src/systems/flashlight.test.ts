import { describe, expect, it } from "vitest";
import { flashlightIntensity } from "./flashlight";

describe("flashlightIntensity", () => {
  it("is full strength with a healthy battery at the flicker trough (noise 0)", () => {
    expect(flashlightIntensity(0.8, true, 0.25, 0.4, 0.04, 0)).toBe(1);
  });

  it("flickers subtly even with a healthy battery", () => {
    // 1 - 0.04 * 1 = 0.96 (constant base flicker, not the deep low-battery dip)
    expect(flashlightIntensity(0.8, true, 0.25, 0.4, 0.04, 1)).toBeCloseTo(0.96);
  });

  it("is zero when switched off", () => {
    expect(flashlightIntensity(0.8, false, 0.25, 0.4, 0.04, 0.5)).toBe(0);
  });

  it("is zero with a dead battery", () => {
    expect(flashlightIntensity(0, true, 0.25, 0.4, 0.04, 0.5)).toBe(0);
  });

  it("flickers deeper below the low threshold", () => {
    // 1 - 0.4 * 0.5 = 0.8 (uses flickerDepth, not baseFlickerDepth)
    expect(flashlightIntensity(0.1, true, 0.25, 0.4, 0.04, 0.5)).toBeCloseTo(0.8);
  });

  it("never returns below zero on a deep flicker dip", () => {
    expect(flashlightIntensity(0.05, true, 0.25, 2, 0.04, 1)).toBe(0);
  });
});
