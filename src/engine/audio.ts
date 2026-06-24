/**
 * Procedural Web Audio — no asset files. Every sound is synthesised from
 * oscillators + noise + envelopes. Lazily created on the first user gesture
 * (the Deploy button) to satisfy autoplay policies.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuf: AudioBuffer | null = null;

// ambient drone (continuous bed of dread)
let droneGain: GainNode | null = null;
let droneTarget = 0;

let muted = false;
try {
  muted = localStorage.getItem("q_muted") === "1";
} catch {
  /* localStorage may be unavailable */
}

function makeNoise(): AudioBuffer {
  const c = ctx as AudioContext;
  const len = Math.floor(c.sampleRate * 1.2);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** Create the context on first gesture and start the ambient bed. */
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
    noiseBuf = makeNoise();

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
  }
  if (ctx.state === "suspended") void ctx.resume();
}

function env(node: AudioNode, gain: number, attack: number, decay: number): GainNode {
  const c = ctx as AudioContext;
  const g = c.createGain();
  const t = c.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  node.connect(g).connect(master as GainNode);
  return g;
}

function tone(
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  slideTo?: number,
): void {
  if (!ctx) return;
  const o = ctx.createOscillator();
  o.type = type;
  const t = ctx.currentTime;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo !== undefined)
    o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
  env(o, gain, 0.004, dur);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise(dur: number, gain: number, filterType: BiquadFilterType, freq: number, q = 1): void {
  if (!ctx || !noiseBuf) return;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.value = freq;
  f.Q.value = q;
  src.connect(f);
  env(f, gain, 0.003, dur);
  src.start(ctx.currentTime);
  src.stop(ctx.currentTime + dur + 0.05);
}

function shot(weapon: string): void {
  if (!ctx) return;
  if (weapon === "shotgun") {
    noise(0.22, 0.7, "lowpass", 1600, 0.7);
    tone(120, 0.18, "sawtooth", 0.4, 40);
  } else if (weapon === "smg") {
    noise(0.07, 0.32, "highpass", 900);
    tone(420, 0.05, "square", 0.18, 180);
  } else {
    noise(0.1, 0.4, "bandpass", 1400, 1.2);
    tone(300, 0.08, "square", 0.22, 110);
  }
}

function hit(): void {
  tone(880, 0.04, "square", 0.12, 500);
  noise(0.04, 0.15, "highpass", 2600);
}

function kill(big: boolean): void {
  if (big) {
    tone(180, 0.5, "sawtooth", 0.4, 40);
    noise(0.5, 0.5, "lowpass", 700, 0.8);
  } else {
    tone(260, 0.28, "sawtooth", 0.28, 70);
    noise(0.25, 0.3, "bandpass", 900, 0.9);
  }
}

function reload(): void {
  if (!ctx) return;
  noise(0.06, 0.22, "highpass", 1800);
  tone(180, 0.05, "square", 0.12, 120);
}

function reloadDone(): void {
  if (!ctx) return;
  tone(320, 0.05, "square", 0.16, 200);
  noise(0.05, 0.25, "bandpass", 2200, 1.2);
}

function hurt(): void {
  noise(0.3, 0.55, "lowpass", 900, 0.9);
  tone(140, 0.25, "sawtooth", 0.3, 60);
}

function ui(select: boolean): void {
  resume();
  if (select) {
    tone(520, 0.08, "sine", 0.2);
    tone(780, 0.12, "sine", 0.18);
  } else {
    tone(440, 0.05, "sine", 0.12);
  }
}

function waveStart(): void {
  tone(60, 1.1, "sawtooth", 0.5, 150);
  noise(0.7, 0.25, "lowpass", 400, 0.7);
}

function gameOver(): void {
  tone(220, 1.4, "sawtooth", 0.5, 50);
  tone(110, 1.6, "sine", 0.4, 30);
  noise(1.4, 0.3, "lowpass", 600);
}

function groan(pan: number): void {
  if (!ctx) return;
  const o = ctx.createOscillator();
  o.type = "sawtooth";
  const t = ctx.currentTime;
  const f0 = 90 + Math.random() * 60;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.linearRampToValueAtTime(f0 * 0.7, t + 0.5);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 500;
  const p = ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.18, t + 0.1);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  o.connect(lp)
    .connect(p)
    .connect(g)
    .connect(master as GainNode);
  o.start(t);
  o.stop(t + 0.7);
}

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
}

export const Audio = {
  resume,
  shot,
  hit,
  kill,
  reload,
  reloadDone,
  hurt,
  ui,
  waveStart,
  gameOver,
  groan,
  heartbeat,
  setDread,
  stopDread,
  toggleMute,
  setMuted,
  isMuted,
};
