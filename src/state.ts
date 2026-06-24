import { CONFIG } from "./config";
import { SHELTER } from "./data/shelter";
import { WEAPONS, WEAPON_ORDER } from "./data/weapons";
import { SpatialHash } from "./engine/spatialHash";
import type { Barricade, State, WeaponDef } from "./types";

export function newState(): State {
  // per-weapon spare ammo and magazine state, seeded from the weapon table
  const reserve: Record<string, number> = {};
  const mags: Record<string, number> = {};
  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id] as WeaponDef;
    reserve[id] = w.reserveStart;
    mags[id] = w.mag;
  }

  // boardable openings start fully boarded
  const barricades: Barricade[] = SHELTER.openings.map((o) => ({
    ...o,
    hp: CONFIG.siege.boardMaxHp,
    maxHp: CONFIG.siege.boardMaxHp,
  }));

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
      ammo: mags.pistol ?? 0,
      reserve,
      mags,
      fireCd: 0,
      reloadT: 0,
      hitFlash: 0,
      recoilX: 0,
      recoilY: 0,
      iframe: 0,
      muzzle: 0,
      dryT: 0,
      battery: CONFIG.flashlight.batteryMax,
      lightOn: true,
      medkits: CONFIG.heal.startMedkits,
      healT: 0,
      repairCd: 0,
    },
    zombies: [],
    bullets: [],
    pickups: [],
    particles: [],
    texts: [],
    decals: [],
    walls: SHELTER.walls,
    barricades,
    phase: "day",
    day: 1,
    phaseT: CONFIG.siege.dayDuration,
    cam: { x: 0, y: 0, shake: 0 },
    wave: { n: 0, phase: "prep", t: 0, queue: [], def: null, spawnT: 0 },
    money: 0,
    kills: 0,
    dmgMul: 1,
    fireRateMul: 1,
    reserveMul: 1,
    hash: new SpatialHash(64),
    hitstopT: 0,
    flashT: 0,
    flashColor: [1, 0.3, 0.3],
    surrounded: 0,
    lurking: 0,
    _firedThisHold: false,
  };
}
