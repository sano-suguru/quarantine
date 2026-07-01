/**
 * Batch-generate QUARANTINE's enemy sprites with Gemini 2.5 Flash Image ("nano-banana") and write
 * them to game/assets/sprites/<key>.png, where engine/spriteAssets.ts auto-discovers them and the
 * renderer packs them into one atlas.
 *
 * Prompts live in the single source of truth game/data/sprites.ts (subject) + SPRITE_STYLE (shared
 * style/orientation anchor). This file is the runner: it generates the raw image, then post-
 * processes it into a game-ready PNG (transparent bg + NEAREST downscale + binarized alpha + square
 * pad) via scripts/process-sprite.py.
 *
 * Usage (Bun auto-loads .env → GEMINI_API_KEY):
 *   bun run gen:sprites                 # generate every missing sprite
 *   bun run gen:sprites zombie          # only these keys
 *   bun run gen:sprites --force         # regenerate (overwrite) everything
 *   bun run gen:sprites --force zombie
 *
 * Requires python3 + Pillow (PIL) for post-processing (see scripts/process-sprite.py).
 *
 * Generation is NON-DETERMINISTIC (you won't get the same image twice) and costs API credits, so
 * existing files are skipped unless --force. Raw generations are kept in game/assets/sprites/raw/
 * (gitignored) so you can re-process without re-generating. Commit the final PNGs to lock them in,
 * then judge them by playing — orientation (front toward the bottom of the frame) and flat lighting
 * are load-bearing; reroll a bad one with --force <key>.
 */
import { existsSync, mkdirSync } from "node:fs";
import { GoogleGenAI } from "@google/genai";
import { SPRITE_GEN, SPRITE_STYLE, type SpriteSpec } from "../game/data/sprites";

const OUT_DIR = "game/assets/sprites";
const RAW_DIR = "game/assets/sprites/raw";
const MODEL = "gemini-2.5-flash-image"; // nano-banana
const TARGET = 128; // final atlas sprite is TARGET×TARGET (matches process-sprite.py default)
const CONCURRENCY = 2; // image gen is heavy; keep small to stay under rate limits
const MAX_RETRIES = 3;

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey || apiKey === "REPLACE_ME") {
  console.error("✗ GEMINI_API_KEY is not set (edit .env with your real key).");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey });

const args = process.argv.slice(2);
const force = args.includes("--force");
const onlyKeys = args.filter((a: string) => !a.startsWith("--"));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// biome-ignore lint/suspicious/noExplicitAny: the SDK response part shape is only optionally typed
function firstImageData(parts: any[]): string | null {
  for (const part of parts) {
    const data = part?.inlineData?.data;
    if (typeof data === "string" && data.length > 0) return data;
  }
  return null;
}

async function processRaw(rawPath: string, outPath: string): Promise<void> {
  const proc = Bun.spawn(
    ["python3", "scripts/process-sprite.py", rawPath, outPath, String(TARGET)],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`process-sprite.py failed (exit ${code}): ${err.trim()}`);
  }
}

async function genOne(key: string, spec: SpriteSpec): Promise<void> {
  const rawPath = `${RAW_DIR}/${key}.png`;
  const outPath = `${OUT_DIR}/${key}.png`;
  const prompt = `${SPRITE_STYLE} Subject: ${spec.prompt}`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({ model: MODEL, contents: prompt });
      const data = firstImageData(response.candidates?.[0]?.content?.parts ?? []);
      if (!data) throw new Error("no image in response");
      await Bun.write(rawPath, Buffer.from(data, "base64"));
      await processRaw(rawPath, outPath);
      console.log(`✓ ${outPath}`);
      return;
    } catch (err) {
      const last = attempt === MAX_RETRIES;
      console.warn(`  ! ${outPath} attempt ${attempt}/${MAX_RETRIES} failed: ${String(err)}`);
      if (last) throw err;
      await sleep(1000 * 2 ** (attempt - 1)); // exponential backoff
    }
  }
}

mkdirSync(RAW_DIR, { recursive: true });

// Build the work list (skipping existing files unless --force), then run with a small pool.
const jobs: { key: string; spec: SpriteSpec }[] = [];
for (const [key, spec] of Object.entries(SPRITE_GEN)) {
  if (onlyKeys.length && !onlyKeys.includes(key)) continue;
  if (!force && existsSync(`${OUT_DIR}/${key}.png`)) {
    console.log(`· skip (exists) ${OUT_DIR}/${key}.png`);
    continue;
  }
  jobs.push({ key, spec });
}

if (!jobs.length) {
  console.log("Nothing to generate (all present — use --force to regenerate).");
  process.exit(0);
}
console.log(`Generating ${jobs.length} sprite(s) → ${OUT_DIR}/  (model ${MODEL})`);

let cursor = 0;
let failures = 0;
async function worker(): Promise<void> {
  while (cursor < jobs.length) {
    const job = jobs[cursor++];
    if (!job) break;
    try {
      await genOne(job.key, job.spec);
    } catch {
      failures++;
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

console.log(`Done. ${jobs.length - failures} ok, ${failures} failed.`);
process.exit(failures ? 1 : 0);
