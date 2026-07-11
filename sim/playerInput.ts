/**
 * A serializable, per-player input snapshot — the only thing `sysPlayer` reads.
 *
 * Decoupling the sim from the global `Input` singleton/DOM is what lets the sim be
 * driven by N players: the local player's input is sampled here (see localInput.ts),
 * remote players' inputs arrive over the network. Held fields reflect the
 * current state; edge fields fire once on the press and are cleared once consumed.
 */
export interface PlayerInput {
  /** movement axes, -1..1 (raw; normalized in sysPlayer) */
  moveX: number;
  moveY: number;
  /** aim angle in radians — computed client-locally (cam/mouse never crosses the wire) */
  aim: number;
  /** fire held (auto weapons fire continuously; semi-auto gated by firedThisHold) */
  firing: boolean;
  /** interact held (E — repair / search) */
  interactHeld: boolean;
  /** edge: explicit reload request (R) */
  reload: boolean;
  /** edge: use a medkit (H) */
  heal: boolean;
  /** weapon-slot switch request: null = no change, 0..N = hotkey slot */
  weaponSlot: number | null;
}

/** A neutral input (no movement, not firing) — used to seed players and idle remotes. */
export function emptyInput(): PlayerInput {
  return {
    moveX: 0,
    moveY: 0,
    aim: 0,
    firing: false,
    interactHeld: false,
    reload: false,
    heal: false,
    weaponSlot: null,
  };
}
