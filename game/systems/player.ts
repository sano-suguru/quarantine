import { CONFIG } from "../config";
import { effWeapon, meleeArc, meleeReach } from "../data/arsenal";
import { resolveDeployableCollisions } from "../data/deployables";
import { WEAPON_ORDER, WEAPONS } from "../data/weapons";
import { circlePushFromSegment, segMid } from "../engine/geometry";
import { approach, clamp, len, rand } from "../engine/math";
import type { PlayerInput } from "../net/playerInput";
import { pushFx } from "../sim/events";
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

import { decaySwing } from "./actionFeel";
import { ammoTransfer } from "./ammo";
import { killZombie } from "./bullets";
import { lootCache } from "./caches";
import { applyFireFeel, decayFeelTimers } from "./feel";
import { goreIntensity } from "./fx";

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

  // decay noise toward 0 each tick (exponential falloff); clamp sub-threshold values to 0
  // to avoid floating-point never-quite-reaching-zero. Bumps happen later in this function.
  p.noise *= CONFIG.ai.perception.noise.decay;
  if (p.noise < 0.5) p.noise = 0;

  // drain the flashlight (always on)
  if (p.battery > 0) {
    p.battery = Math.max(0, p.battery - CONFIG.flashlight.drainPerSec * dt);
  }

  // H = use a carried medkit: a deliberate, rooted heal-over-time. Edge, consumed below.
  if (inp.heal && p.medkits > 0 && p.healT <= 0 && p.hp < p.maxHp) {
    p.medkits--;
    p.healT = CONFIG.heal.duration;
    pushFx(state, { t: "audio", cue: "heal" });
  }

  // healing roots the player: HP ticks up, but no moving or shooting (vulnerable)
  const healing = p.healT > 0;
  if (healing) {
    const before = p.healT;
    p.healT -= dt;
    p.hp = Math.min(p.maxHp, p.hp + (CONFIG.heal.amount / CONFIG.heal.duration) * dt);
    // rising motes while it fills
    if (
      Math.floor(before / CONFIG.actionFeel.heal.moteEveryS) !==
      Math.floor(p.healT / CONFIG.actionFeel.heal.moteEveryS)
    ) {
      pushFx(state, { t: "mote", x: p.x, y: p.y, color: [0.3, 1, 0.45] });
    }
    // completion: green burst + up-chime (this edge; healT crosses 0)
    if (before > 0 && p.healT <= 0) {
      pushFx(state, { t: "burst", x: p.x, y: p.y, color: [0.3, 1, 0.45], ring: false });
      pushFx(state, { t: "audio", cue: "heal" });
    }
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

  // run noise: footstep clatter while moving (scaled by dt so it's rate-based, not per-tick)
  if (moving && !healing) {
    const noiseCfg = CONFIG.ai.perception.noise;
    p.noise = Math.min(noiseCfg.max, p.noise + noiseCfg.run * dt);
  }

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
      // draw timer: the gun is lowered then raised over drawTime; you can't fire until it's up.
      // drawTime is wlevel-independent so read WEAPONS directly. Heavier guns draw slower.
      const drawTime = WEAPONS[id]?.drawTime ?? 0.5;
      p.switchT = drawTime;
      p.fireCd = Math.max(p.fireCd, drawTime);
      pushFx(state, { t: "audio", cue: "switchWeapon" }); // holster-away + ready (mirrors reload(): same host-side path)
    }
  }
  const wd = effWeapon(p, p.weapon);

  // reload draws from this weapon's finite reserve (melee weapons never reload)
  if (!wd.melee) {
    const reserve = p.reserve[p.weapon] ?? 0;
    if ((inp.reload || p.ammo <= 0) && p.reloadT <= 0 && p.ammo < wd.mag && reserve > 0) {
      p.reloadT = wd.reload;
      pushFx(state, { t: "audio", cue: "reload" });
      pushFx(state, {
        t: "dust",
        x: p.x - Math.cos(p.aim) * p.r,
        y: p.y - Math.sin(p.aim) * p.r,
        n: 2,
      });
    }
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) {
        const t = ammoTransfer(wd.mag, p.ammo, p.reserve[p.weapon] ?? 0);
        p.ammo = t.ammo;
        p.reserve[p.weapon] = t.reserve;
        pushFx(state, { t: "audio", cue: "reloadDone" });
      }
    }
  }

  if (p.fireCd > 0) p.fireCd -= dt;
  if (p.switchT > 0) p.switchT -= dt;
  p.swingT = decaySwing(p.swingT, dt);
  const wantFire = inp.firing && (wd.auto || !p.firedThisHold);
  if (wantFire && p.fireCd <= 0 && p.reloadT <= 0 && !healing) {
    if (wd.melee || p.ammo > 0) {
      fireWeapon(state, p, wd);
      if (!wd.melee) {
        p.ammo--;
        // fire noise: gunshot attracts distant sight-model zombies (melee is silent by design)
        const noiseCfg = CONFIG.ai.perception.noise;
        p.noise = Math.min(noiseCfg.max, p.noise + noiseCfg.fire);
      }
      p.fireCd = 1 / (wd.fireRate * p.fireRateMul);
      p.firedThisHold = true;
    } else {
      // empty magazine: the desperate dry-fire click
      pushFx(state, { t: "audio", cue: "dryFire" });
      p.dryT = 0.12;
      p.fireCd = 0.18;
      p.firedThisHold = true;
    }
  }
  if (!inp.firing) p.firedThisHold = false;

  // consume one-shot edges so multiple sim sub-steps in a frame don't re-fire them
  inp.reload = false;
  inp.heal = false;
  inp.weaponSlot = null;

  // decay feel timers (visual offsets / cooldowns)
  decayFeelTimers(p, dt);
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
  // recoil kick, muzzle flash, shake + shot audio — shared with the client's fire predictor
  applyFireFeel(state, p, wd);
}

/** A short melee arc: damage every zombie inside the cone in front of the player. */
function meleeSwing(state: State, p: Player, wd: WeaponDef): void {
  const Z = state.zombies;
  const reach = meleeReach(wd, p.r);
  const arc = meleeArc(wd);
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
    const g = CONFIG.fx.gore;
    pushFx(state, {
      t: "impact",
      x: z.x,
      y: z.y,
      ang: p.aim,
      color: wd.color,
      intensity: goreIntensity(
        wd.dmg * p.dmgMul,
        z.hp,
        z.maxHp,
        g.dmgRef,
        g.lowHpBand,
        g.finisherBonus,
      ),
    });
    if (z.hp <= 0) dead.push(zi);
  });
  // swap-and-pop removal is index-based, so kill from the highest index down
  dead.sort((a, b) => b - a);
  for (const zi of dead) {
    const dz = state.zombies[zi];
    // melee: gore flies away from the attacker (the swing's push direction)
    killZombie(state, zi, dz ? Math.atan2(dz.y - p.y, dz.x - p.x) : null);
  }

  // landing a hit punches a beat of hitstop (solo only — hitstopT slows the WHOLE sim, so in
  // co-op it would freeze the shared host view on every teammate's swing; same guard as killZombie)
  if (connected && state.players.length === 1) {
    state.hitstopT = Math.max(state.hitstopT, CONFIG.feel.hitstop);
  }
  // swing feel — forward-lunge recoil, muzzle timer, shake + whoosh; shared with the client predictor
  applyFireFeel(state, p, wd);
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
    const m = segMid(b.x1, b.y1, b.x2, b.y2);
    const d = len(m.x - p.x, m.y - p.y);
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
    p.searching = true; // drives the rummage motion (draw) for all phases
    // rummage noise: audible to sight-model zombies (double-sourced with the existing lure in
    // ai.ts until the Stalker phase unifies into a single noise model — see task-3-brief.md)
    const noiseCfg = CONFIG.ai.perception.noise;
    p.noise = Math.min(noiseCfg.max, p.noise + noiseCfg.rummage * dt);
    // ongoing dust while rummaging
    if (
      Math.floor((cache.searchT - dt) / CONFIG.actionFeel.search.dustEveryS) !==
      Math.floor(cache.searchT / CONFIG.actionFeel.search.dustEveryS)
    ) {
      pushFx(state, { t: "dust", x: cache.x, y: cache.y, n: 2 });
    }
    if (cache.searchT >= effectiveSearchTime(state.phase)) {
      lootCache(state, cache.x, cache.y, cache.tier);
      cache.looted = true;
      cache.searchT = 0;
      pushFx(state, { t: "burst", x: cache.x, y: cache.y, color: [0.9, 0.8, 0.4], ring: false });
      pushFx(state, { t: "audio", cue: "pickup" });
    }
  }

  // HEAL / REPAIR: costed, held E acts on the nearest eligible target (rate-limited)
  if (p.input.interactHeld && !healing && p.repairCd <= 0) {
    if (mate && (!bar || mateD <= barD)) {
      // give a teammate one of your medkits (instant; they keep fighting, not rooted)
      p.medkits -= 1;
      mate.hp = Math.min(mate.maxHp, mate.hp + CONFIG.heal.amount);
      p.repairCd = CONFIG.siege.repairCd;
      p.swingT = CONFIG.actionFeel.swingDecay;
      p.swingKind = "mateHeal";
      pushFx(state, { t: "mote", x: mate.x, y: mate.y, color: [0.3, 1, 0.45] });
      pushFx(state, { t: "audio", cue: "heal" });
    } else if (bar && p.money >= CONFIG.siege.repairCost) {
      // self-funded repair — the wall shelters the repairer too (private benefit, no
      // free-rider). Labor reward refunds < cost (solvent support, never a money fountain).
      const before = bar.hp;
      p.money -= CONFIG.siege.repairCost;
      bar.hp = Math.min(bar.maxHp, bar.hp + CONFIG.siege.repairAmount);
      const restored = bar.hp - before;
      p.money += Math.round(CONFIG.econ.repairReward * (restored / CONFIG.siege.repairAmount));
      p.repairCd = CONFIG.siege.repairCd;
      p.swingT = CONFIG.actionFeel.swingDecay;
      p.swingKind = "repair";
      const mid = segMid(bar.x1, bar.y1, bar.x2, bar.y2);
      pushFx(state, {
        t: "impact",
        x: mid.x,
        y: mid.y,
        ang: p.aim,
        color: [0.85, 0.7, 0.35],
        intensity: 0,
      }); // sparks (intensity 0 = wall-spark look)
      pushFx(state, { t: "dust", x: mid.x, y: mid.y, n: CONFIG.actionFeel.repair.dust });
      // completion: barricade just reached full → burst on the segment midpoint
      if (before < bar.maxHp && bar.hp >= bar.maxHp) {
        pushFx(state, { t: "burst", x: mid.x, y: mid.y, color: [0.8, 0.7, 0.3], ring: false });
      }
      pushFx(state, { t: "audio", cue: "repair" });
    }
  }
}
