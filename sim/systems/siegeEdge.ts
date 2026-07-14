import type { FxEvent, SiegePhase } from "../types";

/**
 * Client-side derivation of the siege one-shots from the synced phase edge. The DO carries no
 * fxEvents (derive-first); the client tracks the last-seen phase and replays the cue when it flips.
 * prev=null (first snapshot / post-reset) yields nothing, so a drop-in shows no banner.
 */
export function siegeEdgeCue(prev: SiegePhase | null, next: SiegePhase, day: number): FxEvent[] {
  if (prev === null || prev === next) return [];
  if (next === "night") {
    return [
      { t: "announce", label: "NIGHT", day },
      { t: "audio", cue: "waveStart" },
    ];
  }
  if (next === "breached") {
    return [
      { t: "announce", label: "FORTRESS FALLEN", day },
      { t: "audio", cue: "breach" },
    ];
  }
  if (next === "resetting") return []; // silent rebuild hold
  // next === "day": the normal dawn banner (also the resetting→day frame, but the client nulls
  // prevPhase on reset via isArenaResetEdge before this runs, so no banner fires on a reset).
  return [
    { t: "announce", label: "DAY", day },
    { t: "audio", cue: "dawn" },
  ];
}

/** The entity-churn frame: the DO rebuilds the world on resetting→day, so the client must
 *  hard-clear its interp buffer here (else the wholesale id churn misfires as mass kill/spawn fx). */
export function isArenaResetEdge(prev: SiegePhase | null, next: SiegePhase): boolean {
  return prev === "resetting" && next === "day";
}
