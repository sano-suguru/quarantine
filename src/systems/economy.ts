import { CONFIG } from "../config";
import type { State } from "../types";

/**
 * Credit a kill/loot bounty to players (co-op individual wallets). Proximity model:
 * split evenly among living players within CONFIG.econ.bountyRadius of (x, y); the
 * integer remainder goes to the poorest first — a no-comms, no-gifting catch-up so a
 * teammate who has fallen behind is topped up automatically. Money stays integer.
 *
 * Single-player short-circuits to the sole player so SP money is byte-identical to the
 * old shared `state.money += amount` (full amount, regardless of distance).
 */
export function awardBounty(state: State, x: number, y: number, amount: number): void {
  const living = state.players.filter((p) => p.hp > 0 && !p.absent);
  if (living.length <= 1) {
    const only = living[0];
    if (only) only.money += amount;
    return;
  }
  const r2 = CONFIG.econ.bountyRadius * CONFIG.econ.bountyRadius;
  let share = living.filter((p) => (p.x - x) ** 2 + (p.y - y) ** 2 <= r2);
  // nobody near the kill → the whole squad shares, so a stray kill never destroys money
  if (share.length === 0) share = living;
  // poorest first (id breaks ties) makes the remainder a deterministic catch-up
  share = [...share].sort((a, b) => a.money - b.money || a.id - b.id);
  const base = Math.floor(amount / share.length);
  let rem = amount - base * share.length;
  for (const p of share) {
    p.money += base + (rem > 0 ? 1 : 0);
    if (rem > 0) rem--;
  }
}
