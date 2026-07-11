import { CONFIG } from "../config";
import { pushFx } from "../sim/events";
import type { Player, State, WeaponDef } from "../types";

/**
 * The juice of pulling the trigger — recoil offset, muzzle timer, camera shake, audio (and the
 * gun's muzzle-flash sparks). Split out of the sim so the host (fireWeapon/meleeSwing) and the
 * co-op client's local-player prediction apply the SAME feel: a single source of truth for the
 * recoil sign/magnitude that previously drifted between systems/player and net/client.
 *
 * Sim-side effects (bullets, damage, hitstop) stay in the systems; this is feel only.
 */
export function applyFireFeel(state: State, p: Player, wd: WeaponDef): void {
  // recoilX/Y is a render-only offset (drawPlayer): a gun kicks the player BACK (−), a melee
  // lunges them FORWARD (+) so a knife reads as a thrusting stab without moving the collision body.
  const dir = wd.melee ? 1 : -1;
  const kick = wd.recoil * CONFIG.feel.recoilKick;
  p.recoilX += Math.cos(p.aim) * kick * dir;
  p.recoilY += Math.sin(p.aim) * kick * dir;
  // camera shake is local-view only, so a teammate's fire never shakes your screen
  if (p.id === state.localId) {
    state.cam.shake = Math.min(state.cam.shake + wd.recoil, CONFIG.feel.shakeMax);
  }
  const tipX = p.x + Math.cos(p.aim) * p.r;
  const tipY = p.y + Math.sin(p.aim) * p.r;
  if (wd.melee) {
    p.muzzle = CONFIG.feel.muzzleMelee; // longer than a gun so the slash arc reads at swing cadence
  } else {
    p.muzzle = CONFIG.feel.muzzleGun;
  }
  pushFx(state, {
    t: "muzzle",
    x: tipX,
    y: tipY,
    ang: p.aim,
    color: wd.color,
    weapon: p.weapon,
    melee: wd.melee ?? false,
  });
}

/** Decay the per-player feel timers/offsets each step (recoil spring + flash/iframe/muzzle/dry). */
export function decayFeelTimers(p: Player, dt: number): void {
  const rk = Math.exp(-CONFIG.feel.recoilDecay * dt);
  p.recoilX *= rk;
  p.recoilY *= rk;
  if (p.hitFlash > 0) p.hitFlash -= dt;
  if (p.iframe > 0) p.iframe -= dt;
  if (p.muzzle > 0) p.muzzle -= dt;
  if (p.dryT > 0) p.dryT -= dt;
}
