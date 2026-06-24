import { CONFIG } from "../config";
import { len } from "../engine/math";
import type { State } from "../types";

export function sysBullets(state: State, dt: number): void {
  const B = state.bullets;
  const Z = state.zombies;
  for (let bi = B.length - 1; bi >= 0; bi--) {
    const b = B[bi] as (typeof B)[number];
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    let dead = b.life <= 0 || Math.abs(b.x) > CONFIG.arena || Math.abs(b.y) > CONFIG.arena;
    if (!dead) {
      state.hash.query(b.x, b.y, b.r + 30, (zi) => {
        if (dead) return;
        const z = Z[zi];
        if (!z) return;
        if (len(z.x - b.x, z.y - b.y) < z.r + b.r) {
          z.hp -= b.dmg;
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
  state.money += z.bounty;
  state.kills++;
  state.zombies[idx] = state.zombies[state.zombies.length - 1] as (typeof state.zombies)[number];
  state.zombies.pop();
}
