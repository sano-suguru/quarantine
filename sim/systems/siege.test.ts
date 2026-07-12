import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { newState } from "../state";
import {
  ambientForClock,
  clockFrac,
  clockLabel,
  nightDuration,
  nightMaxZombies,
  startDay,
  startNight,
  sysSiege,
} from "./siege";

// Guardrail: siege seeds roamers via spawnZombie (RNG positions), so we assert only the
// DETERMINISTIC surface — phase, timers, return values, and zombie *counts* — never the
// RNG-derived coordinates/wobble of the spawned bodies.

describe("startDay", () => {
  it("enters the lit day phase, resets the timer, and seeds the roamer count", () => {
    const s = newState();
    s.phase = "night";
    s.phaseT = 0;
    s.zombies = [];
    startDay(s);
    expect(s.phase).toBe("day");
    expect(s.phaseT).toBe(CONFIG.siege.dayDuration);
    expect(s.zombies.length).toBe(CONFIG.siege.roamersPerDay);
  });

  it("restocks every cache to unsearched", () => {
    const s = newState();
    for (const c of s.caches) {
      c.looted = true;
      c.searchT = 1;
    }
    startDay(s);
    expect(s.caches.every((c) => !c.looted && c.searchT === 0)).toBe(true);
  });
});

describe("startNight", () => {
  it("enters the night phase, arms a wave, and starts the night clock", () => {
    const s = newState();
    s.day = 3;
    startNight(s);
    expect(s.phase).toBe("night");
    expect(s.wave.n).toBe(3);
    expect(s.wave.def).not.toBeNull();
    expect(s.phaseT).toBe(nightDuration(3));
  });
});

describe("sysSiege", () => {
  it("returns null while the day timer is still running", () => {
    const s = newState();
    startDay(s);
    expect(sysSiege(s, 1)).toBeNull();
    expect(s.phase).toBe("day");
  });

  it("returns 'night' on the frame the day timer expires", () => {
    const s = newState();
    startDay(s);
    s.phaseT = 0.5;
    expect(sysSiege(s, 1)).toBe("night");
    expect(s.phase).toBe("night");
  });

  it("returns 'dawn' on the frame the night clock expires, even with zombies alive", () => {
    const s = newState();
    startNight(s);
    s.phaseT = 0.5;
    s.zombies = [{ id: 1 } as (typeof s.zombies)[number]]; // survivors remain — dawn still comes
    expect(sysSiege(s, 1)).toBe("dawn");
  });

  it("returns null at night while the clock is still running", () => {
    const s = newState();
    startNight(s); // phaseT = nightDuration(day) >> dt
    expect(sysSiege(s, 1)).toBeNull();
    expect(s.phase).toBe("night");
  });

  it("dawns at night's end with no held-night re-arm", () => {
    const s = newState();
    startNight(s);
    s.phaseT = 0.5;
    expect(sysSiege(s, 1)).toBe("dawn"); // no heldNight flag exists to re-arm the clock
  });
});

describe("nightDuration", () => {
  it("day 1 is the base duration", () => {
    expect(nightDuration(1)).toBe(55);
  });
  it("ramps with the day number", () => {
    expect(nightDuration(2)).toBe(63); // 55 + 1*8
    expect(nightDuration(5)).toBe(87); // 55 + 4*8
  });
  it("clamps to the max", () => {
    expect(nightDuration(100)).toBe(150);
  });
});

describe("nightMaxZombies", () => {
  it("day 1 is the base cap and ramps to the ceiling", () => {
    expect(nightMaxZombies(1)).toBe(45);
    expect(nightMaxZombies(2)).toBe(50); // 45 + 1*5
    expect(nightMaxZombies(10)).toBe(90); // 45 + 9*5, clamped at 90
    expect(nightMaxZombies(100)).toBe(90);
  });
});

describe("ambientForClock", () => {
  it("is full daylight mid-day", () => {
    // read from CONFIG so feel-tuning the ambient values doesn't break the curve tests
    expect(ambientForClock("day", 35, 1)).toBeCloseTo(CONFIG.siege.dayAmbient, 5); // phaseT == dayDuration
  });
  it("is gloom (not full black) mid-night", () => {
    expect(ambientForClock("night", nightDuration(1), 1)).toBeCloseTo(CONFIG.siege.nightAmbient, 5);
  });
  it("crossfades down toward dusk (late day darker than mid-day)", () => {
    const mid = ambientForClock("day", 35, 1);
    const dusk = ambientForClock("day", 1, 1); // almost dusk
    expect(dusk).toBeLessThan(mid);
    expect(dusk).toBeGreaterThanOrEqual(CONFIG.siege.nightAmbient);
  });
  it("lifts toward dawn (end of night brighter than mid-night)", () => {
    const midNight = ambientForClock("night", nightDuration(1), 1);
    const predawn = ambientForClock("night", 1, 1); // almost dawn
    expect(predawn).toBeGreaterThan(midNight);
  });
});

describe("clockLabel / clockFrac", () => {
  it("day starts at 06:00 and ends at 18:00", () => {
    expect(clockLabel("day", 35, 1)).toBe("06:00"); // phaseT == dayDuration → start
    expect(clockLabel("day", 0, 1)).toBe("18:00"); // phaseT == 0 → dusk
  });
  it("night starts at 18:00 and ends at 06:00", () => {
    expect(clockLabel("night", nightDuration(1), 1)).toBe("18:00");
    expect(clockLabel("night", 0, 1)).toBe("06:00");
  });
  it("frac runs 0 at phase start to 1 at phase end", () => {
    expect(clockFrac("day", 35, 1)).toBeCloseTo(0, 5);
    expect(clockFrac("day", 0, 1)).toBeCloseTo(1, 5);
  });
});
