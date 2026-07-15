/**
 * stalkerPhantom — render/audio-only fake perception cues for the Stalker (Phase 1.5).
 *
 * Produces fleeting stalker-shaped silhouettes (Stage 1) and, later, non-localizable phantom
 * footsteps (Stage 2). Fakes drift during the quiet and recede as `dread` rises, so the real
 * localizable footfall always cuts through.
 *
 * RENDER/AUDIO ONLY — no sim state mutated, nothing written to state.particles or any sim field.
 * Mirrors `stalkerFx` / `darts`: module-level bookkeeping, re-derived per client each draw frame,
 * NOTHING synced. Client-safe: NOTHING synced. NO imports from game/net.
 *
 * Called from game.ts `draw()` after `stalkerFx` (so it reads the same `dread`).
 */

import { CONFIG } from "../../sim/config";
import type { Player, State } from "../../sim/types";
import { Audio } from "../engine/audio";
import { phantomStepLocked } from "./stalkerFx";

const SCFG = CONFIG.stalker;
const FLC = CONFIG.flashlight;

/** One fleeting fake silhouette (render-only; NO hitbox, NOT in state.particles). */
export interface Phantom {
  x: number;
  y: number;
  face: number; // faces the local player
  life: number; // remaining seconds (counts down from maxLife)
  maxLife: number;
}

// Module-level bookkeeping only (no sim state — reset via resetStalkerPhantom).
const phantoms: Phantom[] = [];
let stepT = 0; // countdown to the next phantom step (render/audio-side only)

/** Reset per-run bookkeeping so stale phantoms/timers don't carry across runs. Call from resetAtmosphere. */
export function resetStalkerPhantom(): void {
  phantoms.length = 0;
  stepT = 0;
}

/**
 * Ambient fake rate as a function of dread: 1 at dread=0 (the quiet), 0 at dread=1 (real approach).
 * Pure — the one unit-tested helper. `exp` (k) shapes the falloff.
 */
export function phantomRateScale(dread: number, exp: number): number {
  const d = Math.max(0, Math.min(1, dread));
  return (1 - d) ** exp;
}

/** Spawn one fake silhouette near the local player's vision edge (mirrors spawnDart's placement). */
function spawnPhantom(lp: Player): void {
  const side = Math.random() < 0.5 ? -1 : 1;
  const dist = FLC.range * (0.5 + Math.random() * 0.45);
  const ang = lp.aim + side * FLC.halfAngle * (0.8 + Math.random() * 0.6); // near / just outside the cone edge
  const x = lp.x + Math.cos(ang) * dist;
  const y = lp.y + Math.sin(ang) * dist;
  phantoms.push({
    x,
    y,
    face: Math.atan2(lp.y - y, lp.x - x), // look toward the player
    life: SCFG.phantomLife,
    maxLife: SCFG.phantomLife,
  });
}

/**
 * Update fake silhouettes + fire non-localizable phantom steps for this draw frame, and return
 * the active silhouettes to draw. Both channels are rate-gated by `(1-dread)^k` (quiet → likely,
 * real approach → suppressed); the step is additionally gated by stalkerFx's footfall lockout.
 *
 * @param state read-only (stalker + phase)
 * @param lp    local player (localPlayer(state))
 * @param ddt   render-side dt (state.time delta, clamped ≤ 0.1 by game.ts)
 * @param dread the dread value stalkerFx computed this frame (0..1)
 * @returns     active phantom silhouettes to draw (game.ts owns the renderer)
 */
export function sysStalkerPhantom(
  state: State,
  lp: Player,
  ddt: number,
  dread: number,
): readonly Phantom[] {
  const sk = state.stalker;
  const active = !!sk && state.phase === "night" && (sk.state === "lull" || sk.state === "aggro");
  if (!active) {
    // Stalker gone / day / staggered / retreating: clear fakes so nothing lingers into the quiet-after.
    if (phantoms.length) phantoms.length = 0;
    stepT = Math.max(stepT, SCFG.phantomStepIntervalMax * 0.5); // don't fire the instant it re-activates
    return phantoms;
  }

  // Age out existing silhouettes (swap-and-pop not needed — small array, order irrelevant).
  for (let i = phantoms.length - 1; i >= 0; i--) {
    const p = phantoms[i] as Phantom;
    p.life -= ddt;
    if (p.life <= 0) phantoms.splice(i, 1);
  }

  // Maybe spawn (continuous-probability model, like darts): mean interval phantomSpawnIntervalMax at
  // dread≈0, scaled toward 0 as dread rises.
  const scale = phantomRateScale(dread, SCFG.phantomDreadExp);
  if (
    phantoms.length < SCFG.phantomMax &&
    Math.random() < (ddt / SCFG.phantomSpawnIntervalMax) * scale
  ) {
    spawnPhantom(lp);
  }

  // Phantom steps (Stage 2): a footfall-like but non-localizable sound on a jittered rhythm.
  // Gated by the same dread scale (quiet → likely; approach → suppressed) AND by the real-footfall
  // lockout so a fake never lands on the same beat as the real localizable cue.
  stepT -= ddt;
  if (stepT <= 0) {
    stepT = SCFG.phantomStepIntervalMax * (0.6 + Math.random() * 0.8); // jittered interval
    if (Math.random() < scale && !phantomStepLocked(state.time)) {
      Audio.stalkerPhantomStep();
    }
  }

  return phantoms;
}
