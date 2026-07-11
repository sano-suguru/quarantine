import { afterEach, describe, expect, it, vi } from "vitest";
import { approach, clamp, len, lerp, mixRGB, rand } from "./math";

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

describe("lerp", () => {
  it("returns the start when t is 0", () => {
    expect(lerp(2, 8, 0)).toBe(2);
  });
  it("returns the end when t is 1", () => {
    expect(lerp(2, 8, 1)).toBe(8);
  });
  it("returns the midpoint when t is 0.5", () => {
    expect(lerp(2, 8, 0.5)).toBe(5);
  });
});

describe("mixRGB", () => {
  it("returns the first color when t is 0", () => {
    expect(mixRGB([0.2, 0.4, 0.6], [1, 0.55, 0.2], 0)).toEqual([0.2, 0.4, 0.6]);
  });
  it("returns the second color when t is 1", () => {
    expect(mixRGB([0.2, 0.4, 0.6], [1, 0.55, 0.2], 1)).toEqual([1, 0.55, 0.2]);
  });
  it("blends each channel halfway at t 0.5 (matches the old (a+b)*0.5 ember idiom)", () => {
    const [r, g, b] = mixRGB([0.2, 0.4, 0.6], [1, 0.55, 0.2], 0.5);
    expect(r).toBeCloseTo(0.6, 6);
    expect(g).toBeCloseTo(0.475, 6);
    expect(b).toBeCloseTo(0.4, 6);
  });
});

describe("approach", () => {
  it("steps toward the target by maxStep", () => {
    expect(approach(0, 1, 0.25)).toBeCloseTo(0.25, 6);
    expect(approach(1, 0, 0.25)).toBeCloseTo(0.75, 6);
  });
  it("never overshoots — snaps to target when the step exceeds the gap (huge dt safe)", () => {
    expect(approach(0.9, 1, 100)).toBe(1);
    expect(approach(1.1, 0.5, 100)).toBe(0.5);
  });
  it("is a no-op when already at target", () => {
    expect(approach(0.7, 0.7, 0.25)).toBe(0.7);
  });
});
