import { CONFIG } from "../config";
import { circlePush, circlePushFromSegment } from "../engine/geometry";
import { allocId } from "../state";
import { fxActionBurst } from "../systems/fx";
import type { Deployable, DeployableDef, Player, State } from "../types";

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
    weapon: {
      range: 380,
      dmg: 22,
      bulletSpeed: 900,
      interval: 0.4,
      mag: { size: 18, reloadTime: 2.5 },
    },
    destructible: { maxHp: 160, contactRadius: 16, contactDps: 18 },
    collider: { radius: 12 }, // physical body (~turret base) → blocks a lane; zombies pile & chew it
    color: [0.6, 0.85, 1.0],
  },
  // Append-only (see WIRE CONTRACT above). drone = weapon + movement + destructible.
  drone: {
    id: "drone",
    name: "Hunter Drone",
    desc: "Mobile drone — follows the squad and hunts nearby zombies",
    cost: 150,
    cap: 2,
    weapon: {
      range: 320,
      dmg: 26,
      bulletSpeed: 800,
      interval: 0.2,
      mag: { size: 24, reloadTime: 1.3, ammoBudget: 90 },
    },
    movement: {
      speed: 210,
      leashMax: 160,
      hoverDist: 95, // far enough out of the player's personal-light pool that the drone's own
      // light reads as a separate source at night (was 46 — washed out hugging the player)
      engageDist: 64,
      switchMargin: 80,
      orbitSpeed: 0.7,
      scanFreq: 1.3,
      scanAmp: 0.25,
    },
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

/** Placement footprint used to offset a fresh deployable in front of the player, even for
 *  bodyless types (drone/station) so they don't spawn dead-centre on the player sprite. */
function footprint(def: DeployableDef): number {
  return def.collider?.radius ?? 14;
}

/**
 * Can a deployable of `def` sit at (x, y)? Always rejects out-of-bounds. A type WITH a collider
 * (a physical body) additionally can't overlap a solid wall or another body — so it never lands
 * inside geometry or stacked on an existing turret. Bodyless types (drone hovers, station has no
 * body) only need to be in-bounds. Barricades (boardable openings = the chokepoints you fortify)
 * are intentionally NOT rejected. Pure/deterministic so host & clients agree.
 */
export function canPlaceAt(state: State, x: number, y: number, def: DeployableDef): boolean {
  const bound = CONFIG.arena - 8;
  if (x < -bound || x > bound || y < -bound || y > bound) return false;
  const col = def.collider;
  if (!col) return true;
  for (const w of state.walls) if (circlePushFromSegment(x, y, col.radius, w)) return false;
  for (const d of state.deployables) {
    const oc = DEPLOYABLE_TYPES[d.defId]?.collider;
    if (oc && circlePush(x, y, col.radius, d.x, d.y, oc.radius)) return false;
  }
  return true;
}

/**
 * Push a moving circle entity (player or zombie) out of every deployable that has a physical
 * body, so a placed structure blocks the lane. Mutates the entity in place; the deployable is
 * immovable (full separation applied to the entity). Host-only sim — deliberately NOT run in the
 * client's own-player prediction (it reconciles to the host position via the snapshot), so a
 * deployable's destruction can't desync a "phantom wall" between predicted and authoritative sets.
 */
export function resolveDeployableCollisions(
  e: { x: number; y: number; r: number },
  state: State,
): void {
  for (const d of state.deployables) {
    const oc = DEPLOYABLE_TYPES[d.defId]?.collider;
    if (!oc) continue;
    const push = circlePush(e.x, e.y, e.r, d.x, d.y, oc.radius);
    if (push) {
      e.x += push.dx;
      e.y += push.dy;
    }
  }
}

/**
 * Where a fresh `def` lands when `player` places it: just in front along their aim, stepping the
 * offset down toward the feet if the forward spot is blocked (a wall-facing press still places
 * rather than silently failing). Returns null only if even the feet are invalid. Host-authoritative
 * (host runs this against the requesting player's synced pos/aim — no coords cross the wire).
 */
export function placeSpot(
  state: State,
  player: Player,
  def: DeployableDef,
): { x: number; y: number } | null {
  const dist0 = player.r + footprint(def) + 6;
  const ux = Math.cos(player.aim);
  const uy = Math.sin(player.aim);
  for (const f of [1, 0.6, 0.3, 0]) {
    const x = player.x + ux * dist0 * f;
    const y = player.y + uy * dist0 * f;
    if (canPlaceAt(state, x, y, def)) return { x, y };
  }
  return null;
}

/** Place a deployable at (x, y) (the field placement spot from `placeSpot`). Initialises the
 *  host-only sim state for whichever capabilities the def has, plus the synced display defaults
 *  (full hp, not reloading). */
export function placeDeployable(state: State, defId: string, x: number, y: number): void {
  const def = DEPLOYABLE_TYPES[defId];
  if (!def) return;
  const d: Deployable = { id: allocId(state), defId, x, y, aim: 0, hpFrac: 1, reloading: false };
  if (def.weapon) {
    d.weaponCd = 0;
    d.reloadT = 0;
    if (def.weapon.mag) d.ammoLeft = def.weapon.mag.size;
    if (def.weapon.mag?.ammoBudget !== undefined) d.reserveLeft = def.weapon.mag.ammoBudget;
  }
  // schedule the first drop at the next interval grid boundary (where the beacon resets), so the
  // drop cadence is in phase with the state.time-driven beacon rather than offset by placement time.
  if (def.emitter)
    d.emitAt = (Math.floor(state.time / def.emitter.interval) + 1) * def.emitter.interval;
  if (def.destructible) d.hp = def.destructible.maxHp;
  state.deployables.push(d);
  fxActionBurst(state, x, y, def.color, false);
}
