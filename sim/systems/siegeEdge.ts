import type { FxEvent, SiegePhase } from "../types";

/**
 * Client-side derivation of the siege one-shots from the synced phase edge. The DO carries no
 * fxEvents (derive-first); the client tracks the last-seen phase and replays the banner + sting
 * when it flips. prev=null (first snapshot) yields nothing, so a drop-in mid-night shows no banner.
 */
export function siegeEdgeCue(prev: SiegePhase | null, next: SiegePhase, day: number): FxEvent[] {
  if (prev === null || prev === next) return [];
  if (next === "night") {
    return [
      { t: "announce", label: "NIGHT", day },
      { t: "audio", cue: "waveStart" },
    ];
  }
  return [
    { t: "announce", label: "DAY", day },
    { t: "audio", cue: "dawn" },
  ];
}
