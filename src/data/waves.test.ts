import { describe, expect, it } from "vitest";
import { waveDef } from "./waves";

const count = (xs: string[], v: string): number => xs.filter((x) => x === v).length;

describe("waveDef", () => {
  it("wave 1 has only walkers (no runners or brutes)", () => {
    const d = waveDef(1);
    expect(count(d.spawn, "walker")).toBe(8); // round(6 + 1*2.4) = round(8.4)
    expect(count(d.spawn, "runner")).toBe(0);
    expect(count(d.spawn, "brute")).toBe(0);
    expect(d.spawn.length).toBe(8);
  });

  it("introduces runners at wave 2", () => {
    const d = waveDef(2);
    expect(count(d.spawn, "walker")).toBe(11); // round(6 + 2*2.4) = round(10.8)
    expect(count(d.spawn, "runner")).toBe(2); // round((2-1)*1.6) = round(1.6)
    expect(count(d.spawn, "brute")).toBe(0);
  });

  it("introduces brutes at wave 4", () => {
    const d = waveDef(4);
    expect(count(d.spawn, "walker")).toBe(16); // round(6 + 4*2.4) = round(15.6)
    expect(count(d.spawn, "runner")).toBe(5); // round((4-1)*1.6) = round(4.8)
    expect(count(d.spawn, "brute")).toBe(1); // floor(4/3)
  });

  it("scales hp and speed with wave number", () => {
    const d = waveDef(10);
    expect(d.hpScale).toBeCloseTo(1.6, 5); // 1 + 10*0.06
    expect(d.spdScale).toBeCloseTo(1.15, 5); // 1 + 10*0.015
  });

  it("clamps the spawn interval to a 0.18 floor at high waves", () => {
    expect(waveDef(5).interval).toBeCloseTo(0.55, 5); // 0.7 - 5*0.03
    expect(waveDef(30).interval).toBe(0.18); // 0.7 - 0.9 < 0.18 → clamped
  });
});
