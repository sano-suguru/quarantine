/**
 * Batch-generate QUARANTINE's sound effects with the ElevenLabs Sound Effects API and write
 * them to game/audio/sfx/<key>[_n].mp3, where engine/audioAssets.ts auto-discovers them.
 *
 * Prompts + params live in the single source of truth game/data/sfx.ts (also used by the drift
 * test). This file is just the runner.
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
import { SFX, type SfxSpec } from "../game/data/sfx";

const OUT_DIR = "game/audio/sfx";
const OUTPUT_FORMAT = "mp3_44100_128"; // 192k needs Creator tier; drop to mp3_44100_64 if blocked
const CONCURRENCY = 3; // keep small to stay under rate limits
const MAX_RETRIES = 3;

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

async function genOne(spec: SfxSpec, path: string): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const audio = await client.textToSoundEffects.convert({
        text: spec.text,
        durationSeconds: spec.durationSeconds,
        promptInfluence: spec.promptInfluence,
        outputFormat: OUTPUT_FORMAT,
        ...(spec.loop ? { loop: true } : {}),
        ...(spec.modelId ? { modelId: spec.modelId } : {}),
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
const jobs: { spec: SfxSpec; path: string }[] = [];
for (const [key, spec] of Object.entries(SFX)) {
  if (onlyKeys.length && !onlyKeys.includes(key)) continue;
  const n = spec.variants ?? 1;
  for (let i = 1; i <= n; i++) {
    const path = `${OUT_DIR}/${key}${n > 1 ? `_${i}` : ""}.mp3`;
    if (!force && existsSync(path)) {
      console.log(`· skip (exists) ${path}`);
      continue;
    }
    jobs.push({ spec, path });
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
