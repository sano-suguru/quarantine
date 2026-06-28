import { CONFIG } from "../config";
import { effWeapon } from "../data/arsenal";
import { resolveDeployableCollisions } from "../data/deployables";
import { WEAPON_ORDER } from "../data/weapons";
import { Audio } from "../engine/audio";
import { circlePushFromSegment } from "../engine/geometry";
import { approach, clamp, len, rand } from "../engine/math";
import type { PlayerInput } from "../net/playerInput";
import { allocId } from "../state";
import type { Cache, Player, Segment, State, WeaponDef } from "../types";

/**
 * Integrate one entity's WASD movement for `dt` and resolve solid walls. `moveMul` is the
 * equipped weapon's (ramped) move multiplier — light weapons kite, heavy weapons stand ground.
 * Shared by the host sim (sysPlayer) and the client's local-player prediction so both move
 * identically. Operates on anything with x/y/r/speed.
 */
export function integrateMovement(
  p: { x: number; y: number; r: number; speed: number },
  inp: PlayerInput,
  walls: Segment[],
  dt: number,
  moveMul = 1,
): void {
  let dx = inp.moveX;
  let dy = inp.moveY;
  const l = len(dx, dy);
  if (l > 0) {
    dx /= l;
    dy /= l;
  }
  p.x = clamp(p.x + dx * p.speed * moveMul * dt, -CONFIG.arena, CONFIG.arena);
  p.y = clamp(p.y + dy * p.speed * moveMul * dt, -CONFIG.arena, CONFIG.arena);
  // solid walls block movement (openings/barricades do not — you slip through)
  for (const w of walls) {
    const push = circlePushFromSegment(p.x, p.y, p.r, w);
    if (push) {
      p.x += push.dx;
      p.y += push.dy;
    }
  }
}

import { ammoTransfer } from "./ammo";
import { killZombie } from "./bullets";
import { lootCache } from "./caches";
import { fxDamageText, fxImpact, fxMuzzle } from "./fx";

/** Seconds of standing-still searching needed to loot a cache. Night searches take longer
 *  (CONFIG.cache.nightSearchMul) — the extra exposure is the risk of looting during the horde. */
export function effectiveSearchTime(phase: State["phase"]): number {
  return phase === "night"
    ? CONFIG.cache.searchTime * CONFIG.cache.nightSearchMul
    : CONFIG.cache.searchTime;
}

export function sysPlayer(state: State, dt: number): void {
  // caches a player is actively searching this tick (co-op: more than one player can
  // search, and a cache only loses progress when NOBODY is on it — see reset below)
  const searched = new Set<Cache>();
  for (const p of state.players) {
    if (p.hp > 0 && !p.absent) sysPlayerOne(state, p, dt, searched);
  }
  // a cache not searched by anyone this tick loses its progress
  for (const c of state.caches) if (!searched.has(c) && c.searchT > 0) c.searchT = 0;
}

function sysPlayerOne(state: State, p: Player, dt: number, searched: Set<Cache>): void {
  const inp = p.input;
  p.searching = false; // re-derived each tick; interact() sets it true while night-searching

  // F = toggle the flashlight (off = no drain, near-blind). Edge, consumed below.
  if (inp.lightToggle) {
    p.lightOn = !p.lightOn;
    Audio.click();
  }

  // drain the flashlight while it's on
  if (p.lightOn && p.battery > 0) {
    p.battery = Math.max(0, p.battery - CONFIG.flashlight.drainPerSec * dt);
  }

  // H = use a carried medkit: a deliberate, rooted heal-over-time. Edge, consumed below.
  if (inp.heal && p.medkits > 0 && p.healT <= 0 && p.hp < p.maxHp) {
    p.medkits--;
    p.healT = CONFIG.heal.duration;
    Audio.heal();
  }

  // healing roots the player: HP ticks up, but no moving or shooting (vulnerable)
  const healing = p.healT > 0;
  if (healing) {
    p.healT -= dt;
    p.hp = Math.min(p.maxHp, p.hp + (CONFIG.heal.amount / CONFIG.heal.duration) * dt);
  }

  const moving = inp.moveX !== 0 || inp.moveY !== 0;
  // ramp the move multiplier toward the equipped weapon's weight (advance even while healing so
  // host & client stay in lockstep; only the integration below is gated on healing). The ramp
  // is what stops quick-swap speed cheese — a fresh weapon's speed takes time to take effect.
  p.curMoveMul = approach(
    p.curMoveMul,
    effWeapon(p, p.weapon).moveMul,
    CONFIG.player.moveRampRate * dt,
  );
  // healing roots you in place; otherwise integrate movement + wall collision
  if (!healing) integrateMovement(p, inp, state.walls, dt, p.curMoveMul);
  // push out of solid deployable bodies (host-only — kept OUT of integrateMovement so the
  // client's own-player prediction stays collider-free; it reconciles to this via the snapshot)
  if (!healing) resolveDeployableCollisions(p, state);

  // E = context interact: repair a barricade you're next to, else search a cache
  interact(state, p, dt, healing, moving, searched);

  // aim is computed client-locally and arrives via the input snapshot
  p.aim = inp.aim;

  // switch weapons — only to ones you own; magazine state is preserved per weapon
  if (inp.weaponSlot !== null) {
    const id = WEAPON_ORDER[inp.weaponSlot];
    if (id && p.weapon !== id && state.owned[id]) {
      p.mags[p.weapon] = p.ammo; // stash the rounds left in the current mag
      p.weapon = id;
      p.ammo = p.mags[id] ?? 0; // restore the new weapon's mag
      p.reloadT = 0;
      // raise time: can't fire for a beat after switching (also blocks switch→instant-fire and
      // pairs with the move ramp so quick-swapping buys neither speed nor an instant shot)
      p.fireCd = Math.max(p.fireCd, CONFIG.player.switchRaise);
    }
  }
  const wd = effWeapon(p, p.weapon);

  // reload draws from this weapon's finite reserve (melee weapons never reload)
  if (!wd.melee) {
    const reserve = p.reserve[p.weapon] ?? 0;
    if ((inp.reload || p.ammo <= 0) && p.reloadT <= 0 && p.ammo < wd.mag && reserve > 0) {
      p.reloadT = wd.reload;
      Audio.reload();
    }
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) {
        const t = ammoTransfer(wd.mag, p.ammo, p.reserve[p.weapon] ?? 0);
        p.ammo = t.ammo;
        p.reserve[p.weapon] = t.reserve;
        Audio.reloadDone();
      }
    }
  }

  if (p.fireCd > 0) p.fireCd -= dt;
  const wantFire = inp.firing && (wd.auto || !p.firedThisHold);
  if (wantFire && p.fireCd <= 0 && p.reloadT <= 0 && !healing) {
    if (wd.melee || p.ammo > 0) {
      fireWeapon(state, p, wd);
      if (!wd.melee) p.ammo--;
      p.fireCd = 1 / (wd.fireRate * p.fireRateMul);
      p.firedThisHold = true;
    } else {
      // empty magazine: the desperate dry-fire click
      Audio.dryFire();
      p.dryT = 0.12;
      p.fireCd = 0.18;
      p.firedThisHold = true;
    }
  }
  if (!inp.firing) p.firedThisHold = false;

  // consume one-shot edges so multiple sim sub-steps in a frame don't re-fire them
  inp.reload = false;
  inp.heal = false;
  inp.lightToggle = false;
  inp.weaponSlot = null;

  // decay feel timers (visual offsets / cooldowns)
  const rk = Math.exp(-CONFIG.feel.recoilDecay * dt);
  p.recoilX *= rk;
  p.recoilY *= rk;
  if (p.hitFlash > 0) p.hitFlash -= dt;
  if (p.iframe > 0) p.iframe -= dt;
  if (p.muzzle > 0) p.muzzle -= dt;
  if (p.dryT > 0) p.dryT -= dt;
}

function fireWeapon(state: State, p: Player, wd: WeaponDef): void {
  if (wd.melee) {
    meleeSwing(state, p, wd);
    return;
  }
  const tipX = p.x + Math.cos(p.aim) * p.r;
  const tipY = p.y + Math.sin(p.aim) * p.r;
  for (let i = 0; i < wd.pellets; i++) {
    const a = p.aim + rand(-wd.spread, wd.spread);
    state.bullets.push({
      id: allocId(state),
      x: tipX,
      y: tipY,
      px: tipX,
      py: tipY,
      vx: Math.cos(a) * wd.bulletSpeed,
      vy: Math.sin(a) * wd.bulletSpeed,
      r: 4,
      dmg: wd.dmg * p.dmgMul,
      life: wd.range,
      pierce: wd.pierce,
      knockback: wd.knockback,
      color: wd.color,
    });
  }
  // recoil: shove the player back (per-player visual) + kick the camera (local view only,
  // so a teammate's gunfire doesn't shake the host's screen)
  if (p.id === state.localId) state.cam.shake = Math.min(state.cam.shake + wd.recoil, 18);
  p.recoilX -= Math.cos(p.aim) * wd.recoil * 0.9;
  p.recoilY -= Math.sin(p.aim) * wd.recoil * 0.9;
  fxMuzzle(state, tipX, tipY, p.aim, wd.color);
  p.muzzle = 0.05;
  Audio.shot(p.weapon);
}

/** A short melee arc: damage every zombie inside the cone in front of the player. */
function meleeSwing(state: State, p: Player, wd: WeaponDef): void {
  const Z = state.zombies;
  const reach = (wd.meleeRange ?? 30) + p.r;
  const arc = wd.meleeArc ?? 0.9;
  const dead: number[] = [];
  let connected = false;
  state.hash.query(p.x, p.y, reach + 40, (zi) => {
    const z = Z[zi];
    if (!z) return;
    const dx = z.x - p.x;
    const dy = z.y - p.y;
    const d = len(dx, dy) || 1;
    if (d > reach + z.r) return;
    // angular distance between the swing direction and the zombie
    let da = Math.atan2(dy, dx) - p.aim;
    da = Math.abs(Math.atan2(Math.sin(da), Math.cos(da)));
    if (da > arc) return;
    connected = true;
    z.hp -= wd.dmg * p.dmgMul;
    z.flash = 0.12;
    z.vx += (dx / d) * wd.knockback;
    z.vy += (dy / d) * wd.knockback;
    fxImpact(state, z.x, z.y, p.aim, wd.color);
    fxDamageText(state, z.x, z.y - z.r, wd.dmg * p.dmgMul, true);
    if (z.hp <= 0) dead.push(zi);
  });
  // swap-and-pop removal is index-based, so kill from the highest index down
  dead.sort((a, b) => b - a);
  for (const zi of dead) killZombie(state, zi);

  // swing feel — same kick/shake channel as a gun, plus a whoosh (shake = local view only).
  // recoilX/Y is a render-only offset (drawPlayer), so a forward sign reads as a lunging
  // stab without touching the collision position — a knife thrusts in, a gun kicks back.
  if (p.id === state.localId) state.cam.shake = Math.min(state.cam.shake + wd.recoil, 18);
  p.recoilX += Math.cos(p.aim) * wd.recoil * 0.9;
  p.recoilY += Math.sin(p.aim) * wd.recoil * 0.9;
  // landing a hit punches a beat of hitstop (solo only — hitstopT slows the WHOLE sim, so in
  // co-op it would freeze the shared host view on every teammate's swing; same guard as killZombie)
  if (connected && state.players.length === 1) {
    state.hitstopT = Math.max(state.hitstopT, CONFIG.feel.hitstop);
  }
  p.muzzle = 0.1; // longer than a gun (0.05) so the slash arc is readable at the swing cadence
  Audio.melee();
}

/**
 * Context interactions, split by cost (simplification: free = automatic, costed = E):
 *  - SEARCH (free): standing still near an unsearched cache (day) auto-searches, no button.
 *  - HEAL teammate (costs a medkit) / REPAIR wall (costs money): held E acts on the single
 *    NEAREST eligible target — picking by distance (not a fixed type priority) so a hurt
 *    teammate next to a damaged wall can't silently drain a medkit you meant for the wall.
 * Reviving a downed teammate is free and handled automatically in sysAssist (no E).
 */
function interact(
  state: State,
  p: Player,
  dt: number,
  healing: boolean,
  moving: boolean,
  searched: Set<Cache>,
): void {
  if (p.repairCd > 0) p.repairCd -= dt;
  const reach = CONFIG.siege.interactRadius;

  // nearest damaged barricade (repair target, E)
  let bar: (typeof state.barricades)[number] | null = null;
  let barD = reach;
  for (const b of state.barricades) {
    if (b.hp >= b.maxHp) continue;
    const mx = (b.x1 + b.x2) / 2;
    const my = (b.y1 + b.y2) / 2;
    const d = len(mx - p.x, my - p.y);
    if (d < barD) {
      barD = d;
      bar = b;
    }
  }

  // nearest hurt teammate (heal target, E) — only if we carry a medkit to give
  let mate: Player | null = null;
  let mateD = reach;
  if (p.medkits >= 1) {
    for (const o of state.players) {
      if (o.id === p.id || o.absent || o.hp <= 0 || o.hp >= o.maxHp) continue;
      const d = len(o.x - p.x, o.y - p.y);
      if (d < mateD) {
        mateD = d;
        mate = o;
      }
    }
  }

  // nearest unsearched cache (search target, auto). Searchable day AND night — at night it's
  // slower and the rummaging lures the horde (see below), but no longer silently disabled.
  let cache: (typeof state.caches)[number] | null = null;
  let cacheD = reach;
  for (const c of state.caches) {
    if (c.looted) continue;
    const d = len(c.x - p.x, c.y - p.y);
    if (d < cacheD) {
      cacheD = d;
      cache = c;
    }
  }

  // SEARCH: free, automatic — stand still near a cache (no E needed)
  if (cache && !moving && !healing) {
    cache.searchT += dt;
    searched.add(cache); // mark; sysPlayer resets only caches nobody searched
    // at night the rummaging is "noise" — flag this player so sysAI surges nearby zombies
    if (state.phase === "night") p.searching = true;
    if (cache.searchT >= effectiveSearchTime(state.phase)) {
      lootCache(state, cache.x, cache.y, cache.tier);
      cache.looted = true;
      cache.searchT = 0;
      Audio.pickup();
    }
  }

  // HEAL / REPAIR: costed, held E acts on the nearest eligible target (rate-limited)
  if (p.input.interactHeld && !healing && p.repairCd <= 0) {
    if (mate && (!bar || mateD <= barD)) {
      // give a teammate one of your medkits (instant; they keep fighting, not rooted)
      p.medkits -= 1;
      mate.hp = Math.min(mate.maxHp, mate.hp + CONFIG.heal.amount);
      p.repairCd = CONFIG.siege.repairCd;
      Audio.heal();
    } else if (bar && p.money >= CONFIG.siege.repairCost) {
      // self-funded repair — the wall shelters the repairer too (private benefit, no
      // free-rider). Labor reward refunds < cost (solvent support, never a money fountain).
      const before = bar.hp;
      p.money -= CONFIG.siege.repairCost;
      bar.hp = Math.min(bar.maxHp, bar.hp + CONFIG.siege.repairAmount);
      const restored = bar.hp - before;
      p.money += Math.round(CONFIG.econ.repairReward * (restored / CONFIG.siege.repairAmount));
      p.repairCd = CONFIG.siege.repairCd;
      Audio.repair();
    }
  }
}
