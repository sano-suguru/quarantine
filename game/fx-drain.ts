import { ENEMY_TYPES } from "../sim/data/enemies";
import { clearFx } from "../sim/events";
import {
  fxActionBurst,
  fxDust,
  fxHurt,
  fxImpact,
  fxKill,
  fxMote,
  fxMuzzle,
  fxPickup,
} from "../sim/systems/fx";
import type { State } from "../sim/types";
import { Audio } from "./engine/audio";
import { announce } from "./ui";

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
      case "pickup":
        fxPickup(state, e.x, e.y, e.glow);
        Audio.pickup();
        break;
      case "deployDestroy":
        if (e.rtb)
          fxImpact(state, e.x, e.y, 0, e.color); // soft power-down on RTB
        else fxKill(state, e.x, e.y, e.color, e.color, true, false); // machine destruction: flesh=false, def.color
        break;
      case "announce":
        announce(e.label, e.day);
        break;
      case "audio":
        drainAudioCue(e.cue);
        break;
      case "muzzle":
        if (e.melee) Audio.melee();
        else Audio.shot(e.weapon);
        if (!e.melee) fxMuzzle(state, e.x, e.y, e.ang, e.color);
        break;
    }
  }
  clearFx(state);
}
