import { ENEMY_TYPES } from "./data/enemies";
import { Audio } from "./engine/audio";
import { clearFx } from "./sim/events";
import { fxActionBurst, fxDust, fxHurt, fxImpact, fxKill, fxMote } from "./systems/fx";
import type { State } from "./types";

const GREY: [number, number, number] = [0.5, 0.5, 0.5];

function drainAudioCue(cue: string): void {
  switch (cue) {
    case "heal":
      Audio.heal();
      break;
    case "reload":
      Audio.reload();
      break;
    case "reloadDone":
      Audio.reloadDone();
      break;
    case "switchWeapon":
      Audio.switchWeapon();
      break;
    case "dryFire":
      Audio.dryFire();
      break;
    case "pickup":
      Audio.pickup();
      break;
    case "repair":
      Audio.repair();
      break;
    case "waveStart":
      Audio.waveStart();
      break; // added in Task 9
    case "dawn":
      Audio.dawn();
      break; // added in Task 9
    case "lightDie":
      Audio.lightDie();
      break; // added in Task 9
  }
}

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
      case "dust":
        fxDust(state, e.x, e.y, e.n);
        break;
      case "mote":
        fxMote(state, e.x, e.y, e.color);
        break;
      case "burst":
        fxActionBurst(state, e.x, e.y, e.color, e.ring);
        break;
      case "audio":
        drainAudioCue(e.cue);
        break;
      // muzzle variant added by its system-conversion task
    }
  }
  clearFx(state);
}
