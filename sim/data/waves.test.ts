import { describe, expect, it } from "vitest";
import { waveDef } from "./waves";

const weight = (d: ReturnType<typeof waveDef>, type: string): number =>
  d.weights.find((e) => e.type === type)?.w ?? 0;

describe("waveDef", () => {
  it("wave 1 is walkers only", () => {
    const d = waveDef(1);
    expect(weight(d, "walker")).toBeCloseTo(8.4, 5); // 6 + 1*2.4
    expect(weight(d, "runner")).toBe(0);
    expect(weight(d, "brute")).toBe(0);
  });

  it("introduces runner weight at wave 2 and brute weight at wave 4", () => {
    expect(weight(waveDef(2), "runner")).toBeCloseTo(1.6, 5); // (2-1)*1.6
    expect(weight(waveDef(2), "brute")).toBe(0);
    expect(weight(waveDef(4), "brute")).toBe(1); // floor(4/3)
  });

  it("batch grows with the day number and squad size", () => {
    expect(waveDef(1).batch).toBe(1); // round((1 + floor(1/3)) * 1)
    expect(waveDef(6).batch).toBe(3); // round((1 + floor(6/3)) * 1) = 3
    expect(waveDef(1, 3).batch).toBe(2); // round(1 * (1 + 2*0.5)) = round(2)
  });

  it("interval tightens with the day number, clamped to a floor", () => {
    expect(waveDef(1).interval).toBeCloseTo(1.26, 5); // 1.3 - 1*0.04
    expect(waveDef(30).interval).toBe(0.45); // clamped
  });

  it("scales hp and speed with the day number", () => {
    const d = waveDef(10);
    expect(d.hpScale).toBeCloseTo(2.0, 5); // 1 + 10*0.10
    expect(d.spdScale).toBeCloseTo(1.15, 5); // 1 + 10*0.015
  });

  it("shifts composition toward tougher types with squad size", () => {
    // at players=1 the day-only weights are unchanged (regression guard)
    expect(weight(waveDef(4, 1), "runner")).toBeCloseTo(4.8, 5); // (4-1)*1.6
    // more players raises runner/brute weight relative to walker
    const solo = waveDef(4, 1);
    const party = waveDef(4, 6);
    const soloRunnerFrac = weight(solo, "runner") / weight(solo, "walker");
    const partyRunnerFrac = weight(party, "runner") / weight(party, "walker");
    expect(partyRunnerFrac).toBeGreaterThan(soloRunnerFrac);
  });

  it("adds a gentle sublinear hp/speed bump with squad size", () => {
    const solo = waveDef(10, 1);
    const party = waveDef(10, 6);
    expect(party.hpScale).toBeGreaterThan(solo.hpScale);
    expect(party.spdScale).toBeGreaterThanOrEqual(solo.spdScale);
    // sublinear: the 6-player bump is less than 5× a single-step bump (not linear in players)
    const perStep = waveDef(10, 2).hpScale - solo.hpScale;
    expect(party.hpScale - solo.hpScale).toBeLessThan(perStep * 5);
  });

  it("leaves batch scaling linear (unchanged)", () => {
    expect(waveDef(1, 3).batch).toBe(2); // round(1 * (1 + 2*0.5)) — regression guard
  });
});
