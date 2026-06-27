import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { newState } from "../state";
import { startDay, startNight, sysSiege } from "./siege";

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
  it("enters the night phase and arms a wave for the current day", () => {
    const s = newState();
    s.day = 3;
    startNight(s);
    expect(s.phase).toBe("night");
    expect(s.wave.n).toBe(3);
    expect(s.wave.phase).toBe("active");
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

  it("returns 'dawn' on the frame the night horde is cleared", () => {
    const s = newState();
    startNight(s);
    // force the cleared condition deterministically: empty queue + no zombies left
    s.wave.queue = [];
    s.zombies = [];
    expect(sysSiege(s, 1)).toBe("dawn");
    expect(s.wave.phase).toBe("cleared");
  });

  it("returns null at night while the horde is not yet cleared", () => {
    const s = newState();
    startNight(s);
    s.wave.queue = [];
    s.zombies = [{ id: 1 } as (typeof s.zombies)[number]]; // one straggler still alive
    expect(sysSiege(s, 1)).toBeNull();
  });
});
