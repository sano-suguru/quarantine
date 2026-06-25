import { CONFIG } from "../config";
import type { State } from "../types";
import { restockCaches } from "./caches";
import { spawnZombie, startWave, sysWave } from "./wave";

/**
 * Day/night siege loop. Day = a lit, timed scavenge/repair window with no spawns;
 * night = the dark horde (reuses the wave system) that must be cleared to reach dawn.
 */

/** Begin the lit scavenge phase: restock caches and seed a few roaming zombies. */
export function startDay(state: State): void {
  state.phase = "day";
  state.phaseT = CONFIG.siege.dayDuration;
  restockCaches(state);
  // sparse wanderers across the map make venturing out to loot risky
  for (let i = 0; i < CONFIG.siege.roamersPerDay; i++) {
    const type = i % 4 === 3 ? "runner" : "walker";
    spawnZombie(state, type, 1, 1, { chasing: false, aroundPlayer: false });
  }
}

/** Begin the horde night: spawn intensity scales with the day number. */
export function startNight(state: State): void {
  state.phase = "night";
  startWave(state, state.day);
}

/**
 * Advance the siege. Returns "night" the frame day flips to night, "dawn" the
 * frame the night horde is cleared, otherwise null.
 */
export function sysSiege(state: State, dt: number): "night" | "dawn" | null {
  if (state.phase === "day") {
    state.phaseT -= dt;
    if (state.phaseT <= 0) {
      startNight(state);
      return "night";
    }
    return null;
  }
  // night
  return sysWave(state, dt) ? "dawn" : null;
}
