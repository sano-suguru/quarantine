import { localPlayer } from "../engine/players";
import { Renderer } from "../engine/renderer";
import { Input } from "../input";
import type { State } from "../types";
import { type PlayerInput, emptyInput } from "./playerInput";

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
  const aim = Math.atan2(wy - p.y, wx - p.x);

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
    sprint: held("ShiftLeft") || held("ShiftRight"),
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
