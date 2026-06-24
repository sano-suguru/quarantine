import { CONFIG } from "../config";
import { WEAPONS, WEAPON_ORDER } from "../data/weapons";
import { Audio } from "../engine/audio";
import { clamp, len, rand } from "../engine/math";
import { Renderer } from "../engine/renderer";
import { Input } from "../input";
import type { Player, State, WeaponDef } from "../types";
import { fxMuzzle } from "./fx";

export function sysPlayer(state: State, dt: number): void {
  const p = state.player;
  let dx = 0;
  let dy = 0;
  if (Input.keys.has("KeyW") || Input.keys.has("ArrowUp")) dy -= 1;
  if (Input.keys.has("KeyS") || Input.keys.has("ArrowDown")) dy += 1;
  if (Input.keys.has("KeyA") || Input.keys.has("ArrowLeft")) dx -= 1;
  if (Input.keys.has("KeyD") || Input.keys.has("ArrowRight")) dx += 1;
  const l = len(dx, dy);
  const sprint =
    Input.keys.has("ShiftLeft") || Input.keys.has("ShiftRight") ? CONFIG.player.sprint : 1;
  if (l > 0) {
    dx /= l;
    dy /= l;
  }
  p.x = clamp(p.x + dx * p.speed * sprint * dt, -CONFIG.arena, CONFIG.arena);
  p.y = clamp(p.y + dy * p.speed * sprint * dt, -CONFIG.arena, CONFIG.arena);

  const half = Renderer.worldToScreenHalf();
  const cv = document.getElementById("game") as HTMLCanvasElement;
  const mxN = (Input.mouseX / cv.clientWidth) * 2 - 1;
  const myN = (Input.mouseY / cv.clientHeight) * 2 - 1;
  const wx = state.cam.x + mxN * half.x;
  const wy = state.cam.y + myN * half.y;
  p.aim = Math.atan2(wy - p.y, wx - p.x);

  for (let i = 0; i < WEAPON_ORDER.length; i++) {
    const id = WEAPON_ORDER[i] as string;
    if (Input.keys.has(`Digit${i + 1}`) && p.weapon !== id) {
      p.weapon = id;
      p.ammo = weapon(id).mag;
      p.reloadT = 0;
    }
  }
  const wd = weapon(p.weapon);
  if ((Input.keys.has("KeyR") || p.ammo <= 0) && p.reloadT <= 0 && p.ammo < wd.mag) {
    p.reloadT = wd.reload;
    Audio.reload();
  }
  if (p.reloadT > 0) {
    p.reloadT -= dt;
    if (p.reloadT <= 0) {
      p.ammo = wd.mag;
      Audio.reloadDone();
    }
  }

  if (p.fireCd > 0) p.fireCd -= dt;
  const wantFire = Input.firing && (wd.auto || !state._firedThisHold);
  if (wantFire && p.fireCd <= 0 && p.reloadT <= 0 && p.ammo > 0) {
    fireWeapon(state, p, wd);
    p.ammo--;
    p.fireCd = 1 / (wd.fireRate * state.fireRateMul);
    state._firedThisHold = true;
  }
  if (!Input.firing) state._firedThisHold = false;

  // decay feel timers (visual offsets / cooldowns)
  const rk = Math.exp(-CONFIG.feel.recoilDecay * dt);
  p.recoilX *= rk;
  p.recoilY *= rk;
  if (p.hitFlash > 0) p.hitFlash -= dt;
  if (p.iframe > 0) p.iframe -= dt;
  if (p.muzzle > 0) p.muzzle -= dt;
}

export function fireWeapon(state: State, p: Player, wd: WeaponDef): void {
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

function weapon(id: string): WeaponDef {
  return WEAPONS[id] as WeaponDef;
}
