import { CONFIG } from "./config";
import { pushFx } from "./events";
import { sysAI } from "./systems/ai";
import { sysAssist } from "./systems/assist";
import { sysBullets } from "./systems/bullets";
import { sysDeployables } from "./systems/deployables";
import { sysPickups } from "./systems/pickups";
import { sysPlayer } from "./systems/player";
import { sysRespawn } from "./systems/respawn";
import { sysSiege } from "./systems/siege";
import { spawnStalker, sysStalker } from "./systems/stalker";
import type { State } from "./types";

/**
 * The headless authoritative step. The DO's setInterval loop calls this once per fixed tick.
 * Returns the frame's discrete siege outcome ("night"/"dawn"/null) INSTEAD of driving the
 * world reactions itself — the caller (the DO) advances the day on "dawn". There is no
 * game-over: an all-down party keeps running (respawn timers + the night clock carry to dawn).
 * Excludes sysFx/sysCamera (cosmetic, per-client). Pushed transition events are cosmetic
 * fxEvents; the DO clears them each tick.
 */
export function stepSim(state: State, dt: number): "night" | "dawn" | "breached" | "reset" | null {
  if (!state.running || state.paused) return null;
  let sdt = dt;
  if (state.hitstopT > 0) {
    state.hitstopT -= dt;
    sdt = dt * CONFIG.feel.hitstopScale;
  }
  state.time += sdt;
  const frozen = state.phase === "breached" || state.phase === "resetting";
  if (!frozen) {
    sysPlayer(state, sdt);
    sysAssist(state, sdt);
    sysRespawn(state, sdt);
    sysAI(state, sdt);
    if (state.stalker) sysStalker(state, sdt);
    sysDeployables(state, sdt);
    sysBullets(state, sdt);
    sysPickups(state, sdt);
  }
  const ev = sysSiege(state, sdt);
  if (ev === "night") {
    spawnStalker(state);
    pushFx(state, { t: "announce", label: "NIGHT", day: state.day });
    pushFx(state, { t: "audio", cue: "waveStart" });
    return "night";
  }
  if (ev === "dawn") {
    if (state.stalker) state.stalker.state = "retreat";
    pushFx(state, { t: "audio", cue: "dawn" });
    return "dawn";
  }
  if (ev === "breached") return "breached";
  if (ev === "reset") return "reset";
  return null;
}
