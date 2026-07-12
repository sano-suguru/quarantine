// Pure connection-lifecycle helpers, shared by the Arena DO (worker/) and any future
// client-authority fallback. No DOM / no @cloudflare/workers-types (sim/ boundary).

export type SlotDecision = { kind: "assign"; pid: number } | { kind: "full" };

/**
 * Lowest free player id in 0..max-1, or `full`. Ported from host.ts's pickSlot but 0-based:
 * the DO has no host player, so every slot 0..max-1 is a client. A slot counts occupied by ANY
 * decided peer (open OR held-absent for reconnect) — a held body's slot is reserved for its owner.
 */
export function pickSlot(decidedPids: Iterable<number>, max: number): SlotDecision {
  const used = new Set(decidedPids);
  for (let n = 0; n < max; n++) if (!used.has(n)) return { kind: "assign", pid: n };
  return { kind: "full" };
}

let nonceSeq = 0;
/** Cooperative (not adversarial) reconnect token — unique enough not to collide in a session. */
export function makeNonce(): string {
  return `${(nonceSeq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A rejoin claim matches a still-held peer when it is decided and pid+nonce both agree. */
export function rejoinMatches(
  cand: { pid: number; nonce: string; decided: boolean },
  pid: number,
  nonce: string,
): boolean {
  return cand.decided && cand.pid === pid && cand.nonce === nonce;
}
