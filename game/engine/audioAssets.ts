/**
 * Sample-based SFX layer. Every one-shot SFX and zombie voice in engine/audio.ts is sample-based
 * and plays through here — there is NO synth fallback for a missing one-shot (the boot/Start load
 * gate in main.ts guarantees the required samples are decoded before play). The only procedural
 * audio left is the continuous dread/tension drone bed + heartbeat in audio.ts, a SEPARATE layer
 * with no sample equivalent — not a fallback for these samples.
 *
 * Generated MP3s live in `game/audio/sfx/<key>[_n].mp3` and are auto-discovered at build time —
 * dropping a file in adds it to the registry with no code change (a required key is guarded by
 * audioAssets.test.ts). Variants `<key>_1`, `<key>_2`… of the same `key` are picked
 * non-repeatingly to kill repetition fatigue.
 *
 * Module scope is deliberately PURE: it only turns the glob into a key→URL map. No fetch, no
 * decodeAudioData, no AudioContext — so importing this (via systems → audio.ts in the Vitest node
 * environment) has zero side effects. All IO happens in loadSamples(), called from Audio.resume()
 * after the first user gesture.
 */
import { CONFIG } from "../../sim/config";

// Build-time registry: file URLs only (strings via `?url` — never inlined into JS).
const urls = import.meta.glob<string>("../audio/sfx/*.mp3", {
  query: "?url",
  import: "default",
  eager: true,
});

/** key → variant URLs, sorted by trailing `_n` (single files sort as n=0). */
const registry = new Map<string, string[]>();
{
  const grouped = new Map<string, { n: number; url: string }[]>();
  for (const [path, url] of Object.entries(urls)) {
    const base = (path.split("/").pop() ?? "").replace(/\.mp3$/i, "");
    const m = base.match(/^(.+?)_(\d+)$/);
    const key = m?.[1] ?? base;
    const n = m ? Number(m[2]) : 0;
    const arr = grouped.get(key) ?? [];
    arr.push({ n, url });
    grouped.set(key, arr);
  }
  for (const [key, arr] of grouped) {
    arr.sort((a, b) => a.n - b.n);
    registry.set(
      key,
      arr.map((x) => x.url),
    );
  }
}

/**
 * Samples the game hard-depends on. audio.ts plays these one-shots/loops with NO synth fallback,
 * so a missing/renamed MP3 must fail the build (audioAssets.test.ts) rather than play silence.
 * Covers the dynamic families explicitly: shot_<gun> for each firing weapon (knife is melee),
 * groan_<walker|runner|brute>, kill_big/kill_small, the loops search/amb_day/amb_night, plus the
 * flat one-shot keys.
 */
export const REQUIRED_SAMPLE_KEYS: readonly string[] = [
  "shot_pistol",
  "shot_smg",
  "shot_shotgun",
  "shot_rifle",
  "shot_lmg",
  "shot_magnum",
  "groan_walker",
  "groan_runner",
  "groan_brute",
  "kill_big",
  "kill_small",
  "search",
  "amb_day",
  "amb_night",
  "hit",
  "reload",
  "reload_done",
  "weapon_switch",
  "hurt",
  "dry_fire",
  "pickup",
  "melee",
  "heal",
  "click",
  "dawn",
  "repair",
  "ui_select",
  "ui_reject",
  "wave_start",
  "game_over",
  "screech",
  "light_die",
];

/** Number of decoded-able variants discovered for `key` (0 = not present in the glob). */
export function sampleVariantCount(key: string): number {
  return registry.get(key)?.length ?? 0;
}

// Shared across every resume() caller so they all await the SAME decode, not a per-call promise.
let loadPromise: Promise<void> | null = null;

/** Required keys that have NOT decoded ≥1 variant, per the `has` predicate. */
function missingRequiredSamples(has: (key: string) => boolean): string[] {
  return REQUIRED_SAMPLE_KEYS.filter((k) => !has(k));
}

/**
 * Resolves once every REQUIRED sample has decoded ≥1 variant; rejects if a required variant fails
 * to fetch/decode or a required key has zero variants. Rejects immediately if called before
 * loadSamples() has run (no AudioContext yet) — callers must Audio.resume() first.
 */
export function whenSamplesReady(): Promise<void> {
  return (
    loadPromise ?? Promise.reject(new Error("[sfx] samples not started (call Audio.resume first)"))
  );
}

// --- runtime state (set up by loadSamples; null until the first gesture) ---
let actx: AudioContext | null = null;
let dest: AudioNode | null = null;
let loadStarted = false;
const buffers = new Map<string, AudioBuffer[]>();
const lastIdx = new Map<string, number>();
// oldest-first list of currently-sounding ONE-SHOT sources (polyphony cap). Loops are NOT
// tracked here — mixing them in would let a gunfire spike stop an ambience loop as "oldest".
const active: AudioBufferSourceNode[] = [];
// active looping sources, keyed (one per key: search / amb_day / amb_night).
const loops = new Map<string, { src: AudioBufferSourceNode; gain: GainNode }>();

/**
 * Begin decoding every registered sample into AudioBuffers. Idempotent (resume() is called from
 * many UI paths): the first call stores a shared `loadPromise`; later calls are no-ops that keep
 * it. The promise resolves only after every REQUIRED key decodes ≥1 variant and rejects if a
 * required key fails or is absent — non-required extras may still fail silently. whenSamplesReady()
 * exposes it so the Start path can await decode before the run begins.
 */
export function loadSamples(ctx: AudioContext, destination: AudioNode): void {
  if (loadStarted) return;
  loadStarted = true;
  actx = ctx;
  dest = destination;
  const tasks: Promise<void>[] = [];
  for (const [key, list] of registry) {
    tasks.push(
      Promise.all(
        list.map((url) =>
          fetch(url)
            .then((r) => r.arrayBuffer())
            .then((ab) => ctx.decodeAudioData(ab)),
        ),
      )
        .then((bufs) => {
          buffers.set(key, bufs);
        })
        // Swallow per-key failures here (required OR not); required-ness is enforced by the single
        // missing-check below, so the thrown error can list the FULL set of unready required keys
        // rather than aborting on the first rejection. Mirrors renderer.loadSprites' allSettled path.
        .catch(() => {}),
    );
  }
  loadPromise = Promise.all(tasks).then(() => {
    const missing = missingRequiredSamples((k) => (buffers.get(k)?.length ?? 0) > 0);
    if (missing.length > 0) {
      throw new Error(`[sfx] required samples failed to load: ${missing.join(", ")}`);
    }
  });
  // Log boot asset failures for diagnostics AND mark the rejection handled so it never surfaces as
  // an unhandledrejection. resume() can be reached from the title Options (mute/aim toggles) before
  // — or without — the Start click, which is the only path that awaits whenSamplesReady(); without
  // this, a failed required decode would leak an unhandled rejection. Mirrors renderer.init().
  void loadPromise.catch((e) => console.error("[sfx]", e));
}

/**
 * Play the sample for `key` if loaded. Returns false when the sample isn't available; callers no
 * longer synth a per-shot procedural fallback — the load gate guarantees every REQUIRED key is
 * decoded before a run starts, so the boolean is advisory only. `pan` (-1..1) and `vol` (0..1)
 * match the positional groan/screech model. Routes through the shared sample bus (mute +
 * sfxVolume + compressor live there). Caps polyphony to avoid BufferSource pile-ups and
 * clipping in a full horde — over the cap, the oldest sample is stopped.
 */
export function playSample(key: string, opts?: { pan?: number; vol?: number }): boolean {
  const bufs = buffers.get(key);
  if (!actx || !dest || !bufs || bufs.length === 0) return false;

  let idx = 0;
  if (bufs.length > 1) {
    const prev = lastIdx.get(key) ?? -1;
    idx = Math.floor(Math.random() * bufs.length);
    if (idx === prev) idx = (idx + 1) % bufs.length;
    lastIdx.set(key, idx);
  }
  const buf = bufs[idx];
  if (!buf) return false;

  const src = actx.createBufferSource();
  src.buffer = buf;
  let node: AudioNode = src;

  const vol = opts?.vol;
  if (vol !== undefined && vol !== 1) {
    const g = actx.createGain();
    g.gain.value = Math.max(0, vol);
    node.connect(g);
    node = g;
  }
  const pan = opts?.pan;
  if (pan !== undefined && pan !== 0) {
    const p = actx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    node.connect(p);
    node = p;
  }
  node.connect(dest);

  active.push(src);
  src.onended = () => {
    const i = active.indexOf(src);
    if (i >= 0) active.splice(i, 1);
  };
  src.start();

  while (active.length > CONFIG.audio.maxSampleVoices) {
    const oldest = active.shift();
    try {
      oldest?.stop();
    } catch {
      /* already stopped */
    }
  }
  return true;
}

/**
 * Start/stop a seamless looping sample for `key` (search / amb_day / amb_night), driven every
 * frame from the render loop. Idempotent: calling with the same `on` state is a no-op, so it's
 * cheap to call at frame rate. Fades in/out over CONFIG.audio.loopFadeSec. Routes through the
 * sample bus (mute + sfxVolume + compressor apply), kept OUT of the one-shot polyphony cap.
 */
export function setLoop(key: string, on: boolean, vol = 1): void {
  if (!actx || !dest) return;
  const fade = CONFIG.audio.loopFadeSec;
  const existing = loops.get(key);
  if (on) {
    if (existing) return; // already playing
    const bufs = buffers.get(key);
    const buf = bufs?.[0];
    if (!buf) return; // not loaded yet — a later frame retries
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = actx.createGain();
    g.gain.setValueAtTime(0, actx.currentTime);
    g.gain.setTargetAtTime(Math.max(0, vol), actx.currentTime, fade);
    src.connect(g).connect(dest);
    src.start();
    loops.set(key, { src, gain: g });
  } else {
    if (!existing) return;
    loops.delete(key);
    existing.gain.gain.setTargetAtTime(0, actx.currentTime, fade);
    // stop well after the fade settles; a re-`on` makes a fresh source so there's no mix-up.
    try {
      existing.src.stop(actx.currentTime + fade * 6);
    } catch {
      /* already stopped */
    }
    existing.src.onended = () => existing.src.disconnect();
  }
}

/** Stop every looping sample immediately-ish (fade out). Used at game over / title. */
export function stopAllLoops(): void {
  for (const key of [...loops.keys()]) setLoop(key, false);
}
