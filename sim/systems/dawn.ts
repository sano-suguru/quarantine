import { salvageEarned, salvageShare } from "../data/arsenal";
import { revivePlayer } from "../engine/players";
import type { State } from "../types";
import { rollDraft } from "./shop";
import { startDay } from "./siege";

/** Bank the SALVAGE earned since the last dawn to each present (non-absent) player.
 *  Uses the existing global-kills formula incrementally: delta = total - alreadyBanked, split
 *  evenly. Advances the baseline. Returns the per-player amounts for the caller to deliver. */
export function bankSalvageAtDawn(state: State): { pid: number; salvage: number }[] {
  const total = salvageEarned(state.day, state.kills);
  const delta = total - state.salvageBanked;
  state.salvageBanked = total;
  const present = state.players.filter((p) => !p.absent);
  const share = salvageShare(delta, present.length);
  return present.map((p) => ({ pid: p.id, salvage: share }));
}

/** Revive anyone still down at dawn (timer hadn't fired) — the "new day, everyone fresh" reset. */
export function reviveStragglers(state: State): void {
  for (const p of state.players) if (p.hp <= 0 && !p.absent) revivePlayer(state, p);
}

/** The full dawn transition, run by the DO on stepSim's "dawn". Advances the day, banks SALVAGE,
 *  revives stragglers at the fortress, and re-enters the lit day. Returns per-player banked amounts. */
export function sysDawn(state: State): { pid: number; salvage: number }[] {
  state.day++;
  const banked = bankSalvageAtDawn(state);
  reviveStragglers(state);
  startDay(state);
  for (const p of state.players) {
    if (p.absent || p.draftRolledForDay === state.day) continue;
    rollDraft(state, p);
    p.draftRolledForDay = state.day;
  }
  return banked;
}
