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
  | { t: "place" } // drop the front of the requester's deploy queue at their feet (host picks the
  // spot from the player's synced pos/aim — no coords cross the wire). Reliable (not a sampled
  // input field) because it moves inventory and must not be dropped/reordered, like `buy`.
  | { t: "deploy" } // leave the shop, start the next day
  | { t: "nightStart" } // bring the night early (day phase only)
  // First message a client sends on every P2P open, so the host can decide this peer's
  // identity before spawning: `join` = fresh peer (host assigns a free slot); `rejoin` =
  // reconnect — host matches pid+nonce to the dropped player's still-held body and re-attaches
  // in place (no respawn). Unmatched/expired tokens fall back to a fresh slot. See host.ts.
  | { t: "join" }
  | { t: "rejoin"; pid: number; nonce: string };

/** Host → client notifications. */
export type HostEvent = {
  t: "gameover";
  salvage: number; // this player's banked share
  day: number;
  kills: number;
  money: number;
};
