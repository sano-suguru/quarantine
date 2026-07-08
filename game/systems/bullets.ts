import { CONFIG } from "../config";
import { ENEMY_TYPES } from "../data/enemies";
import { Audio } from "../engine/audio";
import { segmentHitsSegment } from "../engine/geometry";
import { len } from "../engine/math";
import type { State } from "../types";
import { awardBounty } from "./economy";
import { fxImpact, fxKill, goreIntensity } from "./fx";
import { dropFromKill } from "./pickups";
import { flinchStalker } from "./stalker";

const STONE: [number, number, number] = [0.5, 0.52, 0.5];

export function sysBullets(state: State, dt: number): void {
  const B = state.bullets;
  const Z = state.zombies;
  for (let bi = B.length - 1; bi >= 0; bi--) {
    const b = B[bi] as (typeof B)[number];
    b.px = b.x;
    b.py = b.y;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    let dead = b.life <= 0 || Math.abs(b.x) > CONFIG.arena || Math.abs(b.y) > CONFIG.arena;
    // solid walls stop bullets (windows/boards let you fire out)
    if (!dead) {
      for (const w of state.walls) {
        if (segmentHitsSegment(b.px, b.py, b.x, b.y, w.x1, w.y1, w.x2, w.y2)) {
          fxImpact(state, b.x, b.y, Math.atan2(b.vy, b.vx), STONE);
          dead = true;
          break;
        }
      }
    }
    if (!dead) {
      const dir = Math.atan2(b.vy, b.vx);
      const inv = 1 / (len(b.vx, b.vy) || 1);
      state.hash.query(b.x, b.y, b.r + 30, (zi) => {
        if (dead) return;
        const z = Z[zi];
        if (!z) return;
        if (len(z.x - b.x, z.y - b.y) < z.r + b.r) {
          z.hp -= b.dmg;
          z.flash = 0.12;
          z.vx += b.vx * inv * b.knockback;
          z.vy += b.vy * inv * b.knockback;
          const g = CONFIG.fx.gore;
          fxImpact(
            state,
            b.x,
            b.y,
            dir,
            b.color,
            goreIntensity(b.dmg, z.hp, z.maxHp, g.dmgRef, g.lowHpBand, g.finisherBonus),
          );
          Audio.hit();
          if (b.pierce > 0) {
            b.pierce--;
          } else {
            dead = true;
          }
          if (z.hp <= 0) killZombie(state, zi, dir); // gore flies in the shot direction
        }
      });
      // Stalker hit test: single-entity distance check (stalker isn't in state.hash).
      // Only when visible (vis > 0.1) — a faded stalker can't be hit.
      // After wall-stop and zombie-query so a wall-blocked bullet doesn't connect.
      if (!dead && state.stalker && state.stalker.vis > 0.1) {
        const sk = state.stalker;
        if (len(sk.x - b.x, sk.y - b.y) < CONFIG.stalker.contactDist + b.r) {
          flinchStalker(state, b.x, b.y, b.vx * inv, b.vy * inv);
          dead = true;
        }
      }
    }
    if (dead) {
      B[bi] = B[B.length - 1] as (typeof B)[number];
      B.pop();
    }
  }
}

export function killZombie(state: State, idx: number, hitDir: number | null = null): void {
  const z = state.zombies[idx];
  if (!z) return;
  const big = z.type === "brute";
  const sprite = ENEMY_TYPES[z.type]?.sprite ?? "";
  fxKill(state, z.x, z.y, z.color, z.glow, big, true, sprite, Math.atan2(z.vy, z.vx), z.r, hitDir);
  Audio.kill(big);
  // hit-stop slows the WHOLE sim and cam-shake is a local-view kick — in co-op these
  // would slow/shake the shared host view on every player's kill, so apply solo only
  if (state.players.length === 1) {
    state.cam.shake = Math.min(state.cam.shake + (big ? 9 : 3), 20);
    state.hitstopT = Math.max(state.hitstopT, CONFIG.feel.hitstop * (big ? 1.8 : 1));
  }
  awardBounty(state, z.x, z.y, z.bounty);
  state.kills++;
  dropFromKill(state, z.x, z.y, big);
  state.zombies[idx] = state.zombies[state.zombies.length - 1] as (typeof state.zombies)[number];
  state.zombies.pop();
}
