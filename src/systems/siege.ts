import { CONFIG } from "../config";
import type { State } from "../types";
import { scatterPickups } from "./pickups";
import { startWave, sysWave } from "./wave";

/**
 * Day/night siege loop. Day = a lit, timed scavenge/repair window with no spawns;
 * night = the dark horde (reuses the wave system) that must be cleared to reach dawn.
 */

/** Begin the lit scavenge phase for the current day and scatter loot to find. */
export function startDay(state: State): void {
  state.phase = "day";
  state.phaseT = CONFIG.siege.dayDuration;
  scatterPickups(state, CONFIG.ammo.scatterPerWave + 2);
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
