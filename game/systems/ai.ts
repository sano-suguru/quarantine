import { CONFIG } from "../config";
import { resolveDeployableCollisions } from "../data/deployables";
import { phaseMods } from "../data/phaseMods";
import { Audio } from "../engine/audio";
import { circlePush, circlePushFromSegment } from "../engine/geometry";
import { len, rand } from "../engine/math";
import { buildFlowField, sampleFlow } from "../engine/navfield";
import { localPlayer, nearestPlayer } from "../engine/players";
import { avoidHeading } from "../engine/steering";
import type { NavMode, State, Zombie } from "../types";
import { fxHurt, fxImpact } from "./fx";

/** Desired heading for a zombie this frame — extracted from pass-1 verbatim (nav: "none").
 *  dx/dy is the normalized direction to the target (0,0 if no target). */
function headingNone(
  z: Zombie,
  state: State,
  chasing: boolean,
  dx: number,
  dy: number,
  wanderMul: number,
  dt: number,
): { hx: number; hy: number } {
  if (chasing) {
    const a = Math.sin(state.time * 3 + z.wob) * z.wander * 0.5;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return { hx: dx * c - dy * s, hy: dx * s + dy * c };
  }
  z.wanderDir += rand(-1, 1) * z.wander * wanderMul * 3 * dt;
  return { hx: Math.cos(z.wanderDir), hy: Math.sin(z.wanderDir) };
}

type SteerCtx = {
  z: Zombie;
  state: State;
  chasing: boolean;
  dx: number;
  dy: number;
  wanderMul: number;
  dt: number;
};
const NAV_STEER: Record<NavMode, (c: SteerCtx) => { hx: number; hy: number }> = {
  none: (c) => headingNone(c.z, c.state, c.chasing, c.dx, c.dy, c.wanderMul, c.dt),
  avoid: (c) => {
    const base = headingNone(c.z, c.state, c.chasing, c.dx, c.dy, c.wanderMul, c.dt);
    const bl = Math.hypot(base.hx, base.hy) || 1;
    const CFG = CONFIG.ai.nav;
    return avoidHeading(c.z.x, c.z.y, base.hx / bl, base.hy / bl, c.state.walls, {
      look: CFG.whiskerLook,
      whiskerAngle: CFG.whiskerAngle,
      strength: CFG.avoidStrength,
    });
  },
  path: (c) => {
    if (!c.chasing || !c.state.flow)
      return headingNone(c.z, c.state, c.chasing, c.dx, c.dy, c.wanderMul, c.dt);
    const g = sampleFlow(c.state.flow, c.z.x, c.z.y);
    if (g.hx === 0 && g.hy === 0)
      return headingNone(c.z, c.state, c.chasing, c.dx, c.dy, c.wanderMul, c.dt);
    // smooth final approach / opening traversal with whiskers
    const CFG = CONFIG.ai.nav;
    return avoidHeading(c.z.x, c.z.y, g.hx, g.hy, c.state.walls, {
      look: CFG.whiskerLook,
      whiskerAngle: CFG.whiskerAngle,
      strength: CFG.avoidStrength,
    });
  },
};

const WOOD: [number, number, number] = [0.62, 0.42, 0.2];
const LUNGE_DUR = 0.3; // seconds a runner's dash lasts

export function sysAI(state: State, dt: number): void {
  const Z = state.zombies;
  const lp = localPlayer(state);
  const mod = phaseMods(state.phase, state.day);
  const CFG = CONFIG.ai.nav;

  // rebuild flow field every rebuildFrames ticks (or on first call when flow is null)
  state.navTick++;
  if (state.navTick % CFG.rebuildFrames === 0 || state.flow === null) {
    const living = state.players.filter((p) => p.hp > 0 && !p.absent);
    const b = {
      minX: -CONFIG.arena,
      minY: -CONFIG.arena,
      maxX: CONFIG.arena,
      maxY: CONFIG.arena,
    };
    state.flow = living.length
      ? buildFlowField(state.walls, living, b, CFG.cell, CFG.clearance)
      : null;
  }

  state.hash.clear();
  for (let i = 0; i < Z.length; i++) {
    const z = Z[i] as (typeof Z)[number];
    state.hash.insert(i, z.x, z.y);
  }

  const kbK = Math.exp(-CONFIG.feel.knockbackDecay * dt);
  const surroundR2 = CONFIG.horror.surroundRadius * CONFIG.horror.surroundRadius;
  const lureR2 = CONFIG.cache.lureRadius * CONFIG.cache.lureRadius;
  const coneCos = Math.cos(CONFIG.flashlight.halfAngle);
  const aimX = Math.cos(lp.aim);
  const aimY = Math.sin(lp.aim);
  let near = 0;
  let lurking = 0;

  // ---- pass 1: steer, move, resolve walls/barricades, attack ----
  for (let i = 0; i < Z.length; i++) {
    const z = Z[i] as (typeof Z)[number];
    if (z.flash > 0) z.flash -= dt;
    if (z.spawnT > 0) z.spawnT -= dt;

    // dread is measured from the LOCAL player's viewpoint (this client's own fear)
    const ldx = lp.x - z.x;
    const ldy = lp.y - z.y;
    const ldist = len(ldx, ldy) || 1;
    if (ldist * ldist < surroundR2) {
      near++;
      if ((ldx / ldist) * aimX + (ldy / ldist) * aimY < coneCos) lurking++;
    }

    // steer toward the nearest living player (everyone is a target in co-op)
    const target = nearestPlayer(state, z.x, z.y);
    let dx = 0;
    let dy = 0;
    let dist = Number.POSITIVE_INFINITY;
    if (target) {
      dx = target.x - z.x;
      dy = target.y - z.y;
      dist = len(dx, dy) || 1;
      dx /= dist;
      dy /= dist;
      // aggro latches on once sensed; night auto-aggros (mod.autoAggro), day needs line-of-sense
      if (mod.autoAggro || dist <= z.sense * mod.senseMul) z.chasing = true;
    }
    const chasing = z.chasing && target !== null;

    // desired heading
    const { hx, hy } = NAV_STEER[z.nav]({
      z,
      state,
      chasing,
      dx,
      dy,
      wanderMul: mod.wanderMul,
      dt,
    });

    // soft steering separation (weakened; positional de-overlap does the hard work)
    let sx = 0;
    let sy = 0;
    state.hash.query(z.x, z.y, z.r * 2.5, (j) => {
      if (j === i) return;
      const o = Z[j];
      if (!o) return;
      const ox = z.x - o.x;
      const oy = z.y - o.y;
      const d = len(ox, oy);
      const minD = z.r + o.r;
      if (d > 0 && d < minD) {
        const f = (minD - d) / minD;
        sx += (ox / d) * f;
        sy += (oy / d) * f;
      }
    });
    const vx = hx + sx * 0.6 * z.separation;
    const vy = hy + sy * 0.6 * z.separation;
    const vl = len(vx, vy) || 1;

    // lunge: runners periodically dash while chasing
    if (chasing && z.lunge > 0 && mod.lunge) {
      if (z.lungeT > 0) z.lungeT -= dt;
      else {
        z.lungeCd -= dt;
        if (z.lungeCd <= 0) {
          z.lungeT = LUNGE_DUR;
          z.lungeCd = z.lungePeriod;
        }
      }
    }
    const emerge = z.spawnT > 0 ? 0.35 : 1;
    const roamMul = chasing ? 1 : 0.45;
    const lungeMul = z.lungeT > 0 ? z.lunge : 1;
    // lure: a player rummaging a cache at night draws nearby zombies in faster (the "noise").
    // Final multiplier so every type gets the same relative bump regardless of lunge state.
    // Gated to night because searching is now set day+night (for the rummage motion draw);
    // without this gate, day scavenging would gain a zombie lure it never had.
    let lureMul = 0;
    if (state.phase === "night") {
      for (const pl of state.players) {
        if (!pl.searching) continue;
        const lx = pl.x - z.x;
        const ly = pl.y - z.y;
        if (lx * lx + ly * ly <= lureR2) {
          lureMul = CONFIG.cache.lureSpeedSurge;
          break;
        }
      }
    }
    const spd = z.speed * mod.speedMul * emerge * roamMul * lungeMul * (1 + lureMul);
    z.x += (vx / vl) * spd * dt + z.vx * dt;
    z.y += (vy / vl) * spd * dt + z.vy * dt;
    z.vx *= kbK;
    z.vy *= kbK;

    if (z.attackCd > 0) z.attackCd -= dt;

    resolveWalls(state, z);

    // intact barricades block — and the zombie smashes the one it presses against
    for (const bar of state.barricades) {
      if (bar.hp <= 0) continue;
      const push = circlePushFromSegment(z.x, z.y, z.r, bar);
      if (!push) continue;
      z.x += push.dx;
      z.y += push.dy;
      if (z.spawnT <= 0 && z.attackCd <= 0) {
        bar.hp -= z.dmg;
        bar.flash = 0.12;
        z.attackCd = 1 / z.attackRate;
        fxImpact(state, z.x, z.y, Math.atan2(-push.dy, -push.dx), WOOD);
        if (bar.hp <= 0) state.cam.shake = Math.min(state.cam.shake + 6, 20);
      }
    }

    if (target && z.spawnT <= 0 && dist < z.r + target.r + 2 && z.attackCd <= 0) {
      target.hp -= z.dmg;
      z.attackCd = 1 / z.attackRate;
      if (target.iframe <= 0) {
        target.hitFlash = 0.28;
        target.iframe = CONFIG.feel.hurtIframe;
        fxHurt(state, target.x, target.y);
        // screen flash, camera shake and the pain grunt are the LOCAL player's own feedback
        if (target.id === state.localId) {
          state.flashT = Math.min(1, state.flashT + 0.7);
          state.flashColor = [1, 0.18, 0.18];
          state.cam.shake = Math.min(state.cam.shake + 8, 20);
          Audio.hurt();
        }
      }
      if (target.hp <= 0) target.hp = 0;
    }
  }

  // also decay flash on barricades nothing pressed against this frame
  for (const bar of state.barricades) if (bar.flash > 0) bar.flash = Math.max(0, bar.flash - dt);

  // ---- pass 2: hard positional de-overlap (buffered so it's order-independent) ----
  state.hash.clear();
  for (let i = 0; i < Z.length; i++) {
    const z = Z[i] as (typeof Z)[number];
    state.hash.insert(i, z.x, z.y);
  }
  const bx = new Float32Array(Z.length);
  const by = new Float32Array(Z.length);
  for (let i = 0; i < Z.length; i++) {
    const z = Z[i] as (typeof Z)[number];
    state.hash.query(z.x, z.y, z.r * 2, (j) => {
      if (j <= i) return; // resolve each pair once
      const o = Z[j];
      if (!o) return;
      const push = circlePush(z.x, z.y, z.r, o.x, o.y, o.r);
      if (!push) return;
      const hx = push.dx * 0.5;
      const hy = push.dy * 0.5;
      bx[i] = (bx[i] ?? 0) + hx;
      by[i] = (by[i] ?? 0) + hy;
      bx[j] = (bx[j] ?? 0) - hx;
      by[j] = (by[j] ?? 0) - hy;
    });
  }
  for (let i = 0; i < Z.length; i++) {
    const z = Z[i] as (typeof Z)[number];
    z.x += bx[i] as number;
    z.y += by[i] as number;
    // each player is a solid obstacle: shove the zombie out (players stay put)
    for (const pl of state.players) {
      if (pl.hp <= 0 || pl.absent) continue;
      const pp = circlePush(z.x, z.y, z.r, pl.x, pl.y, pl.r);
      if (pp) {
        z.x += pp.dx;
        z.y += pp.dy;
      }
    }
    // solid deployable bodies (e.g. a sentry) block zombies too → a placed turret is a chokepoint
    resolveDeployableCollisions(z, state);
    // walls have the final say so nothing gets shoved through them
    resolveWalls(state, z);
  }

  state.surrounded = near;
  state.lurking = lurking;
}

/** push a zombie out of every solid wall it overlaps */
function resolveWalls(state: State, z: State["zombies"][number]): void {
  for (const w of state.walls) {
    const push = circlePushFromSegment(z.x, z.y, z.r, w);
    if (push) {
      z.x += push.dx;
      z.y += push.dy;
    }
  }
}
