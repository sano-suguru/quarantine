import { describe, expect, it } from "vitest";
import { CONFIG } from "../../sim/config";
import type { Bullet } from "../../sim/types";
import { advanceGhosts } from "./ghost";

function ghost(over: Partial<Bullet> = {}): Bullet {
  return {
    id: -1,
    x: 0,
    y: 0,
    px: 0,
    py: 0,
    vx: 100,
    vy: 0,
    r: 4,
    dmg: 0,
    life: 0.12,
    pierce: 0,
    knockback: 0,
    color: [1, 1, 1],
    ...over,
  };
}

describe("advanceGhosts (client visual tracers)", () => {
  it("integrates position, records the previous point, and decays life", () => {
    const g = ghost({ x: 10, y: 5, vx: 100, vy: 0, life: 0.12 });
    const out = advanceGhosts([g], 0.1);
    expect(out).toHaveLength(1);
    expect(g.x).toBeCloseTo(20, 5); // 10 + 100*0.1
    expect(g.px).toBe(10); // previous x captured for the tracer line
    expect(g.life).toBeCloseTo(0.02, 5);
  });

  it("drops a ghost once its life runs out", () => {
    expect(advanceGhosts([ghost({ life: 0.05 })], 0.1)).toHaveLength(0);
  });

  it("drops a ghost that leaves the arena", () => {
    const g = ghost({ x: CONFIG.arena - 1, vx: 1000, life: 10 });
    expect(advanceGhosts([g], 0.1)).toHaveLength(0); // flew past the arena edge
  });

  it("keeps survivors and is a no-op on an empty list", () => {
    expect(advanceGhosts([], 0.016)).toEqual([]);
    expect(advanceGhosts([ghost({ life: 1 })], 0.016)).toHaveLength(1);
  });
});
