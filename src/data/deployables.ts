import { allocId } from "../state";
import type { Deployable, DeployableDef, State } from "../types";
import { HOME_SPAWN } from "./map";

/**
 * Data-driven fortification catalogue. A deployable is bought in the shop with the buyer's
 * own credits (individual wallet) and auto-placed at the base — the placed structure then
 * benefits the whole squad, but the wall/turret guards the shelter the buyer is in too, so
 * there's an intrinsic private benefit (no pure public good → no free-rider). Behaviour is
 * composed from capability blocks (weapon/emitter/movement/destructible) — adding a new mix
 * is pure data; sysDeployables runs whichever blocks a def has.
 *
 * WIRE CONTRACT: the *key declaration order* below IS the snapshot defId wire index
 * (DEPLOYABLE_ORDER = Object.keys, snapshot.ts). DO NOT reorder existing keys; append new
 * types at the end only. (snapshot.test.ts pins the indices as a forcing function.)
 */
export const DEPLOYABLE_TYPES: Record<string, DeployableDef> = {
  ammostation: {
    id: "ammostation",
    name: "Supply Station",
    desc: "Periodically drops ammo for the squad at the base",
    cost: 70,
    cap: 3,
    emitter: { emit: "ammo", interval: 8 },
    color: [1.0, 0.82, 0.3],
  },
  sentry: {
    id: "sentry",
    name: "Auto-Sentry",
    desc: "Fixed turret — auto-fires at the nearest zombie",
    cost: 120,
    cap: 3,
    weapon: { range: 380, dmg: 14, bulletSpeed: 900, interval: 0.7, magSize: 18, reloadTime: 2.5 },
    destructible: { maxHp: 160, contactRadius: 16, contactDps: 18 },
    color: [0.6, 0.85, 1.0],
  },
  // Append-only (see WIRE CONTRACT above). drone = weapon + movement + destructible.
  drone: {
    id: "drone",
    name: "Hunter Drone",
    desc: "Mobile drone — follows the squad and hunts nearby zombies",
    cost: 150,
    cap: 2,
    weapon: { range: 320, dmg: 10, bulletSpeed: 800, interval: 0.5, magSize: 10, reloadTime: 2.2 },
    movement: { speed: 210, leashMax: 160, hoverDist: 46, switchMargin: 80 },
    destructible: { maxHp: 60, contactRadius: 20, contactDps: 24 },
    visual: "drone",
    color: [1.0, 0.45, 0.25],
  },
};

/** How many of `defId` are currently placed. */
export function deployableCount(state: State, defId: string): number {
  let n = 0;
  for (const d of state.deployables) if (d.defId === defId) n++;
  return n;
}

/**
 * Auto-placement: spread fortifications across the boarded HOME openings (the chokepoints
 * worth defending). Pick the opening with the fewest deployables nearby and set the new one
 * just inside it (offset toward the HOME spawn). Falls back to the spawn if there are no
 * openings. Deterministic so host & clients agree.
 */
function placePos(state: State): { x: number; y: number } {
  const bars = state.barricades;
  if (bars.length === 0) return { x: HOME_SPAWN.x, y: HOME_SPAWN.y };
  let best = bars[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const b of bars) {
    const mx = (b.x1 + b.x2) / 2;
    const my = (b.y1 + b.y2) / 2;
    let count = 0;
    for (const d of state.deployables) {
      if ((d.x - mx) ** 2 + (d.y - my) ** 2 < 60 * 60) count++;
    }
    if (count < bestCount) {
      bestCount = count;
      best = b;
    }
  }
  const b = best as NonNullable<typeof best>;
  const mx = (b.x1 + b.x2) / 2;
  const my = (b.y1 + b.y2) / 2;
  const dx = HOME_SPAWN.x - mx;
  const dy = HOME_SPAWN.y - my;
  const l = Math.hypot(dx, dy) || 1;
  return { x: mx + (dx / l) * 40, y: my + (dy / l) * 40 };
}

/** Place a freshly-bought deployable at the base (called from the shop buy path). Initialises
 *  the host-only sim state for whichever capabilities the def has, plus the synced display
 *  defaults (full hp, not reloading). */
export function placeDeployable(state: State, defId: string): void {
  const def = DEPLOYABLE_TYPES[defId];
  if (!def) return;
  const { x, y } = placePos(state);
  const d: Deployable = { id: allocId(state), defId, x, y, aim: 0, hpFrac: 1, reloading: false };
  if (def.weapon) {
    d.weaponCd = 0;
    d.reloadT = 0;
    if (def.weapon.magSize !== undefined) d.ammoLeft = def.weapon.magSize;
  }
  if (def.emitter) d.emitCd = 0;
  if (def.destructible) d.hp = def.destructible.maxHp;
  state.deployables.push(d);
}
