import { CONFIG } from "../config";
import { localPlayer } from "../engine/players";
import { Renderer } from "../engine/renderer";
import { Input } from "../input";
import { getSettings } from "../settings";
import type { State } from "../types";
import { emptyInput, type PlayerInput } from "./playerInput";

/**
 * Samples the local player's input from the `Input` singleton + DOM into a serializable
 * `PlayerInput`. This is the ONLY place outside the engine boundary that reads `Input`,
 * the mouse, or the canvas for sim purposes — systems stay pure and read `player.input`.
 *
 * Edge fields (reload/heal/lightToggle/weaponSlot) are rising-edge detected against the
 * previous sample so a single press fires once. Aim is computed here (cam-relative) so the
 * camera/mouse never have to travel over the network — only the resulting angle does.
 */

// previous-frame key snapshot for rising-edge detection
let prevKeys = new Set<string>();
// aim-assist: id of the zombie currently auto-targeted (for hysteresis, so the aim/light
// don't flicker between two equidistant enemies). -1 = none.
let aimTargetId = -1;

/**
 * Opt-in auto-aim: angle to the nearest zombie within the flashlight's reach (what you can
 * see). The current target gets a stickiness discount so the cone doesn't jitter between
 * two similar-distance enemies. Returns null when no zombie is in range (caller keeps the
 * mouse aim). Client-local — only the resulting angle ever crosses the wire.
 */
function assistAim(state: State, px: number, py: number): number | null {
  const r2 = CONFIG.flashlight.range * CONFIG.flashlight.range;
  let best: { x: number; y: number; id: number } | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const z of state.zombies) {
    const dx = z.x - px;
    const dy = z.y - py;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2) continue;
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
  // a downed player is a spectator: send nothing (no movement/fire, and no stale edge
  // that would fire the instant they respawn). Keep edge tracking coherent for next frame.
  if (p.hp <= 0) {
    prevKeys = new Set(Input.keys);
    return emptyInput();
  }

  let moveX = 0;
  let moveY = 0;
  if (held("KeyW") || held("ArrowUp")) moveY -= 1;
  if (held("KeyS") || held("ArrowDown")) moveY += 1;
  if (held("KeyA") || held("ArrowLeft")) moveX -= 1;
  if (held("KeyD") || held("ArrowRight")) moveX += 1;

  // aim: map the mouse (screen space) through the camera to a world-space angle
  const half = Renderer.worldToScreenHalf();
  const cv = document.getElementById("game") as HTMLCanvasElement;
  const mxN = (Input.mouseX / cv.clientWidth) * 2 - 1;
  const myN = (Input.mouseY / cv.clientHeight) * 2 - 1;
  const wx = state.cam.x + mxN * half.x;
  const wy = state.cam.y + myN * half.y;
  let aim = Math.atan2(wy - p.y, wx - p.x);
  // opt-in aim assist: override the mouse angle with auto-aim at the nearest visible zombie
  // (falls back to the mouse angle when no enemy is in range). Light follows aim, so this also
  // auto-points the flashlight — an accepted trade for accessibility (off by default).
  if (getSettings().aimAssist) {
    const a = assistAim(state, p.x, p.y);
    if (a !== null) aim = a;
  }

  // weapon switch: first newly-pressed number key → slot index
  let weaponSlot: number | null = null;
  for (let i = 1; i <= 9; i++) {
    if (edge(`Digit${i}`)) {
      weaponSlot = i - 1;
      break;
    }
  }

  const input: PlayerInput = {
    moveX,
    moveY,
    aim,
    firing: Input.firing,
    interactHeld: held("KeyE"),
    reload: edge("KeyR"),
    heal: edge("KeyH"),
    lightToggle: edge("KeyF"),
    weaponSlot,
  };

  // snapshot the current key state for next frame's edge detection
  prevKeys = new Set(Input.keys);
  return input;
}
