import { describe, expect, it } from "vitest";
import { integrityGrade } from "./integrity";

// Signature: (hpFrac, onset, gamma) → 0 at/above onset (full color) .. 1 at hp 0 (death)
describe("integrityGrade", () => {
  it("is 0 (full color) at and above the onset", () => {
    expect(integrityGrade(0.65, 0.65, 0.7)).toBe(0);
    expect(integrityGrade(0.8, 0.65, 0.7)).toBe(0);
    expect(integrityGrade(1, 0.65, 0.7)).toBe(0);
  });

  it("is 1 (max drain) at zero HP", () => {
    expect(integrityGrade(0, 0.65, 0.7)).toBe(1);
  });

  it("clamps to 1 for negative HP (overkill)", () => {
    expect(integrityGrade(-0.2, 0.65, 0.7)).toBe(1);
  });

  it("is linear when gamma is 1", () => {
    // (0.65 - 0.5) / 0.65 = 0.230769
    expect(integrityGrade(0.5, 0.65, 1)).toBeCloseTo(0.230769, 5);
  });

  it("front-loads (sits above linear mid-band) when gamma < 1", () => {
    expect(integrityGrade(0.5, 0.65, 0.7)).toBeGreaterThan(integrityGrade(0.5, 0.65, 1));
    // 0.230769 ** 0.7 ≈ 0.3583
    expect(integrityGrade(0.5, 0.65, 0.7)).toBeCloseTo(0.3583, 3);
  });

  it("rises monotonically as HP drops across the band", () => {
    const g60 = integrityGrade(0.6, 0.65, 0.7);
    const g40 = integrityGrade(0.4, 0.65, 0.7);
    const g10 = integrityGrade(0.1, 0.65, 0.7);
    expect(g40).toBeGreaterThan(g60);
    expect(g10).toBeGreaterThan(g40);
  });
});
