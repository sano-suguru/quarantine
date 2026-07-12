import { describe, expect, it } from "vitest";
import { flashlightIntensity } from "./flashlight";

// Signature: (batteryFrac, lowThreshold, flickerDepth, baseFlickerDepth, noise, dimFloor, dimStart)
describe("flashlightIntensity", () => {
  it("is full strength with a healthy battery at the flicker trough (noise 0)", () => {
    // charge 0.8 >= dimStart 0.6 → base 1.0; no flicker dip at noise 0
    expect(flashlightIntensity(0.8, 0.25, 0.4, 0.04, 0, 0.45, 0.6)).toBe(1);
  });

  it("flickers subtly even with a healthy battery", () => {
    // base 1.0 - 0.04 * 1 = 0.96 (constant base flicker, not the deep low dip)
    expect(flashlightIntensity(0.8, 0.25, 0.4, 0.04, 1, 0.45, 0.6)).toBeCloseTo(0.96);
  });

  it("is zero with a dead battery", () => {
    expect(flashlightIntensity(0, 0.25, 0.4, 0.04, 0.5, 0.45, 0.6)).toBe(0);
  });

  it("stays full-bright at or above dimStart", () => {
    // charge 0.6 == dimStart → t 1 → base 1.0
    expect(flashlightIntensity(0.6, 0.25, 0.4, 0.04, 0, 0.45, 0.6)).toBe(1);
  });

  it("dims continuously as the battery drains below dimStart (noise 0 isolates base)", () => {
    // charge 0.45 → t 0.75 → base 0.45 + 0.55*0.75 = 0.8625
    expect(flashlightIntensity(0.45, 0.25, 0.4, 0.04, 0, 0.45, 0.6)).toBeCloseTo(0.8625, 3);
  });

  it("keeps the steady level at/above dimFloor near empty (battery > 0, noise 0)", () => {
    // charge 0.02 → t 0.0333 → base 0.45 + 0.55*0.0333 = 0.46833 (>= dimFloor 0.45)
    expect(flashlightIntensity(0.02, 0.25, 0.4, 0.04, 0, 0.45, 0.6)).toBeCloseTo(0.46833, 4);
  });

  it("is monotonically non-increasing as charge falls (steady, noise 0)", () => {
    const at = (c: number) => flashlightIntensity(c, 0.25, 0.4, 0.04, 0, 0.45, 0.6);
    expect(at(0.5)).toBeGreaterThanOrEqual(at(0.3));
    expect(at(0.3)).toBeGreaterThanOrEqual(at(0.1));
  });

  it("the deep low-battery flicker still dips well below the steady level (dying bulb)", () => {
    // charge 0.1 → base 0.45 + 0.55*(0.1/0.6) = 0.541667; deep flicker 0.4*1 → 0.141667
    expect(flashlightIntensity(0.1, 0.25, 0.4, 0.04, 1, 0.45, 0.6)).toBeCloseTo(0.141667, 4);
    // but at the trough (noise 0) the steady level is back up at base, still usable
    expect(flashlightIntensity(0.1, 0.25, 0.4, 0.04, 0, 0.45, 0.6)).toBeCloseTo(0.541667, 4);
  });

  it("never returns below zero on a deep flicker dip", () => {
    expect(flashlightIntensity(0.05, 0.25, 2, 0.04, 1, 0.45, 0.6)).toBe(0);
  });
});
