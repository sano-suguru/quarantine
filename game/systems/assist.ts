import { CONFIG } from "../config";
import { revivePlayer } from "../engine/players";
import type { Player, State } from "../types";

/**
 * Co-op peer revive (free, proximity-auto, no button). A downed teammate's revive gauge
 * (`assistT`) fills while any ALIVE teammate stands still within reach of them; at
 * reviveTime they get up in place at partial integrity. Standing still is the intent
 * signal — running past doesn't revive. Host/single only (clients see the result + gauge
 * via the snapshot); single-player short-circuits so its behaviour is byte-identical.
 *
 * Reviving is free (time + exposure is the cost), so it auto-triggers. Resource-spending
 * help (heal = medkit, repair = money) stays on E in sysPlayer — see player.ts:interact.
 */
export function sysAssist(state: State, dt: number): void {
  if (state.players.length < 2) return; // no teammates → nothing to do (SP invariant)
  const r2 = CONFIG.siege.interactRadius * CONFIG.siege.interactRadius;
  const tended = new Set<Player>();

  for (const target of state.players) {
    if (target.absent || target.hp > 0) continue; // only downed teammates are revived
    // is any alive, stationary teammate tending this body?
    let helped = false;
    for (const helper of state.players) {
      if (helper === target || helper.hp <= 0 || helper.absent) continue;
      if (helper.input.moveX !== 0 || helper.input.moveY !== 0) continue; // must stand still
      const dx = helper.x - target.x;
      const dy = helper.y - target.y;
      if (dx * dx + dy * dy <= r2) {
        helped = true;
        break; // accumulate once per target, not per helper (no double-add)
      }
    }
    if (!helped) continue;
    target.assistT += dt;
    tended.add(target);
    if (target.assistT >= CONFIG.assist.reviveTime) {
      revivePlayer(state, target, {
        inPlace: true,
        hp: Math.round(target.maxHp * CONFIG.assist.reviveHpFrac),
      });
    }
  }

  // a downed body nobody is tending this tick loses its progress
  for (const p of state.players) {
    if (p.hp <= 0 && !tended.has(p) && p.assistT > 0) p.assistT = 0;
  }
}
