import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { newState } from "../state";
import type { Player, State } from "../types";
import { UPGRADES } from "./upgrades";
import { WEAPONS, WEAPON_ORDER } from "./weapons";

const byName = (name: string) => {
  const u = UPGRADES.find((x) => x.name === name);
  if (!u) throw new Error(`no such upgrade: ${name}`);
  return u;
};

/** Fresh run-state + the player who buys the perk. */
function setup(): { s: State; p: Player } {
  const s = newState();
  return { s, p: s.players[0] as Player };
}

describe("UPGRADES apply()", () => {
  it("Field Medic: +20 maxHp and +1 medkit (clamped to max)", () => {
    const { s, p } = setup();
    p.maxHp = 100;
    p.medkits = 0;
    byName("Field Medic").apply(s, p);
    expect(p.maxHp).toBe(120);
    expect(p.medkits).toBe(1);

    // medkit count clamps at CONFIG.heal.maxMedkits
    p.medkits = CONFIG.heal.maxMedkits;
    byName("Field Medic").apply(s, p);
    expect(p.medkits).toBe(CONFIG.heal.maxMedkits);
  });

  it("Hollow Points: ×1.25 shared damage multiplier", () => {
    const { s, p } = setup();
    s.dmgMul = 1;
    byName("Hollow Points").apply(s, p);
    expect(s.dmgMul).toBeCloseTo(1.25);
  });

  it("Adrenaline: ×1.12 personal speed", () => {
    const { s, p } = setup();
    p.speed = 200;
    byName("Adrenaline").apply(s, p);
    expect(p.speed).toBeCloseTo(224);
  });

  it("Quick Hands: ×1.3 shared fire-rate multiplier", () => {
    const { s, p } = setup();
    s.fireRateMul = 1;
    byName("Quick Hands").apply(s, p);
    expect(s.fireRateMul).toBeCloseTo(1.3);
  });

  it("First Aid Cache: +2 medkits (clamped to max)", () => {
    const { s, p } = setup();
    p.medkits = 0;
    byName("First Aid Cache").apply(s, p);
    expect(p.medkits).toBe(2);

    p.medkits = CONFIG.heal.maxMedkits - 1;
    byName("First Aid Cache").apply(s, p);
    expect(p.medkits).toBe(CONFIG.heal.maxMedkits);
  });

  it("Bandolier: ×1.5 reserveMul and refills every non-melee gun to the new cap", () => {
    const { s, p } = setup();
    s.reserveMul = 1;
    byName("Bandolier").apply(s, p);
    expect(s.reserveMul).toBeCloseTo(1.5);
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      if (!w) continue;
      if (w.melee) {
        // melee guns are skipped: knife reserve stays at its starter value
        expect(p.reserve[id]).toBe(w.reserveStart);
      } else {
        expect(p.reserve[id]).toBe(Math.round(w.reserveMax * 1.5));
      }
    }
  });

  it("Scavenger: tops off every non-melee gun's reserve+mags and the held weapon's mag", () => {
    const { s, p } = setup();
    p.weapon = "smg";
    p.ammo = 0;
    for (const id of WEAPON_ORDER) {
      p.reserve[id] = 0;
      p.mags[id] = 0;
    }
    byName("Scavenger").apply(s, p);
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      if (!w || w.melee) continue;
      expect(p.reserve[id]).toBe(Math.round(w.reserveMax * s.reserveMul));
      expect(p.mags[id]).toBe(w.mag);
    }
    // held weapon's loaded magazine is filled to its capacity
    expect(p.ammo).toBe(WEAPONS.smg?.mag);
  });
});

describe("UPGRADES preview()", () => {
  it("every upgrade renders a non-empty preview string from state", () => {
    const { s, p } = setup();
    for (const u of UPGRADES) {
      expect(u.preview).toBeDefined();
      const txt = u.preview?.(s, p);
      expect(typeof txt).toBe("string");
      expect((txt ?? "").length).toBeGreaterThan(0);
    }
  });
});
