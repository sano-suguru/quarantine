import type { FxEvent, State } from "../types";

/** Append a discrete cue. Systems call this instead of Audio/fx directly. */
export function pushFx(state: State, e: FxEvent): void {
  state.fxEvents.push(e);
}

/** Empty the buffer (called after the client drains it / the DO serializes it). */
export function clearFx(state: State): void {
  state.fxEvents.length = 0;
}
