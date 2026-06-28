/**
 * Sample-based SFX layer, layered behind the procedural Audio API (engine/audio.ts).
 *
 * Generated MP3s live in `src/audio/sfx/<key>[_n].mp3` and are auto-discovered at build
 * time — dropping a file in adds it to the registry with no code change. Playback is the
 * PREFERRED source; engine/audio.ts falls back to its synth when a key has no sample
 * (during async load, on fetch failure, or for keys never generated). Variants `<key>_1`,
 * `<key>_2`… of the same `key` are picked non-repeatingly to kill repetition fatigue.
 *
 * Module scope is deliberately PURE: it only turns the glob into a key→URL map. No fetch,
 * no decodeAudioData, no AudioContext — so importing this (via systems → audio.ts in the
 * Vitest node environment) has zero side effects. All IO happens in loadSamples(), called
 * from Audio.resume() after the first user gesture.
 */
import { CONFIG } from "../config";

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

// --- runtime state (set up by loadSamples; null until the first gesture) ---
let actx: AudioContext | null = null;
let dest: AudioNode | null = null;
let loadStarted = false;
const buffers = new Map<string, AudioBuffer[]>();
const lastIdx = new Map<string, number>();
// oldest-first list of currently-sounding sample sources (polyphony cap).
const active: AudioBufferSourceNode[] = [];

/**
 * Begin decoding every registered sample into AudioBuffers. Idempotent (resume() is called
 * from many UI paths), non-blocking, and failure-tolerant: a key that fails to load simply
 * stays absent so its method falls back to synth.
 */
export function loadSamples(ctx: AudioContext, destination: AudioNode): void {
  if (loadStarted) return;
  loadStarted = true;
  actx = ctx;
  dest = destination;
  for (const [key, list] of registry) {
    void Promise.all(
      list.map((url) =>
        fetch(url)
          .then((r) => r.arrayBuffer())
          .then((ab) => ctx.decodeAudioData(ab)),
      ),
    )
      .then((bufs) => {
        buffers.set(key, bufs);
      })
      .catch(() => {
        /* leave key unloaded → synth fallback in engine/audio.ts */
      });
  }
}

/**
 * Play the sample for `key` if loaded. Returns false when no sample is available so the
 * caller plays its procedural fallback instead. `pan` (-1..1) and `vol` (0..1) match the
 * synth's positional groan/screech model. Routes through the shared sample bus (mute +
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
