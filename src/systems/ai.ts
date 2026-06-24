import { len } from "../engine/math";
import type { State } from "../types";

export function sysAI(state: State, dt: number): void {
  const Z = state.zombies;
  const p = state.player;
  state.hash.clear();
  for (let i = 0; i < Z.length; i++) {
    const z = Z[i] as (typeof Z)[number];
    state.hash.insert(i, z.x, z.y);
  }

  for (let i = 0; i < Z.length; i++) {
    const z = Z[i] as (typeof Z)[number];
    let dx = p.x - z.x;
    let dy = p.y - z.y;
    const dist = len(dx, dy) || 1;
    dx /= dist;
    dy /= dist;
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
    const vx = dx + sx * 1.4;
    const vy = dy + sy * 1.4;
    const vl = len(vx, vy) || 1;
    z.x += (vx / vl) * z.speed * dt;
    z.y += (vy / vl) * z.speed * dt;

    if (z.attackCd > 0) z.attackCd -= dt;
    if (dist < z.r + p.r + 2 && z.attackCd <= 0) {
      p.hp -= z.dmg;
      z.attackCd = 1 / z.attackRate;
      state.cam.shake = Math.min(state.cam.shake + 6, 16);
      if (p.hp <= 0) p.hp = 0;
    }
  }
}
