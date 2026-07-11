import { describe, expect, it } from "vitest";
import { effWeapon } from "../data/arsenal";
import { localPlayer } from "../engine/players";
import { newState } from "../state";
import { applyFireFeel } from "./feel";

describe("applyFireFeel", () => {
  it("pushes a muzzle event and applies recoil (no direct audio)", () => {
    const s = newState();
    const p = localPlayer(s);
    applyFireFeel(s, p, effWeapon(p, p.weapon));
    expect(s.fxEvents.some((e) => e.t === "muzzle")).toBe(true);
    expect(p.muzzle).toBeGreaterThan(0); // state mutation preserved
  });
});
