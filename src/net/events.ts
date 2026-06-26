/**
 * Co-op flow events on the reliable channel. Discrete, money/progress-moving commands
 * that must not be lost or reordered — unlike PlayerInput (sampled every frame,
 * last-write-wins) and unlike snapshots (unreliable). The host is authoritative.
 *
 * Ownership/levels are NOT events — `owned` rides the Hello, `wlevel` rides the snapshot.
 */

/** Client → host requests. The host validates against the live state and applies once. */
export type CoopEvent =
  | { t: "buy"; itemId: string } // purchase a store item; buyer = the requesting peer's player
  | { t: "deploy" } // leave the shop, start the next day
  | { t: "nightStart" }; // bring the night early (day phase only)

/** Host → client notifications. */
export type HostEvent = {
  t: "gameover";
  salvage: number; // this player's banked share
  day: number;
  kills: number;
  money: number;
};
