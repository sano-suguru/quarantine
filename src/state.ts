import { CONFIG } from "./config";
import { HOME, POIS } from "./data/map";
import { STARTER_WEAPONS, WEAPONS, WEAPON_ORDER } from "./data/weapons";
import { clamp } from "./engine/math";
import { SpatialHash } from "./engine/spatialHash";
import { loadMeta } from "./meta";
import type { Barricade, Cache, Segment, State, WeaponDef } from "./types";

/** loot tier rises with distance from HOME (origin) */
function tierFor(x: number, y: number): number {
  return clamp(Math.round(Math.hypot(x, y) / CONFIG.cache.tierDist), 1, CONFIG.cache.maxTier);
}

export function newState(): State {
  // per-weapon spare ammo and magazine state, seeded from the weapon table
  const reserve: Record<string, number> = {};
  const mags: Record<string, number> = {};
  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id] as WeaponDef;
    reserve[id] = w.reserveStart;
    mags[id] = w.mag;
  }

  // which weapons this run can use: starters always, plus meta-unlocked ones
  const meta = loadMeta();
  const owned: Record<string, boolean> = {};
  for (const id of STARTER_WEAPONS) owned[id] = true;
  for (const id of Object.keys(meta.unlocked)) if (meta.unlocked[id]) owned[id] = true;

  // HOME openings start fully boarded; POI walls join the collision set
  const barricades: Barricade[] = HOME.openings.map((o) => ({
    ...o,
    hp: CONFIG.siege.boardMaxHp,
    maxHp: CONFIG.siege.boardMaxHp,
    flash: 0,
  }));
  const walls: Segment[] = [...HOME.walls, ...POIS.flatMap((p) => p.walls)];

  // a cache in each POI, plus a low-tier one just outside HOME for the early game
  const caches: Cache[] = [
    ...POIS.map((p) => ({
      x: p.cache.x,
      y: p.cache.y,
      looted: false,
      searchT: 0,
      tier: tierFor(p.cache.x, p.cache.y),
    })),
    { x: 0, y: 300, looted: false, searchT: 0, tier: 1 },
  ];

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
    walls,
    barricades,
    caches,
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
    owned,
    wlevel: {},
    hash: new SpatialHash(64),
    hitstopT: 0,
    flashT: 0,
    flashColor: [1, 0.3, 0.3],
    surrounded: 0,
    lurking: 0,
    _firedThisHold: false,
  };
}
