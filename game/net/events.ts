/**
 * Co-op flow events on the reliable channel. Discrete, money/progress-moving commands
 * that must not be lost or reordered — unlike PlayerInput (sampled every frame,
 * last-write-wins) and unlike snapshots (unreliable). The DO is authoritative.
 *
 * Ownership/levels are NOT events — `owned` rides the Hello, `wlevel` rides the snapshot.
 */

/** Client → DO requests. The DO validates against the live state and applies once. */
export type CoopEvent =
  | { t: "buy"; itemId: string } // purchase a store item; buyer = the requesting peer's player
  | { t: "place" } // drop the front of the requester's deploy queue at their feet (host picks the
  // spot from the player's synced pos/aim — no coords cross the wire). Reliable (not a sampled
  // input field) because it moves inventory and must not be dropped/reordered, like `buy`.
  | { t: "draftTake"; cardId: string } // take a draft card from the local player's offer
  | { t: "draftReroll" } // reroll the local player's draft offer
  // First message a client sends on every arena (re)connect, so the DO can decide this peer's
  // identity before spawning: `join` = fresh peer (DO assigns a free slot); `rejoin` =
  // reconnect — DO matches pid+nonce to the dropped player's still-held body and re-attaches
  // in place (no respawn). Unmatched/expired tokens fall back to a fresh slot. See worker/arena.ts.
  | { t: "join" }
  | { t: "rejoin"; pid: number; nonce: string };

/** DO → client notifications. */
export type HostEvent =
  // Arena is at capacity (maxPlayers). The DO sends this instead of assigning a slot; the client
  // tears its own link down on receipt (the DO does not close immediately — see worker/arena.ts).
  { t: "roomfull" } | { t: "banked"; salvage: number }; // dawn SALVAGE payout for this player (client → addSalvage)
