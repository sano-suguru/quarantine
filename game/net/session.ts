/**
 * Co-op session epoch — a single liveness token shared by every async lobby/join flow.
 *
 * Method C teardown is racy: joinRoom / quickMatch / reconnect all `await` the network, then write
 * back into the `Net` singleton (become client, arm the reconnect watchdog, …). If the player
 * leaves DURING that await, the write-back would resurrect a session that endCoop() just tore down
 * (ghost peer, stuck "connecting", stale mode). Every such flow captures `coopEpoch()` up front and
 * re-checks `isCoopEpochCurrent()` after each await/timer/callback; endCoop() calls `bumpCoopEpoch()`
 * so all in-flight flows see themselves as stale and bail (closing any link they obtained).
 */
let epoch = 0;

/** Invalidate every previously-captured epoch. Call exactly once per session teardown. */
export function bumpCoopEpoch(): void {
  epoch++;
}

/** The current session token. Capture this at the start of any async co-op flow. */
export function coopEpoch(): number {
  return epoch;
}

/** True iff `captured` is still the live session (i.e. no teardown happened since it was captured). */
export function isCoopEpochCurrent(captured: number): boolean {
  return captured === epoch;
}
