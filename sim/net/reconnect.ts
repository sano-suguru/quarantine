// Pure client reconnect timing. The DO decides in-place-vs-fresh (grace) authoritatively; this
// only governs how long / how many times the client redials before giving up to the title.

/**
 * Delay (ms) before reconnect `attempt` (0-based), or `null` when `attempt` is past the last
 * configured backoff step — the caller then stops retrying and returns to the title. Grace is NOT
 * policed here: a reconnect landing after `graceMs` simply re-attaches as a fresh slot server-side.
 */
export function reconnectDelay(attempt: number, backoffMs: readonly number[]): number | null {
  return attempt >= 0 && attempt < backoffMs.length ? (backoffMs[attempt] as number) : null;
}
