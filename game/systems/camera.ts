import { CONFIG } from "../config";
import { cameraTarget } from "../engine/players";
import type { State } from "../types";

export function sysCamera(state: State, dt: number): void {
  const c = state.cam;
  const p = cameraTarget(state);
  const k = 1 - Math.exp(-CONFIG.cam.lerp * dt);
  c.x += (p.x - c.x) * k;
  c.y += (p.y - c.y) * k;
  c.shake *= Math.exp(-CONFIG.cam.shakeDecay * dt);
}
