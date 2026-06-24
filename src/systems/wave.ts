import { CONFIG } from "../config";
import { ENEMY_TYPES } from "../data/enemies";
import { waveDef } from "../data/waves";
import { clamp, rand } from "../engine/math";
import { Renderer } from "../engine/renderer";
import type { State } from "../types";

export function spawnZombie(state: State, type: string, hpScale: number, spdScale: number): void {
  const t = ENEMY_TYPES[type] as (typeof ENEMY_TYPES)[string];
  const half = Renderer.worldToScreenHalf();
  const ringR = Math.max(half.x, half.y) + rand(60, 220);
  const ang = rand(0, Math.PI * 2);
  const px = state.player.x + Math.cos(ang) * ringR;
  const py = state.player.y + Math.sin(ang) * ringR;
  state.zombies.push({
    x: clamp(px, -CONFIG.arena, CONFIG.arena),
    y: clamp(py, -CONFIG.arena, CONFIG.arena),
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
  });
}

export function startWave(state: State, n: number): void {
  const def = waveDef(n);
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
