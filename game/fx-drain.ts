import { ENEMY_TYPES } from "./data/enemies";
import { Audio } from "./engine/audio";
import { clearFx } from "./sim/events";
import { fxHurt, fxImpact, fxKill } from "./systems/fx";
import type { State } from "./types";

const GREY: [number, number, number] = [0.5, 0.5, 0.5];

/** Client-side sink: turn the tick's discrete cues into audio + particles, then clear. */
export function drainFxEvents(state: State): void {
  for (const e of state.fxEvents) {
    switch (e.t) {
      case "kill": {
        const ty = ENEMY_TYPES[e.type];
        fxKill(
          state,
          e.x,
          e.y,
          ty?.color ?? GREY,
          ty?.glow ?? GREY,
          e.big,
          true,
          ty?.sprite ?? "",
          e.dir,
          e.radius,
          e.hitDir,
        );
        Audio.kill(e.big);
        break;
      }
      case "impact":
        fxImpact(state, e.x, e.y, e.ang, e.color, e.intensity);
        break;
      case "hit":
        Audio.hit();
        break;
      case "hurt":
        fxHurt(state, e.x, e.y);
        if (e.local) Audio.hurt();
        break;
      // muzzle / audio variants are added by their system-conversion tasks
    }
  }
  clearFx(state);
}
