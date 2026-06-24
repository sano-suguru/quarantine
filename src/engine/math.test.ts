import { afterEach, describe, expect, it, vi } from "vitest";
import { clamp, len, rand } from "./math";

describe("clamp", () => {
  it("returns the value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps to the lower bound", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });
  it("clamps to the upper bound", () => {
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("len", () => {
  it("computes a 3-4-5 hypotenuse", () => {
    expect(len(3, 4)).toBe(5);
  });
  it("is zero at the origin", () => {
    expect(len(0, 0)).toBe(0);
  });
});

describe("rand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the lower bound when Math.random() is 0", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(rand(2, 8)).toBe(2);
  });
  it("returns the midpoint when Math.random() is 0.5", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(rand(2, 8)).toBe(5);
  });
  it("approaches the upper bound as Math.random() approaches 1", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999999);
    expect(rand(2, 8)).toBeCloseTo(8, 4);
  });
});
