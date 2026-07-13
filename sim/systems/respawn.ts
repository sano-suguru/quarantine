import { CONFIG } from "../config";
import { revivePlayer } from "../engine/players";
import type { State } from "../types";

/**
 * Individual timed respawn. A downed player (hp<=0, not a disconnected held body) accrues `downT`;
 * once it reaches CONFIG.siege.respawnDelay they respawn at the fortress. Runs after sysAssist so a
 * teammate's in-place peer-revive (which sets hp>0 and resets downT) takes priority the same frame.
 */
export function sysRespawn(state: State, dt: number): void {
  for (const p of state.players) {
    if (p.hp > 0 || p.absent) continue;
    p.downT += dt;
    if (p.downT >= CONFIG.siege.respawnDelay) revivePlayer(state, p); // fortress, full HP; resets downT
  }
}
