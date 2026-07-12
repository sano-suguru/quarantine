import { describe, expect, it } from "vitest";
import { gibsToSpawn, goreIntensity } from "./fx";

const DMG_REF = 90;
const LOW = 0.33;
const BONUS = 0.6;
const gi = (dmg: number, hpAfter: number, maxHp: number) =>
  goreIntensity(dmg, hpAfter, maxHp, DMG_REF, LOW, BONUS);

describe("goreIntensity", () => {
  it("a light hit on a healthy target is small (absolute-damage base only)", () => {
    expect(gi(10, 75, 85)).toBeCloseTo(10 / 90, 6); // ~0.111, finisher=0
    expect(gi(10, 75, 85)).toBeLessThan(0.2);
  });

  it("a heavy hit saturates to 1 even on a high-hp enemy not near death", () => {
    expect(gi(95, 165, 260)).toBe(1); // absScale clamps to 1, finisher=0
  });

  it("a killing blow gets the full finisher bonus even with small damage", () => {
    expect(gi(10, 0, 85)).toBeCloseTo(10 / 90 + BONUS, 6); // ~0.711
    expect(gi(10, -50, 85)).toBeCloseTo(10 / 90 + BONUS, 6); // overkill clamps hpAfter to 0
  });

  it("a near-lethal hit (left inside lowHpBand) ramps the finisher in", () => {
    // hpAfter=10/85=0.1176 fraction → finisher = 1 - 0.1176/0.33
    const finisher = 1 - 10 / 85 / LOW;
    expect(gi(20, 10, 85)).toBeCloseTo(20 / 90 + BONUS * finisher, 6); // ~0.608
    expect(gi(20, 10, 85)).toBeGreaterThan(0.5);
  });

  it("at exactly lowHpBand the finisher is zero (no bonus yet)", () => {
    expect(gi(0, 33, 100)).toBe(0); // frac=0.33 → 1 - 0.33/0.33 = 0
  });

  it("clamps to [0,1]", () => {
    expect(gi(500, -5, 100)).toBe(1);
    expect(gi(0, 100, 100)).toBe(0);
  });

  it("host (dmg) and client (hpDelta) inputs agree for integer hp", () => {
    // client re-derives hpDelta = prev.hp - next.hp; for integer hp this equals dmg
    const prevHp = 85;
    const nextHp = 72;
    expect(gi(13, nextHp, 85)).toBe(gi(prevHp - nextHp, nextHp, 85));
  });
});

describe("gibsToSpawn", () => {
  // signature: (intensity, fillRatio, threshold=0.5, min=2, max=7, fillCap=0.85)
  it("emits nothing below the intensity threshold", () => {
    expect(gibsToSpawn(0.4, 0, 0.5, 2, 7, 0.85)).toBe(0);
  });

  it("emits nothing once the particle buffer is past the fill cap", () => {
    expect(gibsToSpawn(1, 0.9, 0.5, 2, 7, 0.85)).toBe(0);
  });

  it("emits the full count at max intensity with an empty buffer", () => {
    expect(gibsToSpawn(1, 0, 0.5, 2, 7, 0.85)).toBe(7);
  });

  it("at exactly the threshold it still emits (lerped)", () => {
    expect(gibsToSpawn(0.5, 0, 0.5, 2, 7, 0.85)).toBe(5); // round(lerp(2,7,0.5)=4.5)=5
  });

  it("throttles the count down as the buffer fills", () => {
    expect(gibsToSpawn(1, 0.5, 0.5, 2, 7, 0.85)).toBe(4); // round(7 * 0.5 = 3.5) = 4
  });
});
