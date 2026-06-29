import { CONFIG } from "../config";
import type { Bullet } from "../types";

/**
 * Advance client-predicted "ghost" tracers (visual-only, negative-id) one step and drop
 * the expired/out-of-arena ones. Ghosts never collide — the real, host-authoritative
 * bullet (and all damage) arrives via snapshot; these only kill the perceived shot delay.
 * Pure (no DOM/net) so it's unit-testable.
 */
export function advanceGhosts(ghosts: Bullet[], dt: number): Bullet[] {
  const a = CONFIG.arena;
  const alive: Bullet[] = [];
  for (const g of ghosts) {
    g.px = g.x;
    g.py = g.y;
    g.x += g.vx * dt;
    g.y += g.vy * dt;
    g.life -= dt;
    if (g.life > 0 && Math.abs(g.x) <= a && Math.abs(g.y) <= a) alive.push(g);
  }
  return alive;
}
