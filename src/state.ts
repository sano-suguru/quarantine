import { CONFIG } from "./config";
import { WEAPONS } from "./data/weapons";
import { SpatialHash } from "./engine/spatialHash";
import type { State } from "./types";

export function newState(): State {
  return {
    running: false,
    paused: false,
    time: 0,
    player: {
      x: 0,
      y: 0,
      r: CONFIG.player.radius,
      hp: CONFIG.player.maxHp,
      maxHp: CONFIG.player.maxHp,
      speed: CONFIG.player.speed,
      aim: 0,
      weapon: "pistol",
      ammo: (WEAPONS.pistol as (typeof WEAPONS)[string]).mag,
      fireCd: 0,
      reloadT: 0,
    },
    zombies: [],
    bullets: [],
    cam: { x: 0, y: 0, shake: 0 },
    wave: { n: 0, phase: "prep", t: 0, queue: [], def: null, spawnT: 0 },
    money: 0,
    kills: 0,
    dmgMul: 1,
    fireRateMul: 1,
    hash: new SpatialHash(64),
    _firedThisHold: false,
  };
}
