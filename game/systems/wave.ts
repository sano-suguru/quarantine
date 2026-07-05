import { CONFIG } from "../config";
import { ENEMY_TYPES } from "../data/enemies";
import { waveDef } from "../data/waves";
import { circlePushFromSegment } from "../engine/geometry";
import { clamp, len, rand } from "../engine/math";
import { allocId } from "../state";
import type { State } from "../types";

/** Is this point clear of every shelter/POI wall (with a little margin)? */
function clearOfWalls(state: State, x: number, y: number, r: number): boolean {
  for (const w of state.walls) {
    if (circlePushFromSegment(x, y, r, w)) return false;
  }
  return true;
}

/** Is this point at least `min` from every player? (roamers avoid popping into view) */
function farFromAllPlayers(state: State, x: number, y: number, min: number): boolean {
  for (const p of state.players) {
    if (len(x - p.x, y - p.y) <= min) return false;
  }
  return true;
}

/**
 * Spawn one zombie. `chasing` decides whether it heads straight in (night horde)
 * or roams until it senses the player (daytime stragglers). When `aroundPlayer`
 * is false it can appear anywhere on the map (roamers). Positions are rejection-
 * sampled so nothing spawns inside a wall.
 */
export function spawnZombie(
  state: State,
  type: string,
  hpScale: number,
  spdScale: number,
  opts: { chasing?: boolean; aroundPlayer?: boolean } = {},
): void {
  const t = ENEMY_TYPES[type] as (typeof ENEMY_TYPES)[string];
  const aroundPlayer = opts.aroundPlayer ?? true;
  const ringR = CONFIG.siege.spawnRing + rand(60, 220);

  // anchor the spawn ring on a random living player (arena centre if everyone is down)
  const alive = state.players.filter((p) => p.hp > 0);
  const anchor = alive.length
    ? (alive[Math.floor(rand(0, alive.length))] as (typeof alive)[number])
    : null;
  const ax = anchor?.x ?? 0;
  const ay = anchor?.y ?? 0;

  let x = ax;
  let y = ay;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (aroundPlayer) {
      const ang = rand(0, Math.PI * 2);
      x = clamp(ax + Math.cos(ang) * ringR, -CONFIG.arena, CONFIG.arena);
      y = clamp(ay + Math.sin(ang) * ringR, -CONFIG.arena, CONFIG.arena);
    } else {
      x = rand(-CONFIG.arena, CONFIG.arena);
      y = rand(-CONFIG.arena, CONFIG.arena);
    }
    // roamers keep their distance from every player so they don't pop into view
    const farEnough = aroundPlayer || farFromAllPlayers(state, x, y, 600);
    if (farEnough && clearOfWalls(state, x, y, t.radius + 6)) break;
  }

  state.zombies.push({
    id: allocId(state),
    x,
    y,
    r: t.radius,
    hp: t.hp * hpScale,
    maxHp: t.hp * hpScale,
    speed: t.speed * spdScale,
    dmg: t.dmg,
    bounty: t.bounty,
    attackCd: 0,
    attackRate: t.attackRate,
    color: t.color,
    type,
    shape: t.shape,
    glow: t.glow,
    eye: t.eye,
    vx: 0,
    vy: 0,
    flash: 0,
    spawnT: 0.35,
    wob: rand(0, Math.PI * 2),
    sense: t.sense,
    wander: t.wander ?? 0,
    lunge: t.lunge ?? 0,
    lungePeriod: t.lungePeriod ?? 0,
    separation: t.separation ?? 1,
    nav: t.nav ?? "none",
    chasing: opts.chasing ?? true,
    lungeCd: rand(0, t.lungePeriod ?? 0),
    lungeT: 0,
    wanderDir: rand(0, Math.PI * 2),
    perception: t.perception ?? "omniscient",
    percept: "idle",
    lastSeenX: 0,
    lastSeenY: 0,
    searchT: 0,
  });
}

export function startWave(state: State, n: number): void {
  // squad size scales the per-pulse batch; absent (held) bodies don't inflate it. Min 1 = SP.
  const players = state.players.filter((p) => !p.absent).length || 1;
  state.wave = { n, def: waveDef(n, players), spawnT: 0 };
}

/**
 * Spawn pulses on cadence up to `cap` living zombies. The night ends on the siege clock
 * (sysSiege), NOT when the horde is cleared — so this keeps pressure coming until dawn. `cap`
 * is passed in (from nightMaxZombies) to keep this module free of a siege import cycle.
 */
export function sysWave(state: State, dt: number, cap: number): void {
  const def = state.wave.def;
  if (!def) return;
  if (state.zombies.length >= cap) return;
  state.wave.spawnT -= dt;
  if (state.wave.spawnT <= 0) {
    const batch = Math.min(def.batch, cap - state.zombies.length);
    for (let i = 0; i < batch; i++)
      spawnZombie(state, pickWeighted(def.weights), def.hpScale, def.spdScale);
    state.wave.spawnT = def.interval;
  }
}

/** Sample one enemy type from the composition weights. */
function pickWeighted(weights: { type: string; w: number }[]): string {
  let total = 0;
  for (const e of weights) total += e.w;
  let r = rand(0, total);
  for (const e of weights) {
    r -= e.w;
    if (r <= 0) return e.type;
  }
  return weights[0]?.type ?? "walker";
}
