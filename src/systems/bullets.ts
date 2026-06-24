import { CONFIG } from "../config";
import { Audio } from "../engine/audio";
import { len } from "../engine/math";
import type { State } from "../types";
import { fxDamageText, fxImpact, fxKill } from "./fx";

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
          fxImpact(state, b.x, b.y, dir, b.color);
          fxDamageText(state, z.x, z.y - z.r, b.dmg, b.dmg >= 30);
          Audio.hit();
          if (b.pierce > 0) {
            b.pierce--;
          } else {
            dead = true;
          }
          if (z.hp <= 0) killZombie(state, zi);
        }
      });
    }
    if (dead) {
      B[bi] = B[B.length - 1] as (typeof B)[number];
      B.pop();
    }
  }
}

export function killZombie(state: State, idx: number): void {
  const z = state.zombies[idx];
  if (!z) return;
  const big = z.type === "brute";
  fxKill(state, z.x, z.y, z.color, z.glow, big);
  Audio.kill(big);
  state.cam.shake = Math.min(state.cam.shake + (big ? 9 : 3), 20);
  state.hitstopT = Math.max(state.hitstopT, CONFIG.feel.hitstop * (big ? 1.8 : 1));
  state.money += z.bounty;
  state.kills++;
  state.zombies[idx] = state.zombies[state.zombies.length - 1] as (typeof state.zombies)[number];
  state.zombies.pop();
}
