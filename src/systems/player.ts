import { CONFIG } from "../config";
import { effWeapon } from "../data/arsenal";
import { WEAPON_ORDER } from "../data/weapons";
import { Audio } from "../engine/audio";
import { circlePushFromSegment } from "../engine/geometry";
import { clamp, len, rand } from "../engine/math";
import { Renderer } from "../engine/renderer";
import { Input } from "../input";
import type { Player, State, WeaponDef } from "../types";
import { ammoTransfer } from "./ammo";
import { killZombie } from "./bullets";
import { lootCache } from "./caches";
import { fxDamageText, fxImpact, fxMuzzle } from "./fx";

export function sysPlayer(state: State, dt: number): void {
  const p = state.player;

  // drain the flashlight while it's on
  if (p.lightOn && p.battery > 0) {
    p.battery = Math.max(0, p.battery - CONFIG.flashlight.drainPerSec * dt);
  }

  // healing roots the player: HP ticks up, but no moving or shooting (vulnerable)
  const healing = p.healT > 0;
  if (healing) {
    p.healT -= dt;
    p.hp = Math.min(p.maxHp, p.hp + (CONFIG.heal.amount / CONFIG.heal.duration) * dt);
  }

  const moving = movementPressed();
  let dx = 0;
  let dy = 0;
  if (!healing) {
    if (Input.keys.has("KeyW") || Input.keys.has("ArrowUp")) dy -= 1;
    if (Input.keys.has("KeyS") || Input.keys.has("ArrowDown")) dy += 1;
    if (Input.keys.has("KeyA") || Input.keys.has("ArrowLeft")) dx -= 1;
    if (Input.keys.has("KeyD") || Input.keys.has("ArrowRight")) dx += 1;
  }
  const l = len(dx, dy);
  const sprint =
    Input.keys.has("ShiftLeft") || Input.keys.has("ShiftRight") ? CONFIG.player.sprint : 1;
  if (l > 0) {
    dx /= l;
    dy /= l;
  }
  p.x = clamp(p.x + dx * p.speed * sprint * dt, -CONFIG.arena, CONFIG.arena);
  p.y = clamp(p.y + dy * p.speed * sprint * dt, -CONFIG.arena, CONFIG.arena);
  // solid walls block the player (openings/barricades do not — you slip through)
  for (const w of state.walls) {
    const push = circlePushFromSegment(p.x, p.y, p.r, w);
    if (push) {
      p.x += push.dx;
      p.y += push.dy;
    }
  }

  // E = context interact: repair a barricade you're next to, else search a cache
  interact(state, p, dt, healing, moving);

  const half = Renderer.worldToScreenHalf();
  const cv = document.getElementById("game") as HTMLCanvasElement;
  const mxN = (Input.mouseX / cv.clientWidth) * 2 - 1;
  const myN = (Input.mouseY / cv.clientHeight) * 2 - 1;
  const wx = state.cam.x + mxN * half.x;
  const wy = state.cam.y + myN * half.y;
  p.aim = Math.atan2(wy - p.y, wx - p.x);

  // switch weapons — only to ones you own; magazine state is preserved per weapon
  for (let i = 0; i < WEAPON_ORDER.length; i++) {
    const id = WEAPON_ORDER[i] as string;
    if (Input.keys.has(`Digit${i + 1}`) && p.weapon !== id && state.owned[id]) {
      p.mags[p.weapon] = p.ammo; // stash the rounds left in the current mag
      p.weapon = id;
      p.ammo = p.mags[id] ?? 0; // restore the new weapon's mag
      p.reloadT = 0;
    }
  }
  const wd = effWeapon(state, p.weapon);

  // reload draws from this weapon's finite reserve (melee weapons never reload)
  if (!wd.melee) {
    const reserve = p.reserve[p.weapon] ?? 0;
    if (
      (Input.keys.has("KeyR") || p.ammo <= 0) &&
      p.reloadT <= 0 &&
      p.ammo < wd.mag &&
      reserve > 0
    ) {
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
  const wantFire = Input.firing && (wd.auto || !state._firedThisHold);
  if (wantFire && p.fireCd <= 0 && p.reloadT <= 0 && !healing) {
    if (wd.melee || p.ammo > 0) {
      fireWeapon(state, p, wd);
      if (!wd.melee) p.ammo--;
      p.fireCd = 1 / (wd.fireRate * state.fireRateMul);
      state._firedThisHold = true;
    } else {
      // empty magazine: the desperate dry-fire click
      Audio.dryFire();
      p.dryT = 0.12;
      p.fireCd = 0.18;
      state._firedThisHold = true;
    }
  }
  if (!Input.firing) state._firedThisHold = false;

  // decay feel timers (visual offsets / cooldowns)
  const rk = Math.exp(-CONFIG.feel.recoilDecay * dt);
  p.recoilX *= rk;
  p.recoilY *= rk;
  if (p.hitFlash > 0) p.hitFlash -= dt;
  if (p.iframe > 0) p.iframe -= dt;
  if (p.muzzle > 0) p.muzzle -= dt;
  if (p.dryT > 0) p.dryT -= dt;
}

export function fireWeapon(state: State, p: Player, wd: WeaponDef): void {
  if (wd.melee) {
    meleeSwing(state, p, wd);
    return;
  }
  const tipX = p.x + Math.cos(p.aim) * p.r;
  const tipY = p.y + Math.sin(p.aim) * p.r;
  for (let i = 0; i < wd.pellets; i++) {
    const a = p.aim + rand(-wd.spread, wd.spread);
    state.bullets.push({
      x: tipX,
      y: tipY,
      px: tipX,
      py: tipY,
      vx: Math.cos(a) * wd.bulletSpeed,
      vy: Math.sin(a) * wd.bulletSpeed,
      r: 4,
      dmg: wd.dmg * state.dmgMul,
      life: wd.range,
      pierce: wd.pierce,
      knockback: wd.knockback,
      color: wd.color,
    });
  }
  // recoil: kick the camera and shove the player back a touch
  state.cam.shake = Math.min(state.cam.shake + wd.recoil, 18);
  p.recoilX -= Math.cos(p.aim) * wd.recoil * 0.9;
  p.recoilY -= Math.sin(p.aim) * wd.recoil * 0.9;
  fxMuzzle(state, tipX, tipY, p.aim, wd.color);
  Audio.shot(p.weapon);
}

/** A short melee arc: damage every zombie inside the cone in front of the player. */
function meleeSwing(state: State, p: Player, wd: WeaponDef): void {
  const Z = state.zombies;
  const reach = (wd.meleeRange ?? 30) + p.r;
  const arc = wd.meleeArc ?? 0.9;
  const dead: number[] = [];
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
    z.hp -= wd.dmg * state.dmgMul;
    z.flash = 0.12;
    z.vx += (dx / d) * wd.knockback;
    z.vy += (dy / d) * wd.knockback;
    fxImpact(state, z.x, z.y, p.aim, wd.color);
    fxDamageText(state, z.x, z.y - z.r, wd.dmg * state.dmgMul, true);
    if (z.hp <= 0) dead.push(zi);
  });
  // swap-and-pop removal is index-based, so kill from the highest index down
  dead.sort((a, b) => b - a);
  for (const zi of dead) killZombie(state, zi);

  // swing feel — same kick/shake channel as a gun, plus a whoosh
  state.cam.shake = Math.min(state.cam.shake + wd.recoil, 18);
  p.recoilX -= Math.cos(p.aim) * wd.recoil * 0.6;
  p.recoilY -= Math.sin(p.aim) * wd.recoil * 0.6;
  p.muzzle = 0.04;
  Audio.melee();
}

/** Any movement key currently held? (input-based so a shove can't cancel a search) */
function movementPressed(): boolean {
  return (
    Input.keys.has("KeyW") ||
    Input.keys.has("KeyS") ||
    Input.keys.has("KeyA") ||
    Input.keys.has("KeyD") ||
    Input.keys.has("ArrowUp") ||
    Input.keys.has("ArrowDown") ||
    Input.keys.has("ArrowLeft") ||
    Input.keys.has("ArrowRight")
  );
}

/**
 * Hold E to interact with the single nearest thing: a damaged barricade (repair,
 * costs credits, rate-limited) takes priority; otherwise an unsearched cache
 * (search while standing still, day only). Anything not actively searched resets.
 */
function interact(state: State, p: Player, dt: number, healing: boolean, moving: boolean): void {
  if (p.repairCd > 0) p.repairCd -= dt;
  const reach = CONFIG.siege.interactRadius;
  const holding = Input.keys.has("KeyE");

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

  let cache: (typeof state.caches)[number] | null = null;
  let cacheD = reach;
  if (state.phase === "day") {
    for (const c of state.caches) {
      if (c.looted) continue;
      const d = len(c.x - p.x, c.y - p.y);
      if (d < cacheD) {
        cacheD = d;
        cache = c;
      }
    }
  }

  let searching: (typeof state.caches)[number] | null = null;
  if (holding && !healing) {
    if (bar) {
      // repair takes priority over searching
      if (p.repairCd <= 0 && state.money >= CONFIG.siege.repairCost) {
        state.money -= CONFIG.siege.repairCost;
        bar.hp = Math.min(bar.maxHp, bar.hp + CONFIG.siege.repairAmount);
        p.repairCd = CONFIG.siege.repairCd;
        Audio.repair();
      }
    } else if (cache && !moving) {
      cache.searchT += dt;
      searching = cache;
      if (cache.searchT >= CONFIG.cache.searchTime) {
        lootCache(state, cache.x, cache.y, cache.tier);
        cache.looted = true;
        cache.searchT = 0;
        Audio.pickup();
      }
    }
  }
  // any cache not actively being searched loses its progress
  for (const c of state.caches) if (c !== searching && c.searchT > 0) c.searchT = 0;
}
