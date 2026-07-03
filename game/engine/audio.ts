/**
 * Web Audio. One-shot SFX and zombie voices are sample-based (see audioAssets.ts); only the
 * continuous dread/tension drone beds and the heartbeat stay procedural (they need real-time
 * gain/frequency modulation that samples can't do). The context + beds are lazily created on
 * the first user gesture (the Deploy button) to satisfy autoplay policies, and the samples
 * begin decoding at the same moment.
 */
import { CONFIG } from "../config";
import {
  loadSamples,
  playSample,
  whenSamplesReady as samplesReady,
  setLoop,
  stopAllLoops,
} from "./audioAssets";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
// samples bus: each sample source → sampleBus → compressor → master. The procedural beds
// connect to master directly, so the sample chain is fully separate from the synth signal.
let sampleBus: GainNode | null = null;

// ambient drone (continuous bed of dread)
let droneGain: GainNode | null = null;
let droneTarget = 0;
// tension layer (high dissonant cluster for unseen threats)
let tensionGain: GainNode | null = null;

let muted = false;
try {
  muted = localStorage.getItem("q_muted") === "1";
} catch {
  /* localStorage may be unavailable */
}

/** Create the context on first gesture, start the ambient bed, and begin loading samples. */
function resume(): void {
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.9;
    master.connect(ctx.destination);

    // samples sub-bus: volume-balanced + compressed (tames horde clipping), then into master
    // so mute still gates everything.
    sampleBus = ctx.createGain();
    sampleBus.gain.value = CONFIG.audio.sfxVolume;
    const comp = ctx.createDynamicsCompressor();
    sampleBus.connect(comp).connect(master);
    loadSamples(ctx, sampleBus);

    // ambient: detuned low drone through a slow lowpass
    droneGain = ctx.createGain();
    droneGain.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 220;
    droneGain.connect(lp).connect(master);
    for (const f of [42, 56, 84]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.4;
      o.connect(g).connect(droneGain);
      o.start();
    }

    // tension: a quiet, deliberately dissonant high cluster (minor-second + tritone) through a
    // bandpass. Rides on unseen-threat count via setTension — unsettling, never blaring.
    tensionGain = ctx.createGain();
    tensionGain.gain.value = 0;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1300;
    bp.Q.value = 0.7;
    tensionGain.connect(bp).connect(master);
    for (const f of [330, 349, 466]) {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.05;
      o.connect(g).connect(tensionGain);
      o.start();
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
}

// --- one-shot SFX: thin wrappers over the sample player (keys live in game/audio/sfx/) ---

function shot(weapon: string): void {
  playSample(`shot_${weapon}`);
}

function hit(): void {
  playSample("hit");
}

function kill(big: boolean): void {
  playSample(big ? "kill_big" : "kill_small");
}

function reload(): void {
  playSample("reload");
}

function reloadDone(): void {
  playSample("reload_done");
}

/** weapon swap: holster the old gun, ready the new one. One universal sound (the switch logic
 *  is weapon-agnostic); a future per-weapon draw could move to `switch_<weapon>` like shots. */
function switchWeapon(): void {
  playSample("weapon_switch");
}

function hurt(): void {
  playSample("hurt");
}

function dryFire(): void {
  playSample("dry_fire");
}

function pickup(): void {
  playSample("pickup");
}

function melee(): void {
  playSample("melee");
}

function heal(): void {
  playSample("heal");
}

function click(): void {
  playSample("click");
}

function dawn(): void {
  playSample("dawn");
}

function repair(): void {
  playSample("repair");
}

function ui(select: boolean): void {
  resume(); // a UI click is often the first gesture — wake the context + kick off sample load
  playSample(select ? "ui_select" : "ui_reject");
}

function waveStart(): void {
  playSample("wave_start");
}

function gameOver(): void {
  playSample("game_over");
}

/** zombie vocalisation. `type` (walker/runner/brute) selects the timbre; `pan`/`vol` place it. */
function groan(pan: number, type = "walker", vol = 1): void {
  playSample(`groan_${type}`, { pan, vol });
}

/** sharp rising shriek when a lurking zombie is suddenly caught in the flashlight cone. */
function screech(pan: number, vol = 1): void {
  playSample("screech", { pan, vol });
}

function lightDie(): void {
  playSample("light_die");
}

/** start/stop a looping sample (search / amb_day / amb_night), driven from the render loop. */
function loop(key: string, on: boolean, vol?: number): void {
  setLoop(key, on, vol);
}

/** stop all looping samples (game over / title). */
function stopLoops(): void {
  stopAllLoops();
}

// --- procedural beds (kept: continuous real-time modulation, no sample equivalent) ---

function heartbeat(strength: number): void {
  if (!ctx) return;
  const thump = (at: number, amp: number): void => {
    const o = (ctx as AudioContext).createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(70, at);
    o.frequency.exponentialRampToValueAtTime(35, at + 0.12);
    const g = (ctx as AudioContext).createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(amp, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
    o.connect(g).connect(master as GainNode);
    o.start(at);
    o.stop(at + 0.2);
  };
  const t = ctx.currentTime;
  thump(t, 0.5 * strength);
  thump(t + 0.16, 0.32 * strength);
}

/** ambient drone intensity 0..1 (smoothed) */
function setDread(level: number): void {
  droneTarget = Math.max(0, Math.min(1, level));
  if (droneGain && ctx) {
    droneGain.gain.setTargetAtTime(droneTarget * 0.22, ctx.currentTime, 0.8);
  }
}

/** high dissonant tension layer 0..1 (smoothed); driven by unseen-threat count */
function setTension(level: number): void {
  if (tensionGain && ctx) {
    const v = Math.max(0, Math.min(1, level));
    tensionGain.gain.setTargetAtTime(v * 0.05, ctx.currentTime, 0.5);
  }
}

function setMuted(m: boolean): void {
  muted = m;
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.05);
  try {
    localStorage.setItem("q_muted", m ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function toggleMute(): boolean {
  setMuted(!muted);
  return muted;
}

function isMuted(): boolean {
  return muted;
}

function stopDread(): void {
  setDread(0);
  setTension(0);
}

/** Resolves when the required samples have decoded; rejects on failure. See audioAssets. */
function whenSamplesReady(): Promise<void> {
  return samplesReady();
}

export const Audio = {
  resume,
  shot,
  hit,
  kill,
  reload,
  reloadDone,
  switchWeapon,
  hurt,
  dryFire,
  pickup,
  melee,
  heal,
  click,
  dawn,
  repair,
  ui,
  waveStart,
  gameOver,
  groan,
  screech,
  lightDie,
  loop,
  stopLoops,
  heartbeat,
  setDread,
  setTension,
  stopDread,
  toggleMute,
  setMuted,
  isMuted,
  whenSamplesReady,
};
