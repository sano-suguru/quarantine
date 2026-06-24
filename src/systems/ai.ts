import { CONFIG } from "../config";
import { Audio } from "../engine/audio";
import { len } from "../engine/math";
import type { State } from "../types";
import { fxHurt } from "./fx";

export function sysAI(state: State, dt: number): void {
  const Z = state.zombies;
  const p = state.player;
  state.hash.clear();
  for (let i = 0; i < Z.length; i++) {
    const z = Z[i] as (typeof Z)[number];
    state.hash.insert(i, z.x, z.y);
  }

  const kbK = Math.exp(-CONFIG.feel.knockbackDecay * dt);
  const surroundR2 = CONFIG.horror.surroundRadius * CONFIG.horror.surroundRadius;
  let near = 0;

  for (let i = 0; i < Z.length; i++) {
    const z = Z[i] as (typeof Z)[number];
    if (z.flash > 0) z.flash -= dt;
    if (z.spawnT > 0) z.spawnT -= dt;

    let dx = p.x - z.x;
    let dy = p.y - z.y;
    const dist = len(dx, dy) || 1;
    dx /= dist;
    dy /= dist;
    if (dist * dist < surroundR2) near++;
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
    // newly-spawned zombies crawl in slower (telegraph)
    const emerge = z.spawnT > 0 ? 0.35 : 1;
    const vx = dx + sx * 1.4;
    const vy = dy + sy * 1.4;
    const vl = len(vx, vy) || 1;
    z.x += (vx / vl) * z.speed * emerge * dt + z.vx * dt;
    z.y += (vy / vl) * z.speed * emerge * dt + z.vy * dt;
    z.vx *= kbK;
    z.vy *= kbK;

    if (z.attackCd > 0) z.attackCd -= dt;
    if (z.spawnT <= 0 && dist < z.r + p.r + 2 && z.attackCd <= 0) {
      p.hp -= z.dmg;
      z.attackCd = 1 / z.attackRate;
      // heavy feedback, throttled so a swarm doesn't machine-gun it
      if (p.iframe <= 0) {
        p.hitFlash = 0.28;
        p.iframe = CONFIG.feel.hurtIframe;
        state.flashT = Math.min(1, state.flashT + 0.7);
        state.flashColor = [1, 0.18, 0.18];
        state.cam.shake = Math.min(state.cam.shake + 8, 20);
        fxHurt(state, p.x, p.y);
        Audio.hurt();
      }
      if (p.hp <= 0) p.hp = 0;
    }
  }
  state.surrounded = near;
}
