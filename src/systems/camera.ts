import { CONFIG } from "../config";
import type { State } from "../types";

export function sysCamera(state: State, dt: number): void {
  const c = state.cam;
  const p = state.player;
  const k = 1 - Math.exp(-CONFIG.cam.lerp * dt);
  c.x += (p.x - c.x) * k;
  c.y += (p.y - c.y) * k;
  c.shake *= Math.exp(-CONFIG.cam.shakeDecay * dt);
}
