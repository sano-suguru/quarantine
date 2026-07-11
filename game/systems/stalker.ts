import { CONFIG } from "../config";
import { len } from "../engine/math";
import { sampleFlow } from "../engine/navfield";
import { nearestPlayer } from "../engine/players";
import { pushFx } from "../sim/events";
import type { Player, State } from "../types";

const CFG = CONFIG.stalker;

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

export function sysStalker(state: State, dt: number): void {
  const s = state.stalker;
  if (!s) return;

  const target = loudestPlayer(state, s.x, s.y);

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
          pushFx(state, {
            t: "hurt",
            x: target.x,
            y: target.y,
            local: target.id === state.localId,
          });
          // Pain grunt for the local victim (host). The visual scare (flash/shake/lurch/stinger)
          // lives in game.ts:draw() keyed off the synced contactCd edge, so it fires identically
          // on the host and on a client victim (whose grunt comes from the hitFlash re-derivation).
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
      // Dead state — wire index preserved for co-op snapshot stability (do not reorder or delete).
      // Light-ward was removed; this state is no longer reachable. Fall back to aggro immediately.
      s.state = "aggro";
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

  // Vis always fades in as the stalker approaches — no ward fade-out path remains.
  s.vis = Math.min(1, s.vis + dt * 2);
}

/**
 * Place the stalker at spawnDist from the nearest living player, at an angle
 * away from that player's aim (enter from the blind side). Mutates s in place.
 * Only called on spawn now — the ward-triggered relocate path was removed.
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
