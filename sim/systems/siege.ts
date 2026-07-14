import { CONFIG } from "../config";
import { HH, HW } from "../data/map";
import { clamp } from "../engine/math";
import { revivePlayer } from "../engine/players";
import type { SiegePhase, State } from "../types";
import { restockCaches } from "./caches";
import { spawnZombie, startWave, sysWave } from "./wave";

/**
 * Day/night siege loop. Day = a lit, timed scavenge/repair window with sparse roamers;
 * night = the dark horde (continuous capped spawn) that ends on the dawn clock, not a wipe-out.
 */

/** Seconds of night for a given day. Night is a timed hold; dawn comes by the clock. */
export function nightDuration(day: number): number {
  const s = CONFIG.siege;
  return Math.min(s.nightDurationMax, s.nightDurationBase + (day - 1) * s.nightDurationPerDay);
}

/** Living-zombie cap during the night for a given day (day-scaled under a hard ceiling). */
export function nightMaxZombies(day: number): number {
  const s = CONFIG.siege;
  return Math.min(s.nightCapMax, s.nightCapBase + (day - 1) * s.nightCapPerDay);
}

/** Overrun test: the interior holds at least this many zombies. Pure — the caller counts. */
export function isFortressBreached(indoorCount: number): boolean {
  return indoorCount >= CONFIG.siege.breachZombies;
}

/** Enter the frozen failure beat. */
export function enterBreached(state: State): void {
  state.phase = "breached";
  state.phaseT = CONFIG.siege.breachedDuration;
  state.breachT = 0;
}

/** Ambient light as a function of the clock: flat by day/night, crossfading over dusk/dawn. */
export function ambientForClock(phase: SiegePhase, phaseT: number, day: number): number {
  const s = CONFIG.siege;
  const lerp = (k: number): number => s.nightAmbient + (s.dayAmbient - s.nightAmbient) * k;
  if (phase === "day") {
    const window = s.dayDuration * s.duskFrac;
    return phaseT < window ? lerp(phaseT / window) : s.dayAmbient; // sunset over the last duskFrac
  }
  const window = nightDuration(day) * s.dawnFrac;
  return phaseT < window ? lerp(1 - phaseT / window) : s.nightAmbient; // predawn lift
}

/** 0 at the start of the current phase → 1 at its end. */
export function clockFrac(phase: SiegePhase, phaseT: number, day: number): number {
  const dur = phase === "day" ? CONFIG.siege.dayDuration : nightDuration(day);
  return clamp(1 - phaseT / dur, 0, 1);
}

/** In-game time of day: day spans 06:00→18:00, night spans 18:00→06:00. */
export function clockLabel(phase: SiegePhase, phaseT: number, day: number): string {
  const startH = phase === "day" ? 6 : 18;
  const t = startH + clockFrac(phase, phaseT, day) * 12; // hours into the 12h span
  const hh = Math.floor(t) % 24;
  const mm = Math.floor((t - Math.floor(t)) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

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

/** Begin the horde night: arm the continuous spawner and start the night clock. */
export function startNight(state: State): void {
  state.phase = "night";
  state.phaseT = nightDuration(state.day);
  startWave(state, state.day);
}

/**
 * Advance the siege. Returns "night" the frame day flips to night, "dawn" the frame the night
 * clock elapses (regardless of how many zombies remain — survivors carry into the day),
 * "breached" the frame the interior-overrun sustain window expires, "reset" when the resetting
 * phase ends (Task 2), else null.
 */
export function sysSiege(state: State, dt: number): "night" | "dawn" | "breached" | "reset" | null {
  if (state.phase === "day") {
    state.phaseT -= dt;
    if (state.phaseT <= 0) {
      startNight(state);
      return "night";
    }
    return null;
  }
  if (state.phase === "night") {
    // night: spawns keep coming (capped); dawn arrives on the clock, not on a wipe-out
    sysWave(state, dt, nightMaxZombies(state.day));
    // breach: the interior being overrun for breachSustain seconds falls the fortress
    let indoor = 0;
    for (const z of state.zombies) if (Math.abs(z.x) < HW && Math.abs(z.y) < HH) indoor++;
    state.breachT = isFortressBreached(indoor)
      ? state.breachT + dt
      : Math.max(0, state.breachT - dt);
    if (state.breachT >= CONFIG.siege.breachSustain) {
      enterBreached(state);
      return "breached";
    }
    state.phaseT -= dt;
    if (state.phaseT > 0) return null;
    return "dawn";
  }
  if (state.phase === "breached") {
    state.phaseT -= dt;
    if (state.phaseT <= 0) {
      state.phase = "resetting";
      state.phaseT = CONFIG.siege.resettingDuration;
    }
    return null;
  }
  if (state.phase === "resetting") {
    state.phaseT -= dt;
    if (state.phaseT <= 0) return "reset";
    return null;
  }
  return null;
}

/**
 * Soft-reset the arena to a fresh Day-1 (run by the DO on stepSim's "reset"). Communal only:
 * the horde/economy/barricades reset and every player is revived at the fortress; per-player
 * SALVAGE/unlocks are client-side meta and untouched. Symmetric with sysDawn.
 *
 * NOTE: startDay is called first so the phase/timer/caches are set, then all transient arrays
 * (including any roamers startDay seeded) are wiped — the arena starts Day-1 with an empty field
 * rather than inheriting stale day-N corpses or pre-seeded roamers from the breach night.
 */
export function resetArena(state: State): void {
  state.day = 1;
  for (const b of state.barricades) b.hp = CONFIG.siege.boardMaxHp;
  state.kills = 0;
  state.salvageBanked = 0;
  state.breachT = 0;
  for (const p of state.players) revivePlayer(state, p); // fortress spawn, full hp, clears downT
  startDay(state); // phase="day", phaseT=dayDuration, restock caches
  // clear all transient simulation arrays AFTER startDay so we also erase any roamers it seeded;
  // the fresh arena begins with an empty field on Day-1
  state.zombies.length = 0;
  state.bullets.length = 0;
  state.pickups.length = 0;
  state.particles.length = 0;
  state.decals.length = 0;
}
