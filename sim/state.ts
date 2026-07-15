import { CONFIG } from "./config";
import { HOME, POIS } from "./data/map";
import { STARTER_WEAPONS } from "./data/weapons";
import { clamp } from "./engine/math";
import { makePlayer } from "./engine/players";
import { SpatialHash } from "./engine/spatialHash";
import type { Barricade, Cache, Segment, State } from "./types";

/**
 * Meta-unlock provider seam. The sim closure must not reach the browser (it also runs headless
 * on the authoritative server), and `game/meta.ts` is a `localStorage` wrapper — so `newState`
 * can't import it directly without dragging DOM into `sim/`. Instead the DOM entry (`game/main.ts`)
 * injects a provider that returns the persisted `unlocked` id→bool map; the sim keeps the ownership
 * derivation (weapon vs `card:` split) below. Default = no persisted unlocks (starters only), which
 * is exactly what tests without a stubbed provider expect.
 */
let unlockProvider: () => Record<string, boolean> = () => ({});

/** Register the source of persisted meta-unlocks. Called once from the DOM entry at startup. */
export function setUnlockProvider(fn: () => Record<string, boolean>): void {
  unlockProvider = fn;
}

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
  const unlocked = unlockProvider();
  const owned: Record<string, boolean> = {};
  const unlockedCards: Record<string, boolean> = {};
  for (const id of STARTER_WEAPONS) owned[id] = true;
  for (const id of Object.keys(unlocked)) {
    if (!unlocked[id]) continue;
    if (id.startsWith("card:"))
      unlockedCards[id] = true; // perk card unlocks (NOT weapons)
    else owned[id] = true; // weapon unlocks
  }

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
    time: 0,
    nextId: 1,
    players: [makePlayer(0, 0, 0)],
    localId: 0,
    zombies: [],
    bullets: [],
    pickups: [],
    particles: [],
    decals: [],
    fxEvents: [],
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
    salvageBanked: 0,
    owned,
    unlockedCards,
    hash: new SpatialHash(64),
    hitstopT: 0,
    surrounded: 0,
    lurking: 0,
    stalker: null,
    // transient host-only nav state — NOT in captureSnapshot/encode
    flow: null,
    navTick: 0,
    breachT: 0,
  };
}
