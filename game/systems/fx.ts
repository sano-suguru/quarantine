import { CONFIG } from "../config";
import { clamp, lerp, mixRGB, rand } from "../engine/math";
import type { ParticleKind, State } from "../types";

type RGB = [number, number, number];

/**
 * Pure gore intensity (0..1) for one hit, split out for unit testing (mirrors
 * flashlightIntensity's scalar style). The base is the weapon's ABSOLUTE damage, so a
 * heavy gun always sprays more; the fraction-of-hp contributes only as a near-lethal
 * "finisher" bonus, so a light tap on a low-hp mob does NOT over-gore.
 */
export function goreIntensity(
  dmgDealt: number,
  hpAfter: number,
  maxHp: number,
  dmgRef: number,
  lowHpBand: number,
  finisherBonus: number,
): number {
  const absScale = clamp(dmgDealt / dmgRef, 0, 1);
  const fracAfter = Math.max(0, hpAfter) / maxHp;
  const finisher = hpAfter <= 0 ? 1 : fracAfter <= lowHpBand ? 1 - fracAfter / lowHpBand : 0;
  return clamp(absScale + finisherBonus * finisher, 0, 1);
}

/**
 * Pure: how many flesh chunks a hit should emit. Gated by an intensity threshold and
 * throttled against the live particle fill ratio so gibs (the only NEW particle source)
 * can never starve muzzle/spark/blood FX out of the shared cap. Stateless — no live-gib
 * counter to keep in sync with expiry.
 */
export function gibsToSpawn(
  intensity: number,
  fillRatio: number,
  threshold: number,
  countMin: number,
  countMax: number,
  fillCap: number,
): number {
  if (intensity < threshold) return 0;
  if (fillRatio >= fillCap) return 0;
  return Math.round(lerp(countMin, countMax, intensity) * (1 - fillRatio));
}

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
  if (state.particles.length >= CONFIG.fx.maxParticles) return;
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

/** muzzle flash at the gun tip: a hot powder flash + a forward flame cone + ejected embers */
export function fxMuzzle(state: State, x: number, y: number, aim: number, color: RGB): void {
  // hot white-yellow flash core — a single bright pop, deliberately NOT weapon-tinted so it
  // reads as igniting powder rather than the old dull colored halo
  spawn(state, x, y, 0, 0, 0.05, 22, [1, 0.92, 0.62], "spark", 0);
  // forward flame tongues: a few hot streaks spat in a tight cone straight down the barrel,
  // giving the flash a direction (the old symmetric ring read as a halo, not a muzzle blast)
  for (let i = 0; i < 3; i++) {
    const a = aim + rand(-0.18, 0.18);
    const sp = rand(260, 460);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.05, 0.1),
      rand(5, 8),
      [1, 0.85, 0.5],
      "spark",
      8,
    );
  }
  // ejected embers: warm debris, half-blended toward the weapon's color so each gun keeps a
  // hint of its identity at the muzzle (this is why fxMuzzle still takes `color`)
  const ember = mixRGB(color, [1, 0.55, 0.2], 0.5);
  for (let i = 0; i < 4; i++) {
    const a = aim + rand(-0.5, 0.5);
    const sp = rand(150, 360);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.1, 0.2),
      rand(2, 3.5),
      ember,
      "spark",
      6,
    );
  }
  // the firing player's muzzle-flash timer is set in fireWeapon (per-player)
}

/** sparks + blood where a hit bites flesh; richer the harder/closer-to-lethal the hit (intensity 0..1).
 *  intensity defaults to 0 so non-combat callers (wall/barricade/RTB sparks) render exactly as before. */
export function fxImpact(
  state: State,
  x: number,
  y: number,
  dir: number,
  color: RGB,
  intensity = 0,
): void {
  const g = CONFIG.fx.gore;
  const sparks = Math.round(lerp(g.sparks[0], g.sparks[1], intensity));
  for (let i = 0; i < sparks; i++) {
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
  bloodSpeck(state, x, y, color, Math.round(lerp(g.specks[0], g.specks[1], intensity)));
  bloodPool(state, x, y, intensity >= g.poolBigAt, dir);
  // flesh chunks on heavy / finishing hits — throttled so they never starve muzzle/spark FX
  const fill = state.particles.length / CONFIG.fx.maxParticles;
  const gibs = gibsToSpawn(
    intensity,
    fill,
    g.gibThreshold,
    g.gibCount[0],
    g.gibCount[1],
    g.gibFillCap,
  );
  for (let i = 0; i < gibs; i++) {
    const a = dir + rand(-0.7, 0.7);
    const sp = rand(80, 260);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.25, 0.5),
      rand(2, 4.5),
      color,
      "shard",
      4,
    );
  }
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

/** a small satisfying pop when an item is collected */
export function fxPickup(state: State, x: number, y: number, glow: RGB): void {
  spawn(state, x, y, 0, 0, 0.3, 16, glow, "ring", 0);
  for (let i = 0; i < 8; i++) {
    const a = rand(0, 6.28);
    const sp = rand(80, 200);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.2, 0.4),
      rand(1.5, 3),
      glow,
      "spark",
      6,
    );
  }
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

/**
 * A blood pool: a layered cluster, not one flat disc. A dark base blob plus satellites that
 * blend toward the brighter edge color and (when `dir` is given) bias along the hit direction
 * to read as a splatter tail rather than a stamp.
 */
function bloodPool(state: State, x: number, y: number, big: boolean, dir?: number): void {
  const cfg = CONFIG.fx.blood;
  const dx = dir === undefined ? 0 : Math.cos(dir);
  const dy = dir === undefined ? 0 : Math.sin(dir);
  const baseR = big ? cfg.baseRadiusBig : cfg.baseRadiusSmall;
  pushDecal(state, x, y, rand(baseR[0], baseR[1]), cfg.centerColor);
  for (let i = 0; i < cfg.satellites; i++) {
    const sx = x + rand(-cfg.satSpread, cfg.satSpread) + dx * rand(0, cfg.splatterBias);
    const sy = y + rand(-cfg.satSpread, cfg.satSpread) + dy * rand(0, cfg.splatterBias);
    const t = rand(0, 1); // outer droplets blend toward the brighter edge color
    const color: RGB = mixRGB(cfg.centerColor, cfg.edgeColor, t);
    pushDecal(state, sx, sy, rand(cfg.satRadius[0], cfg.satRadius[1]), color);
  }
}

function pushDecal(state: State, x: number, y: number, r: number, color: RGB): void {
  const cfg = CONFIG.fx.blood;
  if (state.decals.length >= cfg.maxDecals) state.decals.shift();
  const life = rand(cfg.life[0], cfg.life[1]);
  state.decals.push({
    x,
    y,
    r,
    rot: rand(0, 6.28),
    color: [color[0], color[1], color[2]],
    life,
    maxLife: life,
  });
}

/** advance all visual-only state: particles, blood decals */
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
