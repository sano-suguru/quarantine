import { describe, expect, it } from "vitest";
import { newState } from "../../sim/state";
import { phantomStepLocked, resetStalkerFx, stalkerFx } from "./stalkerFx";
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

describe("stalkerFx phantom-step lockout", () => {
  it("is not locked after reset", () => {
    resetStalkerFx();
    expect(phantomStepLocked(0)).toBe(false);
    expect(phantomStepLocked(100)).toBe(false);
  });

  it("locks right after a real footfall fires, then expires", () => {
    const s = newState();
    s.phase = "night";
    // Close + unlit ⇒ dread≈1 ⇒ stalkerFx fires a footfall on the first call (footfallT starts at 0).
    s.stalker = { x: 30, y: 0, face: 0, state: "aggro", staggerT: 0, contactCd: 0, vis: 1 };
    const lp = s.players[0];
    if (!lp) throw new Error("no local player");
    lp.battery = 0; // dead battery ⇒ intensity 0 ⇒ stalker is "unlit" from the local player
    resetStalkerFx();
    stalkerFx(s, lp, 1); // ddt=1 ⇒ footfallT ≤ 0 ⇒ footfall fires ⇒ lockout set at now=s.time (0)
    expect(phantomStepLocked(s.time)).toBe(true); // within the 0.6s window
    expect(phantomStepLocked(s.time + 5)).toBe(false); // well past the window
  });
});
