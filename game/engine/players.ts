import { CONFIG } from "../config";
import { HOME_SPAWN } from "../data/map";
import { WEAPON_ORDER, WEAPONS } from "../data/weapons";
import { emptyInput } from "../net/playerInput";
import type { Player, State, WeaponDef } from "../types";

/**
 * Build a fresh player at (x, y). Per-weapon spare ammo and magazine state are seeded
 * from the weapon table (these live on the Player — each player carries their own ammo).
 * Weapon *ownership* is run-scoped and shared (state.owned), so it is NOT stored here.
 */
export function makePlayer(id: number, x: number, y: number, name = `P${id + 1}`): Player {
  const reserve: Record<string, number> = {};
  const mags: Record<string, number> = {};
  for (const wid of WEAPON_ORDER) {
    const w = WEAPONS[wid] as WeaponDef;
    reserve[wid] = w.reserveStart;
    mags[wid] = w.mag;
  }
  return {
    id,
    name,
    input: emptyInput(),
    firedThisHold: false,
    x,
    y,
    r: CONFIG.player.radius,
    hp: CONFIG.player.maxHp,
    maxHp: CONFIG.player.maxHp,
    speed: CONFIG.player.speed,
    curMoveMul: WEAPONS.pistol?.moveMul ?? 1, // starts at the equipped (starter) weapon's weight
    aim: 0,
    weapon: "pistol",
    ammo: mags.pistol ?? 0,
    reserve,
    mags,
    fireCd: 0,
    reloadT: 0,
    switchT: 0,
    hitFlash: 0,
    recoilX: 0,
    recoilY: 0,
    iframe: 0,
    muzzle: 0,
    dryT: 0,
    battery: CONFIG.flashlight.batteryMax,
    lightOn: true,
    medkits: CONFIG.heal.startMedkits,
    deployQueue: [],
    healT: 0,
    repairCd: 0,
    money: 0,
    wlevel: {},
    dmgMul: 1,
    fireRateMul: 1,
    reserveMul: 1,
    assistT: 0,
    absent: false,
    searching: false,
    draftOffer: [],
    draftFreePicksUsed: 0,
    draftRerolls: 0,
    draftTaken: [],
  };
}

/** The player controlled on this client (the one the HUD/flashlight follow). */
export function localPlayer(state: State): Player {
  const p = state.players.find((pl) => pl.id === state.localId);
  // localId always references a live entry; fall back to the first to satisfy the type
  return p ?? (state.players[0] as Player);
}

/**
 * Who the camera follows: yourself while alive, else the nearest living teammate so a
 * downed player spectates the fight instead of staring at their corpse. Falls back to the
 * local player only when the whole party is down (the frame before game over).
 */
export function cameraTarget(state: State): Player {
  const lp = localPlayer(state);
  if (lp.hp > 0) return lp;
  return nearestPlayer(state, lp.x, lp.y) ?? lp;
}

/**
 * Bring a downed player back. Two callers:
 *  - dawn auto-revive (default opts): full integrity, teleported to a HOME spawn (spread by id).
 *  - co-op in-place revive (`{inPlace:true, hp}`): a teammate tended them mid-night, so they get
 *    up where they fell at partial integrity (no teleport).
 * Carried gear (ammo, spare rounds, magazines, medkits, weapon, battery) and perk-raised maxHp
 * are kept; input + revive gauge are cleared so a held edge can't fire on respawn.
 */
export function revivePlayer(
  _state: State,
  p: Player,
  opts: { inPlace?: boolean; hp?: number } = {},
): void {
  p.hp = opts.hp ?? p.maxHp;
  if (!opts.inPlace) {
    p.x = HOME_SPAWN.x + ((p.id % 4) - 1.5) * 36;
    p.y = HOME_SPAWN.y;
  }
  p.healT = 0;
  p.reloadT = 0;
  p.switchT = 0;
  p.dryT = 0;
  p.recoilX = 0;
  p.recoilY = 0;
  p.assistT = 0;
  p.curMoveMul = WEAPONS[p.weapon]?.moveMul ?? 1; // resync the ramp so host/client agree on revive
  p.input = emptyInput();
}

/** Nearest still-alive player to (x, y), or null if everyone is down. */
export function nearestPlayer(state: State, x: number, y: number): Player | null {
  let best: Player | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const p of state.players) {
    if (p.hp <= 0 || p.absent) continue; // absent (disconnected, body held) = not a target
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** Any player still standing? (false = whole party wiped → game over). Absent players
 *  (disconnected, body held for reconnect) don't count — a frozen body must not keep the
 *  run alive, nor should the host wait on a player who may never return. */
export function anyAlive(state: State): boolean {
  return state.players.some((p) => p.hp > 0 && !p.absent);
}

export function addPlayer(state: State, id: number, x: number, y: number, name?: string): Player {
  const p = makePlayer(id, x, y, name);
  state.players.push(p);
  return p;
}

export function removePlayer(state: State, id: number): void {
  const i = state.players.findIndex((p) => p.id === id);
  if (i >= 0) {
    state.players[i] = state.players[state.players.length - 1] as Player;
    state.players.pop();
  }
}
