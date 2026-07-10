import { inViewport, resolveAim, resolveHotbarSlot } from "../autoAim";
import { CONFIG } from "../config";
import { cycleWeaponSlot, effWeapon } from "../data/arsenal";
import { isUpgradeableWeapon, WEAPON_ORDER } from "../data/weapons";
import { localPlayer } from "../engine/players";
import { Renderer } from "../engine/renderer";
import { Input } from "../input";
import { getSettings } from "../settings";
import { hasLineOfSight } from "../systems/perception";
import type { State } from "../types";
import { emptyInput, type PlayerInput } from "./playerInput";

/**
 * Samples the local player's input from the `Input` singleton + DOM into a serializable
 * `PlayerInput`. This is the ONLY place outside the engine boundary that reads `Input`,
 * the mouse, or the canvas for sim purposes — systems stay pure and read `player.input`.
 *
 * Edge fields (reload/heal/weaponSlot) are rising-edge detected against the previous sample
 * so a single press fires once. Aim is auto-derived (nearest visible in-viewport zombie →
 * movement heading → held last heading). The mouse never aims.
 */

// previous-frame key snapshot for rising-edge detection
let prevKeys = new Set<string>();
// aim-assist: id of the zombie currently auto-targeted (for hysteresis, so the aim/light
// don't flicker between two equidistant enemies). -1 = none.
let aimTargetId = -1;
// module-local heading so the gun holds its last facing when the player stops moving and
// no zombie is on-screen.
let lastHeading = 0;
// mouse-wheel weapon-switch debounce (module-local, like prevKeys/aimTargetId):
// wheelArmed = may switch on the next wheel activity; re-armed after a quiet gap.
// lastSampleMs = performance.now() of the previous sampleLocalInput call; a large gap means
// we were non-live (shop/pause/settings/tab-away) and should drop stale wheel accumulation.
let wheelArmed = true;
let lastSampleMs = 0;
// semi-auto re-trigger pulse: toggled each sample so the sim's firedThisHold gate clears
// between shots when the weapon is on continuous-target semi-auto.
let firePulse = false;

/**
 * Auto-aim: angle to the nearest zombie within the flashlight's range AND within the
 * visible viewport. The current target gets a stickiness discount so the cone doesn't
 * jitter between two similar-distance enemies. Returns null when no zombie qualifies
 * (caller falls back to movement heading / last heading). Client-local — only the
 * resulting angle ever crosses the wire.
 */
function assistAim(state: State, px: number, py: number): number | null {
  const r2 = CONFIG.flashlight.range * CONFIG.flashlight.range;
  const half = Renderer.worldToScreenHalf();
  let best: { x: number; y: number; id: number } | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  // NOTE: iterates state.zombies only — state.stalker is a separate slot and is intentionally
  // excluded from aim-assist (warding it with the light must be a deliberate manual act).
  for (const z of state.zombies) {
    const dx = z.x - px;
    const dy = z.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue; // beyond flashlight range
    // 24 wu buffer: zombie is substantially on-screen before it becomes targetable,
    // avoiding edge jitter without letting off-screen enemies past the gate.
    const VIEWPORT_MARGIN = 24;
    if (!inViewport(z.x, z.y, state.cam.x, state.cam.y, half.x, half.y, VIEWPORT_MARGIN)) continue; // off-screen
    if (!hasLineOfSight(px, py, z.x, z.y, state.walls)) continue; // wall-occluded
    const score = z.id === aimTargetId ? d2 / (1.4 * 1.4) : d2; // hysteresis: stick to current
    if (score < bestScore) {
      bestScore = score;
      best = z;
    }
  }
  if (!best) {
    aimTargetId = -1;
    return null;
  }
  aimTargetId = best.id;
  return Math.atan2(best.y - py, best.x - px);
}

function held(code: string): boolean {
  return Input.keys.has(code);
}

function edge(code: string): boolean {
  return Input.keys.has(code) && !prevKeys.has(code);
}

export function sampleLocalInput(state: State): PlayerInput {
  const p = localPlayer(state);
  const nowMs = performance.now();
  // Resume drain: if sampling was interrupted (non-live > one burst gap), discard wheel that
  // piled up while the sim was frozen so it can't fire a switch on the first live frame back.
  if (nowMs - lastSampleMs > CONFIG.input.wheelBurstGapMs) {
    Input.wheel = 0;
    wheelArmed = true;
  }
  lastSampleMs = nowMs;
  // a downed player is a spectator: send nothing (no movement/fire, and no stale edge
  // that would fire the instant they respawn). Keep edge tracking coherent for next frame.
  if (p.hp <= 0) {
    Input.wheel = 0;
    prevKeys = new Set(Input.keys);
    return emptyInput();
  }

  let moveX = 0;
  let moveY = 0;
  if (document.body.classList.contains("mobile") && Input.touch.active) {
    // On mobile, the virtual stick drives movement. WASD may still fire harmlessly (a physical
    // keyboard paired with a touch device) but touch takes precedence when active.
    moveX = Input.touch.dx;
    moveY = Input.touch.dy;
  } else {
    if (held("KeyW") || held("ArrowUp")) moveY -= 1;
    if (held("KeyS") || held("ArrowDown")) moveY += 1;
    if (held("KeyA") || held("ArrowLeft")) moveX -= 1;
    if (held("KeyD") || held("ArrowRight")) moveX += 1;
  }

  // unified auto scheme: gun auto-aims at the nearest visible in-viewport zombie; with no
  // target the light/gun follow the movement heading; idle holds the last heading.
  // The mouse never aims.
  const target = assistAim(state, p.x, p.y); // null when no valid zombie is on-screen
  const aim = resolveAim(target, moveX, moveY, lastHeading);
  lastHeading = aim; // persist the resting facing

  // weapon switch: number keys Digit1..Digit3 → loadout hotbar slot → absolute WEAPON_ORDER index
  const loadout = getSettings().loadout;
  let weaponSlot: number | null = null;
  for (let i = 1; i <= 3; i++) {
    if (edge(`Digit${i}`)) {
      weaponSlot = resolveHotbarSlot(loadout, WEAPON_ORDER, i - 1);
      break;
    }
  }

  // Mouse-wheel weapon switch — only if a number key didn't already claim the slot. One switch
  // per wheel "burst" (re-arm only after wheelBurstGapMs of silence) so trackpad inertia can't
  // spin through the arsenal. Cycles only within the loadout. Always drain the wheel
  // accumulator, even when a number key already claimed the slot this frame, so a stale delta
  // never carries across frames (spec: no pile-up on number-key wins).
  const w = Input.wheel;
  Input.wheel = 0;
  if (weaponSlot === null) {
    if (nowMs - Input.wheelLastMs > CONFIG.input.wheelBurstGapMs) wheelArmed = true;
    if (wheelArmed && w !== 0) {
      const slot = cycleWeaponSlot(
        WEAPON_ORDER,
        (id) => !!state.owned[id] && isUpgradeableWeapon(id) && loadout.includes(id),
        p.weapon,
        Math.sign(w),
      );
      if (slot !== null) {
        weaponSlot = slot;
        wheelArmed = false;
      }
    }
  }

  // auto-fire: fire whenever a target is visible. Semi-auto weapons pulse firing off every
  // other sample so the sim's firedThisHold gate (cleared when !inp.firing) lets them re-fire.
  const isAuto = effWeapon(p, p.weapon).auto;
  // Reset pulse when no target so a fresh engagement always fires on sample 1.
  if (target === null) firePulse = false;
  // Read-then-toggle: semi-auto fires on the current pulse value, then flips for next sample.
  const firing = target !== null && (isAuto || !firePulse);
  firePulse = !firePulse;

  const input: PlayerInput = {
    moveX,
    moveY,
    aim,
    firing,
    interactHeld: held("KeyE"),
    reload: edge("KeyR"),
    heal: edge("KeyH"),
    weaponSlot,
  };

  // snapshot the current key state for next frame's edge detection
  prevKeys = new Set(Input.keys);
  return input;
}
