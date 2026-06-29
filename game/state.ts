import { CONFIG } from "./config";
import { HOME, POIS } from "./data/map";
import { STARTER_WEAPONS } from "./data/weapons";
import { clamp } from "./engine/math";
import { makePlayer } from "./engine/players";
import { SpatialHash } from "./engine/spatialHash";
import { loadMeta } from "./meta";
import type { Barricade, Cache, Segment, State } from "./types";

/** loot tier rises with distance from HOME (origin) */
function tierFor(x: number, y: number): number {
  return clamp(Math.round(Math.hypot(x, y) / CONFIG.cache.tierDist), 1, CONFIG.cache.maxTier);
}

/**
 * Allocate the next stable entity id (zombies/bullets/pickups). Host-authoritative:
 * only the host's sim calls this, so ids never collide across peers. Client-predicted
 * ghost bullets use a separate negative-id space and never touch this allocator.
 */
export function allocId(state: State): number {
  return state.nextId++;
}

export function newState(): State {
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
    inShop: false,
    time: 0,
    nextId: 1,
    players: [makePlayer(0, 0, 0)],
    localId: 0,
    zombies: [],
    bullets: [],
    pickups: [],
    particles: [],
    texts: [],
    decals: [],
    walls,
    barricades,
    caches,
    deployables: [],
    phase: "day",
    day: 1,
    phaseT: CONFIG.siege.dayDuration,
    cam: { x: 0, y: 0, shake: 0 },
    wave: { n: 0, def: null, spawnT: 0 },
    kills: 0,
    owned,
    hash: new SpatialHash(64),
    hitstopT: 0,
    flashT: 0,
    flashColor: [1, 0.3, 0.3],
    surrounded: 0,
    lurking: 0,
  };
}
