import { CONFIG } from "../config";
import { Audio } from "../engine/audio";
import { len } from "../engine/math";
import { sampleFlow } from "../engine/navfield";
import { nearestPlayer } from "../engine/players";
import type { Player, State } from "../types";
import { flashlightIntensity } from "./flashlight";
import { fxHurt, fxImpact } from "./fx";

const CFG = CONFIG.stalker;
const FLC = CONFIG.flashlight;

// Time-correlated flicker noise (reuses same approach as game.ts flickerNoise, seeded by 0).
function stalkerFlickerNoise(t: number): number {
  const base = 0.5 + 0.3 * Math.sin(t * 9.1) + 0.2 * Math.sin(t * 23.7);
  const surge = Math.max(0, Math.sin(t * 2.3)) ** 6;
  return Math.max(0, Math.min(1, base * 0.5 + surge));
}

/**
 * Returns true if the given player's flashlight cone covers the stalker's position AND
 * the flashlight is actually on (flashlightIntensity > 0). A player in the dark must
 * NOT ward the stalker — else turning off the light would still be "safe".
 */
function playerWardsStalker(pl: Player, sx: number, sy: number, t: number): boolean {
  if (pl.hp <= 0 || pl.absent) return false;

  // Gate first: light must actually be ON and have charge.
  const intensity = flashlightIntensity(
    pl.battery / FLC.batteryMax,
    pl.lightOn,
    FLC.lowThreshold,
    FLC.flickerDepth,
    FLC.baseFlickerDepth,
    stalkerFlickerNoise(t),
    FLC.dimFloor,
    FLC.dimStart,
  );
  if (intensity <= 0) return false;

  // Cone check: direction from player to stalker must be within the flashlight half-angle.
  const dx = sx - pl.x;
  const dy = sy - pl.y;
  const dist = len(dx, dy) || 1;
  if (dist > FLC.range) return false;

  const coneCos = Math.cos(FLC.halfAngle);
  const aimX = Math.cos(pl.aim);
  const aimY = Math.sin(pl.aim);
  const dot = (dx / dist) * aimX + (dy / dist) * aimY;
  return dot > coneCos;
}

/**
 * Return the "loudest" living player (highest noise), breaking ties by distance.
 * Falls back to nearest if no player has noise > 0.
 */
function loudestPlayer(state: State, sx: number, sy: number): Player | null {
  let best: Player | null = null;
  let bestNoise = -1;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const p of state.players) {
    if (p.hp <= 0 || p.absent) continue;
    const d = len(p.x - sx, p.y - sy);
    if (p.noise > bestNoise || (p.noise === bestNoise && d < bestDist)) {
      bestNoise = p.noise;
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/**
 * Return the first living player whose flashlight currently wards the stalker, or null.
 * Used both to determine whether a ward is active and to identify who pays the battery cost.
 */
function wardingPlayer(state: State, sx: number, sy: number): Player | null {
  for (const pl of state.players) {
    if (playerWardsStalker(pl, sx, sy, state.time)) return pl;
  }
  return null;
}

export function sysStalker(state: State, dt: number): void {
  const s = state.stalker;
  if (!s) return;

  const target = loudestPlayer(state, s.x, s.y);
  const warder = wardingPlayer(state, s.x, s.y);
  const lit = warder !== null;

  // Decay contact cooldown
  if (s.contactCd > 0) s.contactCd -= dt;

  switch (s.state) {
    case "lull": {
      if (!target) break;
      // aggro when target is near or loud
      const dist = len(target.x - s.x, target.y - s.y);
      if (dist < CFG.spawnDist * 0.7 || target.noise > 0) {
        s.state = "aggro";
      }
      // slow drift toward target while in lull
      const dx = target.x - s.x;
      const dy = target.y - s.y;
      const d = len(dx, dy) || 1;
      s.x += (dx / d) * CFG.staggerSpeed * 0.5 * dt;
      s.y += (dy / d) * CFG.staggerSpeed * 0.5 * dt;
      s.face = Math.atan2(dy, dx);
      break;
    }

    case "aggro": {
      if (!target) break;

      if (lit) {
        // Caught in the beam → stagger. Nick the warding player's battery once on this edge
        // (tiny cost so warding isn't entirely free; the ward is a flick, not a hold).
        warder.battery = Math.max(0, warder.battery - CFG.wardBatteryCost);
        s.state = "stagger";
        s.staggerT = CFG.staggerWindow;
        break;
      }

      // Advance toward target with flow-field routing + aim-bias
      const dx = target.x - s.x;
      const dy = target.y - s.y;
      const dist = len(dx, dy) || 1;

      // Face toward target
      s.face = Math.atan2(dy, dx);

      // Desired heading: flow field if available, else straight (two-stage fallback)
      let hx = dx / dist;
      let hy = dy / dist;

      if (state.flow) {
        const g = sampleFlow(state.flow, s.x, s.y);
        if (g.hx !== 0 || g.hy !== 0) {
          hx = g.hx;
          hy = g.hy;
        }
      }

      // Aim-opposite bias: nudge away from where the target is aiming so the stalker
      // tends to approach from the blind side (CONFIG.stalker.noiseBias).
      const aimX = Math.cos(target.aim);
      const aimY = Math.sin(target.aim);
      const bx = hx - aimX * CFG.noiseBias * 0.15;
      const by = hy - aimY * CFG.noiseBias * 0.15;
      const bl = len(bx, by) || 1;

      s.x += (bx / bl) * CFG.advanceSpeed * dt;
      s.y += (by / bl) * CFG.advanceSpeed * dt;

      // Contact: check dist (already computed above), both suppressors gated independently
      if (dist < CFG.contactDist && s.contactCd <= 0) {
        if (target.iframe <= 0) {
          target.hp -= CFG.contactDamage;
          target.hitFlash = 0.28;
          target.iframe = CONFIG.feel.hurtIframe;
          fxHurt(state, target.x, target.y);
          // Local-only feedback: flash + shake + pain grunt
          if (target.id === state.localId) {
            state.flashT = Math.min(1, state.flashT + 0.7);
            state.flashColor = [0.8, 0.1, 0.8]; // cold purple for the stalker grab
            state.cam.shake = Math.min(
              state.cam.shake + CONFIG.feel.shakeMax,
              CONFIG.feel.shakeMax,
            );
            Audio.hurt();
          }
          if (target.hp <= 0) target.hp = 0;
        }
        // Set BOTH suppressors: contactCd (stalker re-grab) and iframe (victim multi-hit)
        s.contactCd = CFG.contactCd;
        // Knock stalker back and briefly retreat
        const nx = s.x - target.x;
        const ny = s.y - target.y;
        const nl = len(nx, ny) || 1;
        s.x += (nx / nl) * 40;
        s.y += (ny / nl) * 40;
        s.state = "retreat";
      }
      break;
    }

    case "stagger": {
      s.staggerT -= dt;
      // While still lit, refresh the stagger window (lingering flash-ward)
      if (lit) s.staggerT = CFG.staggerWindow;

      // Brief backward recede — stays short because vis fades out quickly (Step 1)
      if (target) {
        const dx = s.x - target.x;
        const dy = s.y - target.y;
        const d = len(dx, dy) || 1;
        s.x += (dx / d) * CFG.staggerSpeed * dt;
        s.y += (dy / d) * CFG.staggerSpeed * dt;
        s.face = Math.atan2(target.y - s.y, target.x - s.x);
      }

      // When fully vanished: relocate to a fresh far dark spot and return to lull.
      // vis stays at 0 so it fades back in gradually as it re-approaches.
      if (s.vis <= 0) {
        placeStalker(state, s);
        s.state = "lull";
        break;
      }

      if (s.staggerT <= 0) s.state = "aggro";
      break;
    }

    case "retreat": {
      // Move away from the target
      if (target) {
        const dx = s.x - target.x;
        const dy = s.y - target.y;
        const d = len(dx, dy) || 1;
        s.x += (dx / d) * CFG.retreatSpeed * dt;
        s.y += (dy / d) * CFG.retreatSpeed * dt;
        s.face = Math.atan2(dy, dx);
      } else {
        // No target: flee in current facing direction
        s.x += Math.cos(s.face) * CFG.retreatSpeed * dt;
        s.y += Math.sin(s.face) * CFG.retreatSpeed * dt;
      }

      // Despawn when sufficiently off-arena
      const offArena = Math.abs(s.x) > CONFIG.arena * 1.3 || Math.abs(s.y) > CONFIG.arena * 1.3;
      if (offArena) despawnStalker(state);
      break;
    }
  }

  // Fade out while staggered (melts into the dark); fade in otherwise.
  if (s.state === "stagger") {
    s.vis = Math.max(0, s.vis - dt * CFG.wardFadeOut);
  } else {
    s.vis = Math.min(1, s.vis + dt * 2);
  }
}

/**
 * Place (or relocate) the stalker at spawnDist from the nearest living player,
 * at an angle away from the player's aim (enter from the blind side).
 * Mutates s in place — call this for both initial spawn and ward-triggered relocates.
 */
function placeStalker(state: State, s: NonNullable<State["stalker"]>): void {
  const target = nearestPlayer(state, 0, 0);
  if (!target) return;

  // Bias spawn angle to approach from opposite the player's aim (the dark side)
  const awayFromAim = target.aim + Math.PI + (Math.random() - 0.5) * Math.PI;
  const dist = CFG.spawnDist;
  s.x = target.x + Math.cos(awayFromAim) * dist;
  s.y = target.y + Math.sin(awayFromAim) * dist;
  s.face = Math.atan2(target.y - s.y, target.x - s.x);
}

/**
 * React to a bullet impact: knockback along the bullet direction + a brief vis dip (flinch
 * flicker). No hp, no death, no stagger/banish — light is still the only real ward.
 * Skipped entirely when the stalker is not visible (vis <= 0.1) so a faded/vanished stalker
 * can't be interacted with.
 */
export function flinchStalker(
  state: State,
  bx: number,
  by: number,
  dirX: number,
  dirY: number,
): void {
  const s = state.stalker;
  if (!s || s.vis <= 0.1) return;

  // Knockback: push along the bullet's travel direction
  const dl = len(dirX, dirY) || 1;
  s.x += (dirX / dl) * CFG.bulletKnockback;
  s.y += (dirY / dl) * CFG.bulletKnockback;

  // Vis dip: a cold recoil flicker; floor at 0.2 so it doesn't accidentally trigger the
  // ward-stagger vanish path (which only fires when vis hits 0 inside "stagger" state).
  s.vis = Math.max(0.2, s.vis - CFG.bulletFlinch);

  // Cold spark at the hit point (purple tint — matches the stalker's grab flash colour).
  const coldSpark: [number, number, number] = [0.6, 0.1, 0.9];
  fxImpact(state, bx, by, Math.atan2(dirY, dirX), coldSpark);
}

/**
 * Spawn the stalker at spawnDist from the nearest living player,
 * at an angle away from the player's aim (enter from the blind side).
 * State starts as "lull".
 */
export function spawnStalker(state: State): void {
  const target = nearestPlayer(state, 0, 0);
  if (!target) return;

  // Temporary object to pass to placeStalker; placeStalker fills x/y/face.
  const s: NonNullable<State["stalker"]> = {
    x: 0,
    y: 0,
    face: 0,
    state: "lull",
    staggerT: 0,
    contactCd: 0,
    vis: 0,
  };
  placeStalker(state, s);
  state.stalker = s;
}

/** Immediately remove the stalker from the world. */
export function despawnStalker(state: State): void {
  state.stalker = null;
}
