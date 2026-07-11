import { DEPLOYABLE_TYPES } from "../data/deployables";
import { waveDef } from "../data/waves";
import { clamp, len } from "../engine/math";
import { nearestPlayer } from "../engine/players";
import { pushFx } from "../sim/events";
import { allocId } from "../state";
import type { Deployable, DeployableDef, SiegePhase, State, Zombie } from "../types";
import { spawnPickup } from "./pickups";

/** Deployable damage multiplier. At night it IS the enemy `hpScale` for that night (the caller
 *  passes `waveDef(state.day).hpScale`), so a deployable's shots-to-kill ratio is preserved all
 *  run from a single source of truth; during the day, roamers are base HP (hpScale 1) AND
 *  `state.day` already holds the upcoming night's number, so we return 1. */
export function deployDmgScale(phase: SiegePhase, nightHpScale: number): number {
  return phase === "night" ? nightHpScale : 1;
}

/** Rounds to load into the magazine on reload, drawn from the finite reserve (clamped ≥ 0). */
export function reloadRefill(reserveLeft: number, magSize: number): number {
  return Math.min(magSize, Math.max(0, reserveLeft));
}

/** A budgeted unit retires (RTB) once it can neither fire nor reload: reserve and magazine empty.
 *  Infinite-reserve units (no ammoBudget) never retire this way. */
export function deployRetired(hasBudget: boolean, reserveLeft: number, ammoLeft: number): boolean {
  return hasBudget && reserveLeft <= 0 && ammoLeft <= 0;
}

/**
 * Tick placed fortifications (host sim only — clients see them via the snapshot, and the
 * turret's bullets / station's pickups sync through the existing bullet & pickup paths). Each
 * deployable runs whichever capability blocks its def has, in a fixed order: movement first
 * (so targeting/contact use the new position), then weapon, emitter, and destruction last.
 * Destroyed units are swap-popped after the loop (index-based, order not preserved).
 */
export function sysDeployables(state: State, dt: number): void {
  const dead: number[] = [];
  for (let i = 0; i < state.deployables.length; i++) {
    const d = state.deployables[i] as Deployable;
    const def = DEPLOYABLE_TYPES[d.defId];
    if (!def) continue;
    if (def.movement) tickMovement(state, d, def, dt);
    if (def.weapon) tickWeapon(state, d, def, dt);
    if (def.emitter) tickEmitter(state, d, def);
    if (def.destructible) tickDamage(state, d, def, dt);
    // remaining-ammo fraction for the client ring (reserve + current mag over full load; 1 if infinite)
    const mag = def.weapon?.mag;
    d.ammoFrac =
      mag?.ammoBudget !== undefined
        ? clamp(((d.reserveLeft ?? 0) + (d.ammoLeft ?? 0)) / (mag.ammoBudget + mag.size), 0, 1)
        : 1;
    // removal: destroyed (hp<=0) OR retired (ammo budget spent)
    const destroyed = !!def.destructible && (d.hp ?? 0) <= 0;
    const retired = deployRetired(
      mag?.ammoBudget !== undefined,
      d.reserveLeft ?? 0,
      d.ammoLeft ?? 0,
    );
    if (destroyed || retired) {
      dead.push(i);
      if (destroyed)
        pushFx(state, { t: "deployDestroy", x: d.x, y: d.y, color: def.color, rtb: false }); // loud destruction burst (no flesh — it's a machine)
      else pushFx(state, { t: "deployDestroy", x: d.x, y: d.y, color: def.color, rtb: true }); // soft power-down on RTB
    }
  }
  for (let k = dead.length - 1; k >= 0; k--) {
    const i = dead[k] as number;
    const last = state.deployables.length - 1;
    state.deployables[i] = state.deployables[last] as Deployable;
    state.deployables.pop();
  }
}

/** Leash-follow the nearest alive player; drift toward the current target to engage, clamped
 *  within leashMax of the anchor. Anchor selection is sticky (hysteresis) to avoid oscillating
 *  between equidistant players. */
function tickMovement(state: State, d: Deployable, def: DeployableDef, dt: number): void {
  const m = def.movement as NonNullable<DeployableDef["movement"]>;
  // resolve anchor: keep the current one while it's alive & present; otherwise pick the nearest.
  let anchor = state.players.find((p) => p.id === d.anchorId && p.hp > 0 && !p.absent) ?? null;
  if (!anchor) anchor = nearestPlayer(state, d.x, d.y);
  else {
    const near = nearestPlayer(state, d.x, d.y);
    // only switch if a different player is meaningfully closer than the current anchor
    if (near && near.id !== anchor.id) {
      const dCur = len(anchor.x - d.x, anchor.y - d.y);
      const dNew = len(near.x - d.x, near.y - d.y);
      if (dCur - dNew > m.switchMargin) anchor = near;
    }
  }
  if (!anchor) return; // no one to follow → hold position
  d.anchorId = anchor.id;

  // desired position: stand off from the target if one exists, else hover behind the anchor
  let gx: number;
  let gy: number;
  const target = d.targetId != null ? state.zombies.find((z) => z.id === d.targetId) : undefined;
  if (target) {
    // engage: strafe a ring around the target rather than parking between it and the player —
    // same time-driven sweep as the idle orbit below, so the angle carries over without a pop.
    // Then leash the goal to the anchor so the drone circles its prey without abandoning the
    // player to chase a distant zombie. Aim is set toward the target in tickWeapon.
    const a = ((d.id * 1.618) % (Math.PI * 2)) + state.time * m.orbitSpeed;
    gx = target.x + Math.cos(a) * m.engageDist;
    gy = target.y + Math.sin(a) * m.engageDist;
    const lx = gx - anchor.x;
    const ly = gy - anchor.y;
    const ld = len(lx, ly);
    if (ld > m.leashMax) {
      gx = anchor.x + (lx / ld) * m.leashMax;
      gy = anchor.y + (ly / ld) * m.leashMax;
    }
  } else {
    // idle: orbit the anchor on watch. the per-id golden-angle phase spreads multiple drones
    // around the ring; state.time drives the sweep so it's deterministic (host & client agree).
    const a = ((d.id * 1.618) % (Math.PI * 2)) + state.time * m.orbitSpeed;
    gx = anchor.x + Math.cos(a) * m.hoverDist;
    gy = anchor.y + Math.sin(a) * m.hoverDist;
    // face the direction of travel (orbit tangent) + a slow scan wobble
    d.aim = a + Math.PI / 2 + Math.sin(state.time * m.scanFreq) * m.scanAmp;
  }

  const dx = gx - d.x;
  const dy = gy - d.y;
  const dist = len(dx, dy);
  if (dist < 1e-4) return; // already on the goal — skip the 0/0 normalize
  // Seek the goal every frame; min() lands exactly on it, so there's no overshoot to damp.
  // (No stop-band here: the idle orbit goal sweeps slowly — ~orbitSpeed*hoverDist u/s — while
  // speed is far higher, so a deadzone made the drone overshoot in, freeze, then snap forward,
  // a visible stop-go judder that the d.x-coupled hover bob amplified.)
  const step = Math.min(m.speed * dt, dist);
  d.x += (dx / dist) * step;
  d.y += (dy / dist) * step;
}

/** Acquire (with target hysteresis) the nearest zombie in range, aim, and fire on the weapon
 *  cooldown. An optional `mag` (size/reloadTime) caps sustained DPS with a reload gap — interval
 *  is the per-shot cooldown, mag.reloadTime is the magazine refill. No ammo purchase. */
function tickWeapon(state: State, d: Deployable, def: DeployableDef, dt: number): void {
  const w = def.weapon as NonNullable<DeployableDef["weapon"]>;
  if ((d.weaponCd ?? 0) > 0) d.weaponCd = (d.weaponCd ?? 0) - dt;

  // target hysteresis: prefer keeping the current target (while alive & in range), but switch
  // to the nearest if it's >15% closer — so a point-blank zombie isn't ignored for one that
  // lingered out at the range edge, without flip-flopping between near-equidistant ones.
  let nearest: Zombie | null = null;
  let bestD = w.range;
  for (const z of state.zombies) {
    const dist = len(z.x - d.x, z.y - d.y);
    if (dist < bestD) {
      bestD = dist;
      nearest = z;
    }
  }
  const cur = d.targetId != null ? state.zombies.find((z) => z.id === d.targetId) : undefined;
  const curD = cur ? len(cur.x - d.x, cur.y - d.y) : Number.POSITIVE_INFINITY;
  let target: Zombie | null;
  if (cur && curD <= w.range && !(nearest && bestD < curD * 0.85)) {
    target = cur; // keep current
  } else if (nearest) {
    target = nearest;
    d.targetId = nearest.id;
  } else {
    target = null;
    d.targetId = undefined; // no zombie in range → release so tickMovement returns to orbit
  }

  // magazine: while reloading, hold fire; when it completes, refill and reset the shot cd so
  // the unit fires immediately rather than waiting another interval on top of the reload.
  if (w.mag && (d.reloadT ?? 0) > 0) {
    d.reloadT = (d.reloadT ?? 0) - dt;
    if ((d.reloadT ?? 0) <= 0) {
      d.reloadT = 0;
      if (w.mag.ammoBudget !== undefined) {
        const refill = reloadRefill(d.reserveLeft ?? 0, w.mag.size);
        d.ammoLeft = refill;
        d.reserveLeft = (d.reserveLeft ?? 0) - refill;
      } else {
        d.ammoLeft = w.mag.size;
      }
      d.weaponCd = 0;
    }
  }

  if (target) {
    d.aim = Math.atan2(target.y - d.y, target.x - d.x);
    const canFire =
      (d.reloadT ?? 0) <= 0 && (d.weaponCd ?? 0) <= 0 && (!w.mag || (d.ammoLeft ?? 0) > 0);
    if (canFire) {
      const speed = w.bulletSpeed;
      const dmg = w.dmg * deployDmgScale(state.phase, waveDef(state.day).hpScale);
      state.bullets.push({
        id: allocId(state),
        x: d.x,
        y: d.y,
        px: d.x,
        py: d.y,
        vx: Math.cos(d.aim) * speed,
        vy: Math.sin(d.aim) * speed,
        r: 4,
        dmg,
        life: w.range / speed,
        pierce: 0,
        knockback: 4,
        color: def.color,
      });
      d.weaponCd = w.interval;
      if (w.mag) {
        d.ammoLeft = (d.ammoLeft ?? 0) - 1;
        if ((d.ammoLeft ?? 0) <= 0) d.reloadT = w.mag.reloadTime;
      }
    }
  }

  // summarise display state last, so it reflects a shot that just emptied the magazine
  d.reloading = (d.reloadT ?? 0) > 0;
  if (def.destructible) d.hpFrac = clamp((d.hp ?? 0) / def.destructible.maxHp, 0, 1);
}

/** Drop a pickup on the absolute `interval` grid (`state.time` crossing k*interval), so the drop
 *  lands exactly where the beacon resets. Advancing `emitAt` by `interval` (not re-arming relative
 *  to now) keeps it on the grid with no drift, and clients see the same cadence as the host since
 *  both are driven by the synced `state.time`. */
function tickEmitter(state: State, d: Deployable, def: DeployableDef): void {
  const e = def.emitter as NonNullable<DeployableDef["emitter"]>;
  if (d.emitAt === undefined) d.emitAt = (Math.floor(state.time / e.interval) + 1) * e.interval;
  if (state.time >= d.emitAt) {
    spawnPickup(state, d.x, d.y, e.emit);
    d.emitAt += e.interval;
  }
}

/** Take contact damage from any zombie within contactRadius. Zombies don't path toward
 *  deployables (sysAI is untouched) — a unit only gets hit when it sits next to the horde
 *  (a fixed sentry behind barricades only on a breach; a drone whenever it dives in). */
function tickDamage(state: State, d: Deployable, def: DeployableDef, dt: number): void {
  const c = def.destructible as NonNullable<DeployableDef["destructible"]>;
  let touched = false;
  for (const z of state.zombies) {
    if (len(z.x - d.x, z.y - d.y) < c.contactRadius + z.r) {
      touched = true;
      break;
    }
  }
  if (touched) d.hp = (d.hp ?? c.maxHp) - c.contactDps * dt;
  d.hpFrac = clamp((d.hp ?? c.maxHp) / c.maxHp, 0, 1);
}
