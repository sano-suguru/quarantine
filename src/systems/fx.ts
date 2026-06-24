import { rand } from "../engine/math";
import type { ParticleKind, State } from "../types";

const MAX_PARTICLES = 2400;
const MAX_TEXTS = 160;
const MAX_DECALS = 360;

type RGB = [number, number, number];

function spawn(
  state: State,
  x: number,
  y: number,
  vx: number,
  vy: number,
  life: number,
  r: number,
  color: RGB,
  kind: ParticleKind,
  drag: number,
): void {
  if (state.particles.length >= MAX_PARTICLES) return;
  state.particles.push({
    x,
    y,
    vx,
    vy,
    life,
    maxLife: life,
    r,
    rot: rand(0, 6.28),
    color,
    kind,
    drag,
  });
}

/** muzzle flash + ejected sparks at the gun tip */
export function fxMuzzle(state: State, x: number, y: number, aim: number, color: RGB): void {
  spawn(state, x, y, 0, 0, 0.07, 26, color, "ring", 0);
  for (let i = 0; i < 5; i++) {
    const a = aim + rand(-0.4, 0.4);
    const sp = rand(180, 420);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.08, 0.18),
      rand(2, 4),
      color,
      "spark",
      6,
    );
  }
  state.player.muzzle = 0.05;
}

/** sparks where a bullet bites a zombie */
export function fxImpact(state: State, x: number, y: number, dir: number, color: RGB): void {
  for (let i = 0; i < 6; i++) {
    const a = dir + rand(-1.0, 1.0);
    const sp = rand(120, 360);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.1, 0.25),
      rand(1.5, 3.5),
      color,
      "spark",
      7,
    );
  }
  bloodSpeck(state, x, y, color, 3);
}

/** death burst — shockwave ring, viscera shards, glowing embers */
export function fxKill(
  state: State,
  x: number,
  y: number,
  color: RGB,
  glow: RGB,
  big: boolean,
): void {
  const n = big ? 22 : 12;
  spawn(state, x, y, 0, 0, big ? 0.32 : 0.22, big ? 46 : 26, glow, "ring", 0);
  for (let i = 0; i < n; i++) {
    const a = rand(0, 6.28);
    const sp = rand(60, big ? 240 : 180);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.25, 0.6),
      rand(1.5, big ? 4.5 : 3),
      color,
      "shard",
      4,
    );
  }
  for (let i = 0; i < n / 2; i++) {
    const a = rand(0, 6.28);
    const sp = rand(60, 220);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.2, 0.45),
      rand(2, 4),
      glow,
      "spark",
      5,
    );
  }
  bloodPool(state, x, y, big);
}

/** red spray when the player is mauled */
export function fxHurt(state: State, x: number, y: number): void {
  const blood: RGB = [0.8, 0.12, 0.12];
  for (let i = 0; i < 10; i++) {
    const a = rand(0, 6.28);
    const sp = rand(100, 320);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.2, 0.4),
      rand(2, 4),
      blood,
      "shard",
      5,
    );
  }
  bloodPool(state, x, y, false);
}

/** a couple of dark droplets that settle as a small decal */
function bloodSpeck(state: State, x: number, y: number, _color: RGB, n: number): void {
  const blood: RGB = [0.42, 0.05, 0.05];
  for (let i = 0; i < n; i++) {
    const a = rand(0, 6.28);
    const sp = rand(40, 140);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.15, 0.35),
      rand(1.5, 3),
      blood,
      "shard",
      6,
    );
  }
}

function bloodPool(state: State, x: number, y: number, big: boolean): void {
  if (state.decals.length >= MAX_DECALS) state.decals.shift();
  const life = rand(26, 40);
  state.decals.push({
    x: x + rand(-3, 3),
    y: y + rand(-3, 3),
    r: big ? rand(18, 28) : rand(9, 16),
    rot: rand(0, 6.28),
    color: [rand(0.22, 0.34), 0.03, 0.04],
    life,
    maxLife: life,
  });
}

export function fxDamageText(
  state: State,
  x: number,
  y: number,
  value: number,
  crit: boolean,
): void {
  if (state.texts.length >= MAX_TEXTS) state.texts.shift();
  state.texts.push({
    x: x + rand(-6, 6),
    y,
    vy: -rand(60, 90),
    life: crit ? 0.85 : 0.6,
    maxLife: crit ? 0.85 : 0.6,
    value: Math.round(value),
    crit,
  });
}

/** advance all visual-only state: particles, floating text, blood decals */
export function sysFx(state: State, dt: number): void {
  const P = state.particles;
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i] as (typeof P)[number];
    p.life -= dt;
    if (p.life <= 0) {
      P[i] = P[P.length - 1] as (typeof P)[number];
      P.pop();
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.kind === "ring") {
      p.r += (p.r * 4 + 120) * dt; // expand
    } else {
      const k = Math.exp(-p.drag * dt);
      p.vx *= k;
      p.vy *= k;
    }
  }

  const T = state.texts;
  for (let i = T.length - 1; i >= 0; i--) {
    const t = T[i] as (typeof T)[number];
    t.life -= dt;
    if (t.life <= 0) {
      T[i] = T[T.length - 1] as (typeof T)[number];
      T.pop();
      continue;
    }
    t.y += t.vy * dt;
    t.vy *= Math.exp(-3 * dt);
  }

  const D = state.decals;
  for (let i = D.length - 1; i >= 0; i--) {
    const d = D[i] as (typeof D)[number];
    d.life -= dt;
    if (d.life <= 0) {
      D[i] = D[D.length - 1] as (typeof D)[number];
      D.pop();
    }
  }
}
