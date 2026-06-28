/**
 * Batch-generate QUARANTINE's sound effects with the ElevenLabs Sound Effects API and write
 * them to src/audio/sfx/<key>[_n].mp3, where engine/audioAssets.ts auto-discovers them.
 *
 * Usage (Bun auto-loads .env → ELEVENLABS_API_KEY):
 *   bun run scripts/gen-sfx.ts                 # generate every missing file
 *   bun run scripts/gen-sfx.ts shot_pistol hit # only these keys
 *   bun run scripts/gen-sfx.ts --force         # regenerate (overwrite) everything
 *   bun run scripts/gen-sfx.ts --force shot_smg
 *
 * Generation is NON-DETERMINISTIC (you won't get the same audio twice) and costs credits, so
 * existing files are skipped unless --force. Commit the generated mp3s to lock them in. After
 * generating, listen and cull bad variants by hand (feel-first) — delete a `_n.mp3` and rerun
 * that key to reroll just that slot.
 */
import { existsSync } from "node:fs";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const OUT_DIR = "src/audio/sfx";
const OUTPUT_FORMAT = "mp3_44100_128"; // 192k needs Creator tier; drop to mp3_44100_64 if blocked
const CONCURRENCY = 3; // keep small to stay under rate limits
const MAX_RETRIES = 3;

type Spec = { text: string; dur: number; inf: number; variants?: number };

// key → prompt. variants>1 emits <key>_1..<key>_N (high-frequency + horror sounds, to kill
// repetition). Keys here must match the playSample() keys in engine/audio.ts.
const SFX: Record<string, Spec> = {
  // --- weapons (fire) ---
  shot_pistol: {
    text: "Designed game sound effect: a single dry 9mm pistol shot. Tight punchy transient, sharp crack with a firm low-mid body and a fast metallic slide rattle, short snappy tail. Close-mic, dry, mono, no reverb, no music.",
    dur: 0.8,
    inf: 0.7,
    variants: 3,
  },
  shot_smg: {
    text: "Designed game sound effect: a short full-auto SMG burst, 4 to 6 rounds. Fast light mechanical rattle, crisp high-end clatter, tight rhythmic stutter, minimal tail. Dry, mono, no music.",
    dur: 1.3,
    inf: 0.6,
    variants: 3,
  },
  shot_shotgun: {
    text: "Designed game sound effect: a heavy pump-action shotgun blast. Massive low-end thump and a sharp wide crack, gritty mid texture, followed by a mechanical pump-action shell rack. Dry, mono, no music.",
    dur: 1.3,
    inf: 0.7,
    variants: 3,
  },
  shot_rifle: {
    text: "Designed game sound effect: a single assault-rifle shot. Punchy aggressive crack with a snappy supersonic whip tail and a hard metallic mechanism click. Military, dry, mono, no music.",
    dur: 0.9,
    inf: 0.7,
    variants: 3,
  },
  shot_lmg: {
    text: "Designed game sound effect: a sustained light-machine-gun burst. Thunderous deep automatic fire, heavy mechanical pounding, relentless and powerful, slight room body. Dry, mono, no music.",
    dur: 2.5,
    inf: 0.6,
    variants: 3,
  },
  shot_magnum: {
    text: "Designed game sound effect: a single .44 magnum hand-cannon shot. Enormous deep boom with a brutal transient and a long resonant decaying tail, powerful and slow. Dry, mono, no music.",
    dur: 1.8,
    inf: 0.7,
    variants: 3,
  },
  melee: {
    text: "Designed game sound effect: a fast combat-knife swing followed by a wet meaty stab. Quick air whoosh, sharp flesh slice, visceral squelch impact. Close-mic, dry, mono, no music.",
    dur: 0.7,
    inf: 0.7,
  },
  reload: {
    text: "Designed game sound effect: tactical magazine reload start, empty mag release and detach, metallic handling clinks. Dry, close-mic, mono, no music.",
    dur: 0.9,
    inf: 0.7,
  },
  reload_done: {
    text: "Designed game sound effect: reload finish, fresh magazine seated with a solid clack and a charging-handle bolt slide snapping forward. Dry, mono, no music.",
    dur: 0.7,
    inf: 0.7,
  },
  dry_fire: {
    text: "Designed game sound effect: a single hollow empty-gun click, dry metallic trigger and firing-pin snap, no gunshot. Close-mic, mono.",
    dur: 0.5,
    inf: 0.8,
  },
  // --- zombies (dry/mono; the engine pans + attenuates by distance) ---
  hit: {
    text: "Designed game sound effect: a single bullet impact into rotten flesh, a wet punchy thwack with a short squelch. Close-mic, dry, mono, no music.",
    dur: 0.5,
    inf: 0.7,
    variants: 3,
  },
  kill_small: {
    text: "Designed game sound effect: a zombie death, a choked wet gurgling groan cut short by a soft body collapse thud. Visceral, dry, mono, no music.",
    dur: 1.3,
    inf: 0.6,
    variants: 3,
  },
  kill_big: {
    text: "Designed game sound effect: a large brute zombie death, deep guttural dying bellow collapsing into a heavy wet thud. Monstrous, oversized, dry, mono, no music.",
    dur: 1.8,
    inf: 0.6,
    variants: 3,
  },
  groan_walker: {
    text: "Designed game sound effect: a slow agonized zombie groan, low wet raspy gurgling moan, shambling undead, weary and creepy. Dry, mono, no music.",
    dur: 2.2,
    inf: 0.6,
    variants: 3,
  },
  groan_runner: {
    text: "Designed game sound effect: a frenzied feral zombie snarl, high ragged hissing growl, twitchy and aggressive. Dry, mono, no music.",
    dur: 1.6,
    inf: 0.6,
    variants: 3,
  },
  groan_brute: {
    text: "Designed game sound effect: a huge undead brute growl, deep guttural bellowing rumble, slow and menacing, oversized creature. Dry, mono, no music.",
    dur: 2.6,
    inf: 0.6,
    variants: 3,
  },
  screech: {
    text: "Designed game sound effect: a startled zombie shriek, a sudden sharp rising scream as it spots prey, ragged and piercing. Dry, mono, no music.",
    dur: 0.7,
    inf: 0.7,
    variants: 3,
  },
  // --- player / items ---
  hurt: {
    text: "Designed game sound effect: a male grunt of pain, short sharp pained gasp with a breath catch. Close-mic, dry, mono, no music.",
    dur: 0.5,
    inf: 0.7,
    variants: 3,
  },
  pickup: {
    text: "Designed game sound effect: a quick item pickup, metallic gear clink with a short bright confirming blip. Crisp, dry, mono, no music.",
    dur: 0.5,
    inf: 0.7,
  },
  heal: {
    text: "Designed game sound effect: using a medkit, a syringe injection hiss and a fabric bandage wrap, with a soft reassuring tone underneath. Dry, mono, no music.",
    dur: 1.3,
    inf: 0.6,
  },
  repair: {
    text: "Designed game sound effect: boarding a barricade, three heavy hammer hits driving nails into wooden planks, solid woody thuds. Dry, mono, no music.",
    dur: 1.3,
    inf: 0.7,
  },
  click: {
    text: "Designed game sound effect: a flashlight toggle, a tactile mechanical switch click with a faint electrical ignition buzz. Close-mic, dry, mono.",
    dur: 0.5,
    inf: 0.8,
  },
  light_die: {
    text: "Designed game sound effect: a flashlight dying, a sputtering electrical buzz with a descending filament whine fading to silence. Dry, mono, no music.",
    dur: 0.8,
    inf: 0.7,
  },
  // --- cycle / stingers ---
  wave_start: {
    text: "Cinematic horror stinger: night falls, a deep ominous sub-bass rumble swelling into a booming low hit, rising dread, dark and oppressive. No music melody.",
    dur: 3,
    inf: 0.6,
    variants: 2,
  },
  dawn: {
    text: "Cinematic stinger: dawn after surviving, a warm hopeful rising tone with soft airy shimmer and distant faint birdsong, relief and calm.",
    dur: 4,
    inf: 0.5,
  },
  game_over: {
    text: "Cinematic horror stinger: death, a slow descending ominous drone collapsing into a hollow low boom, then fading to hopeless silence. Dark, no music melody.",
    dur: 4,
    inf: 0.5,
    variants: 2,
  },
  // --- UI ---
  ui_select: {
    text: "Designed UI sound effect: a crisp confirming menu blip, short clean two-note rising tick, digital and tactile. Dry, mono, no music.",
    dur: 0.5,
    inf: 0.8,
  },
  ui_reject: {
    text: "Designed UI sound effect: a low dull error buzz, short negative denied tone. Dry, mono, no music.",
    dur: 0.5,
    inf: 0.8,
  },
};

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey || apiKey === "sk_REPLACE_ME") {
  console.error("✗ ELEVENLABS_API_KEY is not set (edit .env with your real key).");
  process.exit(1);
}
const client = new ElevenLabsClient({ apiKey });

const args = process.argv.slice(2);
const force = args.includes("--force");
const onlyKeys = args.filter((a: string) => !a.startsWith("--"));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function genOne(spec: Spec, path: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const audio = await client.textToSoundEffects.convert({
        text: spec.text,
        durationSeconds: spec.dur,
        promptInfluence: spec.inf,
        outputFormat: OUTPUT_FORMAT,
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of audio) chunks.push(chunk);
      await Bun.write(path, new Blob(chunks as BlobPart[]));
      console.log(`✓ ${path}`);
      return;
    } catch (err) {
      const last = attempt === MAX_RETRIES;
      console.warn(`  ! ${path} attempt ${attempt}/${MAX_RETRIES} failed: ${String(err)}`);
      if (last) throw err;
      await sleep(1000 * 2 ** (attempt - 1)); // exponential backoff
    }
  }
}

// Build the work list (skipping existing files unless --force), then run with a small pool.
const jobs: { key: string; spec: Spec; path: string }[] = [];
for (const [key, spec] of Object.entries(SFX)) {
  if (onlyKeys.length && !onlyKeys.includes(key)) continue;
  const n = spec.variants ?? 1;
  for (let i = 1; i <= n; i++) {
    const path = `${OUT_DIR}/${key}${n > 1 ? `_${i}` : ""}.mp3`;
    if (!force && existsSync(path)) {
      console.log(`· skip (exists) ${path}`);
      continue;
    }
    jobs.push({ key, spec, path });
  }
}

if (!jobs.length) {
  console.log("Nothing to generate (all present — use --force to regenerate).");
  process.exit(0);
}
console.log(`Generating ${jobs.length} file(s) → ${OUT_DIR}/  (format ${OUTPUT_FORMAT})`);

let cursor = 0;
let failures = 0;
async function worker(): Promise<void> {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    if (!job) break;
    try {
      await genOne(job.spec, job.path);
    } catch {
      failures++;
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

console.log(`Done. ${jobs.length - failures} ok, ${failures} failed.`);
process.exit(failures ? 1 : 0);
