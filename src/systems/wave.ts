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
    chasing: opts.chasing ?? true,
    lungeCd: rand(0, t.lungePeriod ?? 0),
    lungeT: 0,
    wanderDir: rand(0, Math.PI * 2),
  });
}

export function startWave(state: State, n: number): void {
  // squad size scales the horde count; absent (held) bodies don't inflate it. Min 1 = SP.
  const players = state.players.filter((p) => !p.absent).length || 1;
  const def = waveDef(n, players);
  state.wave = { n, phase: "active", t: 0, queue: def.spawn.slice(), def, spawnT: 0 };
}

/** Returns true on the frame the wave transitions to "cleared". */
export function sysWave(state: State, dt: number): boolean {
  const w = state.wave;
  if (w.phase !== "active") return false;
  if (w.queue.length) {
    w.spawnT -= dt;
    if (w.spawnT <= 0) {
      const def = w.def as NonNullable<typeof w.def>;
      const batch = Math.min(w.queue.length, 1 + Math.floor(w.n / 3));
      for (let i = 0; i < batch; i++)
        spawnZombie(state, w.queue.pop() as string, def.hpScale, def.spdScale);
      w.spawnT = def.interval;
    }
  } else if (state.zombies.length === 0) {
    w.phase = "cleared";
    return true;
  }
  return false;
}
