import { describe, expect, it } from "vitest";
import { inViewport, resolveAim, resolveHotbarSlot } from "./autoAim";

const ORDER = ["pistol", "smg", "shotgun", "rifle", "lmg", "magnum", "knife"];

describe("resolveAim", () => {
  it("uses the target angle when a target exists", () => {
    expect(resolveAim(1.2, 0, 0, 0.5)).toBe(1.2);
  });
  it("falls back to movement heading when no target", () => {
    expect(resolveAim(null, 1, 0, 9)).toBeCloseTo(0); // east
    expect(resolveAim(null, 0, 1, 9)).toBeCloseTo(Math.PI / 2); // south (+y)
  });
  it("holds the last heading when no target and idle", () => {
    expect(resolveAim(null, 0, 0, 2.34)).toBe(2.34);
  });
});

describe("inViewport", () => {
  it("accepts a point inside the rect", () => {
    expect(inViewport(10, 10, 0, 0, 100, 200, 0)).toBe(true);
  });
  it("rejects a point outside the horizontal half", () => {
    expect(inViewport(150, 0, 0, 0, 100, 200, 0)).toBe(false);
  });
  it("honors the margin", () => {
    expect(inViewport(110, 0, 0, 0, 100, 200, 20)).toBe(true);
  });
});

describe("resolveHotbarSlot", () => {
  it("maps a hotbar index to the absolute WEAPON_ORDER slot", () => {
    expect(resolveHotbarSlot(["smg", "magnum", "knife"], ORDER, 0)).toBe(1); // smg
    expect(resolveHotbarSlot(["smg", "magnum", "knife"], ORDER, 1)).toBe(5); // magnum
    expect(resolveHotbarSlot(["smg", "magnum", "knife"], ORDER, 2)).toBe(6); // knife
  });
  it("returns null for an empty hotbar index", () => {
    expect(resolveHotbarSlot(["smg"], ORDER, 2)).toBeNull();
  });
  it("returns null when the loadout id is not in order", () => {
    expect(resolveHotbarSlot(["ghost"], ORDER, 0)).toBeNull();
  });
});
