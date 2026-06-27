import { DEPLOYABLE_TYPES } from "../data/deployables";
import { len } from "../engine/math";
import { allocId } from "../state";
import type { State, Zombie } from "../types";
import { spawnPickup } from "./pickups";

/**
 * Tick placed fortifications (host sim only — clients see them via the snapshot, and the
 * turret's bullets / station's pickups sync through the existing bullet & pickup paths, so
 * no extra wiring). Emitters drop a pickup every `interval`; turrets track and shoot the
 * nearest zombie in range. Runs after sysAI so the zombie set is current.
 */
export function sysDeployables(state: State, dt: number): void {
  for (const d of state.deployables) {
    const def = DEPLOYABLE_TYPES[d.defId];
    if (!def) continue;
    if (d.cd > 0) d.cd -= dt;

    if (def.kind === "emitter") {
      if (d.cd <= 0) {
        spawnPickup(state, d.x, d.y, def.emit ?? "ammo");
        d.cd = def.interval;
      }
      continue;
    }

    // turret: aim at and fire on the nearest zombie within range
    const range = def.range ?? 360;
    let nearest: Zombie | null = null;
    let bestD = range;
    for (const z of state.zombies) {
      const dist = len(z.x - d.x, z.y - d.y);
      if (dist < bestD) {
        bestD = dist;
        nearest = z;
      }
    }
    if (!nearest) continue;
    d.aim = Math.atan2(nearest.y - d.y, nearest.x - d.x);
    if (d.cd <= 0) {
      const speed = def.bulletSpeed ?? 900;
      state.bullets.push({
        id: allocId(state),
        x: d.x,
        y: d.y,
        px: d.x,
        py: d.y,
        vx: Math.cos(d.aim) * speed,
        vy: Math.sin(d.aim) * speed,
        r: 4,
        dmg: def.dmg ?? 12,
        life: range / speed,
        pierce: 0,
        knockback: 4,
        color: def.color,
      });
      d.cd = def.interval;
    }
  }
}
