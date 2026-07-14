import type { SiegePhase, State } from "../types";

/** Bump when CycleBlob's shape changes; the loader treats an unknown version as "no saved state". */
export const SCHEMA_VERSION = 1;

/**
 * The persisted communal cycle (2b②). Communal-only: no per-player bodies/economy, no ephemeral
 * entities, no transient detection state. Players spawn fresh on join; per-player SALVAGE/unlocks
 * are client localStorage. See the M-B spec for why owned/searchT/breachT/stalker/nextId are excluded.
 */
export interface CycleBlob {
  schemaVersion: number;
  day: number;
  phase: SiegePhase;
  phaseT: number;
  salvageBanked: number;
  kills: number;
  barricades: number[]; // hp per opening, index-aligned to HOME.openings (newState order)
  caches: boolean[]; // looted per cache, index-aligned to newState() caches
}

export function serializeCycle(state: State): CycleBlob {
  return {
    schemaVersion: SCHEMA_VERSION,
    day: state.day,
    phase: state.phase,
    phaseT: state.phaseT,
    salvageBanked: state.salvageBanked,
    kills: state.kills,
    barricades: state.barricades.map((b) => b.hp),
    caches: state.caches.map((c) => c.looted),
  };
}

/** Overlay a blob's communal fields onto an already-freshly-built state (from newState()). */
export function applyCycle(state: State, blob: CycleBlob): void {
  state.day = blob.day;
  state.phase = blob.phase;
  state.phaseT = blob.phaseT;
  state.salvageBanked = blob.salvageBanked;
  state.kills = blob.kills;
  blob.barricades.forEach((hp, i) => {
    const bar = state.barricades[i];
    if (bar) bar.hp = hp;
  });
  blob.caches.forEach((looted, i) => {
    const c = state.caches[i];
    if (c) c.looted = looted;
  });
}
