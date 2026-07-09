/**
 * stalkerFx — render/audio-only telegraph layer for the Stalker.
 *
 * Given `state.stalker` and the local player, this module computes a `dread` value
 * (nearness × unlit) and drives three outputs:
 *   1. A localizable footfall (procedural audio panned by stalker direction/distance).
 *   2. A cone-flicker signal (0..1) that `game.ts` applies to the flashlight intensity.
 *   3. A rising heartbeat that stacks with the HP-based heartbeat.
 *
 * RENDER/AUDIO ONLY — no sim state is mutated, nothing written to state.particles or any
 * sim field. Mirrors how `darts` / `drawAtmosphere` are structured in game.ts: purely
 * re-derived from the snapshot world on each client. Single-player stays byte-for-byte safe.
 *
 * Called from game.ts `draw()` (which runs on host, client, and single-player alike).
 * On clients the stalker comes from the synced snapshot (Task 5); this module is
 * agnostic of the source.
 */

import { CONFIG } from "../config";
import { Audio } from "../engine/audio";
import { len } from "../engine/math";
import type { Player, State } from "../types";
import { flashlightIntensity } from "./flashlight";

const SCFG = CONFIG.stalker;
const FLC = CONFIG.flashlight;

// Module-level render-side bookkeeping (no sim state — reset between runs via resetStalkerFx)
let footfallT = 0; // countdown to the next footfall sound (render-side only)
let stalkerHbT = 0; // countdown to the next stalker-dread heartbeat
let lastFootfallT = Number.NEGATIVE_INFINITY; // state.time of the last real footfall (owns the phantom-step lockout)

/** Reset between runs so stale timers don't carry forward. Call from resetAtmosphere. */
export function resetStalkerFx(): void {
  footfallT = 0;
  stalkerHbT = 0;
  lastFootfallT = Number.NEGATIVE_INFINITY;
}

/**
 * Returns true if the stalker (sx, sy) is inside the local player's active flashlight cone.
 * A lit stalker does NOT trigger the telegraph — fear comes from the dark side.
 */
function stalkerIsLitByLocal(lp: Player, sx: number, sy: number, t: number): boolean {
  if (lp.hp <= 0 || lp.absent) return false;
  const intensity = flashlightIntensity(
    lp.battery / FLC.batteryMax,
    FLC.lowThreshold,
    FLC.flickerDepth,
    FLC.baseFlickerDepth,
    // Use a seeded flicker noise that matches the draw-pass (same formula as flickerNoise in game.ts)
    localFlickerNoise(t, lp.id),
    FLC.dimFloor,
    FLC.dimStart,
  );
  if (intensity <= 0) return false;
  const dx = sx - lp.x;
  const dy = sy - lp.y;
  const dist = len(dx, dy) || 1;
  if (dist > FLC.range) return false;
  const coneCos = Math.cos(FLC.halfAngle);
  const aimX = Math.cos(lp.aim);
  const aimY = Math.sin(lp.aim);
  return (dx / dist) * aimX + (dy / dist) * aimY > coneCos;
}

/** Time-correlated flicker noise — matches `flickerNoise` in game.ts (seeded by player id). */
function localFlickerNoise(t: number, seed: number): number {
  const s = seed * 1.37;
  const base = 0.5 + 0.3 * Math.sin(t * 9.1 + s) + 0.2 * Math.sin(t * 23.7 + s * 2.3);
  const surge = Math.max(0, Math.sin(t * 2.3 + s * 5)) ** 6;
  return Math.max(0, Math.min(1, base * 0.5 + surge));
}

/**
 * True while a real footfall fired recently — the phantom-step suppressor. `stalkerFx` owns this
 * because it is the real footfall's firer; `stalkerPhantom` reads it before firing a fake step so
 * the real localizable cue is never muddied on the same beat.
 */
export function phantomStepLocked(now: number): boolean {
  return now - lastFootfallT < CONFIG.stalker.phantomStepLockout;
}

/**
 * Main entry point. Call once per draw frame after `lastDrawT` is updated.
 *
 * Returns the cone-flicker signal (0..1): `game.ts` multiplies this by `SCFG.flickerMax` and
 * subtracts it from the flashlight intensity for the local player's light, giving the
 * "something interfering with the beam" feel when the stalker is close and unlit.
 *
 * @param state  Current game state (stalker + local player read-only).
 * @param lp     Local player (same as `localPlayer(state)`).
 * @param ddt    Render-side dt (state.time delta, clamped by game.ts to ≤ 0.1).
 * @returns      Cone-flicker value 0..1 (0 = no flicker, 1 = maximum interference).
 */
export function stalkerFx(state: State, lp: Player, ddt: number): number {
  const sk = state.stalker;
  if (!sk || state.phase !== "night") {
    // No stalker or daytime: decay timers so the next spawn starts fresh
    footfallT = Math.max(0, footfallT - ddt);
    stalkerHbT = Math.max(0, stalkerHbT - ddt);
    return 0;
  }

  // --- Compute dread ---
  const dx = sk.x - lp.x;
  const dy = sk.y - lp.y;
  const dist = len(dx, dy) || 1;
  // Nearness: 0 at telegraphNear, 1 at contactDist
  const nearness = Math.max(
    0,
    Math.min(1, 1 - (dist - SCFG.contactDist) / (SCFG.telegraphNear - SCFG.contactDist)),
  );
  // Unlit: 1 if the stalker is NOT in the local player's cone (the dangerous dark side), 0 if lit
  const isLitByLocal = stalkerIsLitByLocal(lp, sk.x, sk.y, state.time);
  const unlit = isLitByLocal ? 0 : 1;
  const dread = nearness * unlit * sk.vis; // vis fades in on spawn so the telegraph builds gradually

  // --- 1. Footfall ---
  footfallT -= ddt;
  if (footfallT <= 0 && dread > 0.02) {
    // Interval shrinks as dread rises (closer + darker = more frequent)
    const interval =
      SCFG.footfallIntervalMax + (SCFG.footfallIntervalMin - SCFG.footfallIntervalMax) * dread;
    footfallT = interval;
    // Pan by direction from local player to stalker (-1..1 left/right)
    const pan = Math.max(-1, Math.min(1, dx / 400));
    const vol = SCFG.footfallVolMin + (SCFG.footfallVolMax - SCFG.footfallVolMin) * dread;
    Audio.stalkerFootfall(pan, vol);
    lastFootfallT = state.time; // arm the phantom-step lockout (this module owns it)
  } else if (dread <= 0.02) {
    // Drain footfall timer when dread is effectively zero (lit or very far) so it doesn't fire
    // immediately on re-approach after a stagger
    footfallT = Math.max(footfallT, SCFG.footfallIntervalMax * 0.5);
  }

  // --- 2. Heartbeat (stalker-dread layer, stacks with HP heartbeat in audioAmbience) ---
  stalkerHbT -= ddt;
  if (stalkerHbT <= 0 && dread > 0.15) {
    const strength = dread * SCFG.heartbeatAdd;
    Audio.heartbeat(strength);
    stalkerHbT = SCFG.heartbeatIntervalMin + (1 - dread) * 0.8;
  } else if (dread <= 0.15) {
    stalkerHbT = Math.max(stalkerHbT, 0.8);
  }

  // --- 3. Cone flicker signal (returned to game.ts) ---
  // A smooth 0..1 signal that `game.ts` uses to modulate the local flashlight's displayed intensity.
  // This is NOT applied here — game.ts has the renderer context; we just provide the value.
  return dread;
}
