import { describe, expect, it } from "vitest";
import { ammoTransfer } from "./ammo";

describe("ammoTransfer", () => {
  it("tops the magazine fully when reserve is plentiful", () => {
    expect(ammoTransfer(12, 3, 36)).toEqual({ ammo: 12, reserve: 27 });
  });

  it("takes only what the reserve has when reserve is short", () => {
    expect(ammoTransfer(12, 0, 5)).toEqual({ ammo: 5, reserve: 0 });
  });

  it("is a no-op when the magazine is already full", () => {
    expect(ammoTransfer(12, 12, 36)).toEqual({ ammo: 12, reserve: 36 });
  });

  it("does nothing with an empty reserve", () => {
    expect(ammoTransfer(12, 4, 0)).toEqual({ ammo: 4, reserve: 0 });
  });

  it("never produces negative reserve when ammo exceeds mag", () => {
    expect(ammoTransfer(6, 8, 10)).toEqual({ ammo: 8, reserve: 10 });
  });
});
