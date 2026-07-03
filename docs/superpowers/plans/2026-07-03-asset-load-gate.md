# Asset Load Gate & Fallback Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate boot on required sprite loading and gate Start on required audio-sample decoding, then remove the now-redundant runtime fallbacks (enemy SDF draw path, silent sprite/audio degradation) so a bad asset state fails loudly instead of shipping a degraded game.

**Architecture:** A two-phase load gate. Phase 1 runs in an async `main()` at boot: an opaque `#loading` overlay covers the canvas and `draw()` is skipped until `Renderer.spritesReady()` resolves (no user gesture needed for images). Phase 2 runs when the single-player Start button is pressed (the first user gesture, required by the browser autoplay policy): `Audio.resume()` kicks off sample decode and `startSingleRun()` awaits `Audio.whenSamplesReady()` before `startGame()`. Both `renderer.ts` and `audioAssets.ts` gain fail-loud completion promises validated against explicit required-asset registries that are unit-tested at build time.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), WebGL2, Web Audio, Vite (`import.meta.glob`), Vitest, Biome, Bun.

## Global Constraints

- Package manager / runner is **Bun** (`bun run <script>`). Type-check with `bun run typecheck`; test with `bun run test`; lint with `bun run lint`.
- TypeScript is strict with `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`. **No casts that bypass these** (`import type` for type-only imports).
- Biome formatting is enforced: **2-space indent, double quotes, semicolons, trailing commas, 100-column width**. Run `bun run lint:fix` if the pre-commit hook rejects formatting.
- Tests cover **pure, deterministic logic only**. The load gate, overlays, async IO, and GL/DOM wiring are experiential and validated by **playtest**, not unit tests. Only the required-asset registries and pure helpers are unit-tested.
- **Single-player must stay behavior-identical** apart from the added boot/Start gating. Do not alter host/client update paths.
- Co-op start paths are **out of scope** for the Phase-2 audio gate (documented limitation): `startGame`/`startClientGame` already call `Audio.resume()` themselves; that behavior is unchanged. Phase 1 (sprite gate) is mode-agnostic (runs in `main()` before any mode is chosen).
- **Draw-time only** for SDF removal: remove the SDF *rendering* branch and eyes. Leave `shape`/`eye` fields on `EnemyType`/`Zombie` and their `net/snapshot.ts` encoding in place (no multiplayer wire change).
- Commit trailer required on every commit:
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`
- Lefthook pre-commit runs Biome on staged files; pre-push runs `typecheck` + `test`.

---

## File Structure

- `game/engine/audioAssets.ts` (modify) — add `REQUIRED_SAMPLE_KEYS`, `sampleVariantCount`, `missingRequiredSamples`, a shared `loadPromise`, `whenSamplesReady()`; rewrite stale synth-fallback comments.
- `game/engine/audioAssets.test.ts` (create) — build-time guard: every required sample key has ≥1 variant in the glob.
- `game/engine/audio.ts` (modify) — expose `Audio.whenSamplesReady()` pass-through.
- `game/engine/spriteAssets.ts` (modify) — add pure `unreadyRequiredSprites()` helper.
- `game/engine/spriteAssets.test.ts` (modify) — add a test for `unreadyRequiredSprites`.
- `game/engine/renderer.ts` (modify) — retain the sprite-load promise, expose `Renderer.spritesReady()`, make `loadSprites` fail-loud on required assets.
- `game/data/enemies.test.ts` (create) — every `ENEMY_TYPES[*].sprite` resolves to a packed atlas index.
- `index.html` (modify) — add the `#loading` overlay markup.
- `game/style.css` (modify) — opaque (no-fade) `#loading` styling.
- `game/main.ts` (modify) — async `main()` boot gate + `frame()` draw-skip + async `startSingleRun()` phase-2 gate + re-entry guard + `showLoadError` + top-level `.catch`.
- `game/game.ts` (modify) — remove the enemy SDF draw branch + eyes.

---

## Task 1: Required-sample registry + build-time guard

**Files:**
- Modify: `game/engine/audioAssets.ts` (add exports after the `registry` block, ~line 44)
- Test: `game/engine/audioAssets.test.ts` (create)

**Interfaces:**
- Produces: `REQUIRED_SAMPLE_KEYS: readonly string[]`, `sampleVariantCount(key: string): number`.

- [ ] **Step 1: Write the failing test**

Create `game/engine/audioAssets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { REQUIRED_SAMPLE_KEYS, sampleVariantCount } from "./audioAssets";

// Build-time guard: the eager import.meta.glob resolves the sample set at bundle time, so a
// dropped/renamed MP3 silently disappears from the registry (sampleVariantCount → 0) instead of
// erroring. audio.ts has no synth fallback, so this test is the detection mechanism — it fails
// CI/pre-push if a required sound is gone, rather than shipping a silent one-shot.
describe("required sample assets", () => {
  for (const key of REQUIRED_SAMPLE_KEYS) {
    it(`"${key}" has at least one variant in the glob`, () => {
      expect(sampleVariantCount(key)).toBeGreaterThanOrEqual(1);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- game/engine/audioAssets.test.ts`
Expected: FAIL — `REQUIRED_SAMPLE_KEYS`/`sampleVariantCount` are not exported from `audioAssets.ts`.

- [ ] **Step 3: Add the registry and accessor**

In `game/engine/audioAssets.ts`, immediately after the `registry` construction block (the closing `}` at ~line 44, before the `// --- runtime state` comment at line 46), insert:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- game/engine/audioAssets.test.ts`
Expected: PASS — 32 assertions green (every required key maps to ≥1 file under `game/audio/sfx/`).

- [ ] **Step 5: Commit**

```bash
git add game/engine/audioAssets.ts game/engine/audioAssets.test.ts
git commit -m "test: guard required audio samples exist at build time

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Sample-load completion promise + fail-loud + comment fix

**Files:**
- Modify: `game/engine/audioAssets.ts` (module doc ~lines 1-14; `loadSamples` doc + body ~lines 58-83; add `loadPromise`, `whenSamplesReady`, `missingRequiredSamples`)

**Interfaces:**
- Consumes: `REQUIRED_SAMPLE_KEYS` (Task 1).
- Produces: `whenSamplesReady(): Promise<void>` — resolves after every required key decodes ≥1 variant; rejects if a required key fails or has zero variants, or if called before `loadSamples` ran. `missingRequiredSamples(has: (key: string) => boolean): string[]`.

- [ ] **Step 1: Rewrite the stale module doc comment**

Replace the module doc block at the top of `game/engine/audioAssets.ts` (lines 1-14, from `/**` through `*/`) with:

```ts
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
```

- [ ] **Step 2: Add the shared load promise and required-set helper**

Directly below the `sampleVariantCount` function added in Task 1, add:

```ts
// Shared across every resume() caller so they all await the SAME decode, not a per-call promise.
let loadPromise: Promise<void> | null = null;

/** Required keys that have NOT decoded ≥1 variant, per the `has` predicate. */
export function missingRequiredSamples(has: (key: string) => boolean): string[] {
  return REQUIRED_SAMPLE_KEYS.filter((k) => !has(k));
}

/**
 * Resolves once every REQUIRED sample has decoded ≥1 variant; rejects if a required variant fails
 * to fetch/decode or a required key has zero variants. Rejects immediately if called before
 * loadSamples() has run (no AudioContext yet) — callers must Audio.resume() first.
 */
export function whenSamplesReady(): Promise<void> {
  return (
    loadPromise ??
    Promise.reject(new Error("[sfx] samples not started (call Audio.resume first)"))
  );
}
```

- [ ] **Step 3: Rewrite `loadSamples` doc + body to gate on required keys**

Replace the `loadSamples` doc comment (lines 58-62) and its function body (lines 63-83) with:

```ts
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
    const decode = Promise.all(
      list.map((url) =>
        fetch(url)
          .then((r) => r.arrayBuffer())
          .then((ab) => ctx.decodeAudioData(ab)),
      ),
    ).then((bufs) => {
      buffers.set(key, bufs);
    });
    // Required keys must decode (reject on failure); a non-required extra may still fail silently.
    tasks.push(REQUIRED_SAMPLE_KEYS.includes(key) ? decode : decode.catch(() => {}));
  }
  loadPromise = Promise.all(tasks).then(() => {
    const missing = missingRequiredSamples((k) => (buffers.get(k)?.length ?? 0) > 0);
    if (missing.length > 0) {
      throw new Error(`[sfx] required samples failed to load: ${missing.join(", ")}`);
    }
  });
}
```

- [ ] **Step 4: Type-check**

Run: `bun run typecheck`
Expected: PASS (no errors). Note `REQUIRED_SAMPLE_KEYS` is typed `readonly string[]`, so `.includes(key)` accepts a general `string`.

- [ ] **Step 5: Confirm existing tests still pass**

Run: `bun run test -- game/engine/audioAssets.test.ts`
Expected: PASS (registry/glob behavior unchanged; only load-completion plumbing added).

- [ ] **Step 6: Commit**

```bash
git add game/engine/audioAssets.ts
git commit -m "feat: fail-loud shared sample-load promise (whenSamplesReady)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: `Audio.whenSamplesReady()` pass-through

**Files:**
- Modify: `game/engine/audio.ts` (import line 9; add wrapper; add to `Audio` export ~line 248)

**Interfaces:**
- Consumes: `whenSamplesReady` from `audioAssets` (Task 2).
- Produces: `Audio.whenSamplesReady(): Promise<void>`.

- [ ] **Step 1: Import the pass-through target**

In `game/engine/audio.ts`, change the import on line 9 from:

```ts
import { loadSamples, playSample, setLoop, stopAllLoops } from "./audioAssets";
```

to:

```ts
import {
  loadSamples,
  playSample,
  setLoop,
  stopAllLoops,
  whenSamplesReady as samplesReady,
} from "./audioAssets";
```

- [ ] **Step 2: Add the wrapper function**

Add this function just above the `export const Audio = {` object (near line 248):

```ts
/** Resolves when the required samples have decoded; rejects on failure. See audioAssets. */
function whenSamplesReady(): Promise<void> {
  return samplesReady();
}
```

- [ ] **Step 3: Expose it on the `Audio` object**

Add `whenSamplesReady,` to the `Audio` export object (alongside `resume`, `isMuted`, etc.).

- [ ] **Step 4: Type-check**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add game/engine/audio.ts
git commit -m "feat: expose Audio.whenSamplesReady pass-through

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Sprite required-ready helper + `Renderer.spritesReady()` fail-loud

**Files:**
- Modify: `game/engine/spriteAssets.ts` (add `unreadyRequiredSprites` after `spriteIndex`, ~line 34)
- Test: `game/engine/spriteAssets.test.ts` (extend)
- Modify: `game/engine/renderer.ts` (import line 8; `init` line 201; `loadSprites` lines 336-373; `Renderer` export ~line 615)

**Interfaces:**
- Consumes: `REQUIRED_SPRITES`, `spriteIndex` (existing).
- Produces: `unreadyRequiredSprites(isReady: (index: number) => boolean): string[]`; `Renderer.spritesReady(): Promise<void>` — resolves only after every required sprite index has uploaded texels; rejects on a missing/failed required sprite.

- [ ] **Step 1: Write the failing helper test**

In `game/engine/spriteAssets.test.ts`, add the import and a new `describe` block:

```ts
import { REQUIRED_SPRITES, spriteIndex, unreadyRequiredSprites } from "./spriteAssets";
```

```ts
describe("unreadyRequiredSprites", () => {
  it("returns empty when every required index reports ready", () => {
    expect(unreadyRequiredSprites(() => true)).toEqual([]);
  });

  it("returns every required key when none report ready", () => {
    expect(unreadyRequiredSprites(() => false)).toEqual([...REQUIRED_SPRITES]);
  });

  it("returns only the keys whose index is not ready", () => {
    const bruteIdx = spriteIndex("brute");
    expect(unreadyRequiredSprites((i) => i !== bruteIdx)).toEqual(["brute"]);
  });
});
```

(Keep the existing `import { REQUIRED_SPRITES, spriteIndex } from "./spriteAssets";` line replaced by the combined import above.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- game/engine/spriteAssets.test.ts`
Expected: FAIL — `unreadyRequiredSprites` is not exported.

- [ ] **Step 3: Implement the pure helper**

In `game/engine/spriteAssets.ts`, after the `spriteIndex` function (line 32-34), add:

```ts
/**
 * Required sprites that are NOT usable yet: either missing from the glob (spriteIndex < 0) or
 * their atlas texels haven't uploaded (`isReady(index)` false). Empty = all required sprites ready.
 * The renderer's spritesReady() gate uses this so a broken/incomplete required set fails loud
 * instead of drawing an invisible player/enemy.
 */
export function unreadyRequiredSprites(isReady: (index: number) => boolean): string[] {
  return REQUIRED_SPRITES.filter((key) => {
    const i = spriteIndex(key);
    return i < 0 || !isReady(i);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- game/engine/spriteAssets.test.ts`
Expected: PASS (all `describe` blocks green).

- [ ] **Step 5: Wire the completion promise into the renderer**

In `game/engine/renderer.ts`:

(a) Extend the import on line 8:

```ts
import { SPRITE_ASSETS, spriteIndex, unreadyRequiredSprites } from "./spriteAssets";
```

(b) Add a module-level promise holder near the other renderer module state (above `function init`):

```ts
let spritesReadyPromise: Promise<void> | null = null;
```

(c) In `init()`, replace line 201 `void loadSprites();` with:

```ts
  spritesReadyPromise = loadSprites();
```

(d) Replace the `loadSprites` early-return + validation. Change line 337 from:

```ts
  if (SPRITE_ASSETS.length === 0) return;
```

to:

```ts
  if (SPRITE_ASSETS.length === 0) {
    throw new Error("[sprites] no sprite assets found (build/glob broken)");
  }
```

Then, at the END of `loadSprites` (after the `for` upload loop closes at line 372, before the function's closing `}` at line 373), add:

```ts
  // Fail loud on required assets: a required key missing from the glob (index < 0) or whose texels
  // never uploaded (spriteReady false) aborts to the load-error state rather than drawing invisibly.
  const missing = unreadyRequiredSprites((i) => spriteReady[i] === true);
  if (missing.length > 0) {
    throw new Error(`[sprites] required sprites failed to load: ${missing.join(", ")}`);
  }
```

(e) Add the `spritesReady` accessor function (place it just above the `Renderer` export near line 611):

```ts
function spritesReady(): Promise<void> {
  return spritesReadyPromise ?? Promise.reject(new Error("[sprites] renderer not initialized"));
}
```

(f) Add `spritesReady,` to the `Renderer` export object (after `spriteLayer,`).

(g) Update the stale `console.warn` string in `loadSprites` (line 342) from `"using SDF fallback"` to reflect the new behavior — replace lines 341-344:

```ts
    console.warn(`[sprites] "${SPRITE_ASSETS[i]?.key}" failed to load`, res.reason);
```

- [ ] **Step 6: Type-check + full test run**

Run: `bun run typecheck && bun run test`
Expected: PASS (all existing tests plus the new sprite/audio guards).

- [ ] **Step 7: Commit**

```bash
git add game/engine/spriteAssets.ts game/engine/spriteAssets.test.ts game/engine/renderer.ts
git commit -m "feat: Renderer.spritesReady fail-loud gate for required sprites

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Enemy sprite-coverage guard

**Files:**
- Test: `game/data/enemies.test.ts` (create)

**Interfaces:**
- Consumes: `ENEMY_TYPES` (`Record<string, EnemyType>`), `spriteIndex`.

- [ ] **Step 1: Write the failing/covering test**

Create `game/data/enemies.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { spriteIndex } from "../engine/spriteAssets";
import { ENEMY_TYPES } from "./enemies";

// After the SDF draw path is removed, an enemy with no packed sprite would render invisible. This
// guard fails the build if any enemy's `sprite` key isn't in the atlas.
describe("enemy sprite coverage", () => {
  for (const [name, e] of Object.entries(ENEMY_TYPES)) {
    it(`enemy "${name}" (sprite "${e.sprite}") resolves to a packed atlas index`, () => {
      expect(spriteIndex(e.sprite)).toBeGreaterThanOrEqual(0);
    });
  }
});
```

- [ ] **Step 2: Run the test**

Run: `bun run test -- game/data/enemies.test.ts`
Expected: PASS — `zombie`, `runner`, `brute` all resolve (they are in `REQUIRED_SPRITES`).

- [ ] **Step 3: Commit**

```bash
git add game/data/enemies.test.ts
git commit -m "test: guard every enemy type has a packed sprite

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: `#loading` overlay (opaque, no fade)

**Files:**
- Modify: `index.html` (after line 15, before `#hud`)
- Modify: `game/style.css` (append near the other overlay rules)

**Interfaces:**
- Produces: DOM ids `loading` and `loading-error` used by `main.ts` (Task 7).

- [ ] **Step 1: Add the overlay markup**

In `index.html`, insert after line 15 (`<div id="netstat"></div>`) and before `<div id="hud" ...>`:

```html
<div id="loading" class="overlay loading hidden">
  <div class="loading-label">LOADING…</div>
  <div id="loading-error" class="loading-error hidden"></div>
</div>
```

- [ ] **Step 2: Add the opaque, no-fade styling**

Append to `game/style.css` (after the existing `.overlay` / `@keyframes fadeIn` rules):

```css
/* Load gate: fully opaque (unlike .overlay's semi-transparent gradient) with NO fade-in, so the
   canvas is never revealed mid-load. Paired with main.ts's draw-skip, no broken frame shows. */
#loading {
  background: #070a08;
  animation: none;
}
.loading-label {
  color: var(--toxic);
  font: 600 14px/1.4 ui-monospace, "SFMono-Regular", Menlo, monospace;
  letter-spacing: 0.32em;
  opacity: 0.85;
}
.loading-error {
  margin-top: 14px;
  max-width: 320px;
  color: #ff6b6b;
  font: 500 13px/1.5 system-ui, sans-serif;
}
```

- [ ] **Step 3: Verify markup + lint**

Run: `bun run lint`
Expected: PASS (Biome checks index.html + css config paths; fix formatting with `bun run lint:fix` if flagged).

- [ ] **Step 4: Commit**

```bash
git add index.html game/style.css
git commit -m "feat: opaque #loading overlay for the asset load gate

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: Two-phase gate wiring in `main.ts`

**Files:**
- Modify: `game/main.ts` (`startSingleRun` lines 162-166; `main` signature line 175 + start-button wiring line 180 + end of `main` ~line 445; `frame` draw call line 403; entry `main();` line 1067; add module-level `spritesLoaded` + `showLoadError`)

**Interfaces:**
- Consumes: `Renderer.spritesReady()` (Task 4), `Audio.whenSamplesReady()` (Task 3), DOM ids `loading`/`loading-error` (Task 6).
- Produces: async boot + Start gating (no exports).

- [ ] **Step 1: Add module-level gate state + error helper**

In `game/main.ts`, just above `function startSingleRun` (line 162), add:

```ts
// True once Phase 1 (sprite load) completes — frame() skips the world draw until then so no
// broken/incomplete frame is shown behind the #loading overlay.
let spritesLoaded = false;
// Re-entry latch for the async Start path: a double-click must not launch two awaits / two runs.
let startingSingleRun = false;

/** Surface a load failure in the #loading overlay and stop (the user must reload). */
function showLoadError(msg: string): void {
  show("loading");
  const errEl = el("loading-error");
  errEl.textContent = msg;
  errEl.classList.remove("hidden");
}
```

- [ ] **Step 2: Make `startSingleRun` async with the Phase-2 audio gate**

Replace `startSingleRun` (lines 162-166):

```ts
/** Solo Start: tear down any lingering co-op session, then build the single-player world. */
function startSingleRun(): void {
  endCoop();
  startGame();
}
```

with:

```ts
/**
 * Solo Start (first user gesture): open the AudioContext, wait for the required samples to decode
 * behind a brief #loading gate, then build the single-player world. Re-entry-guarded so a
 * double-click can't launch concurrent awaits or start the run twice.
 */
async function startSingleRun(): Promise<void> {
  if (startingSingleRun) return;
  startingSingleRun = true;
  const startBtn = el<HTMLButtonElement>("startBtn");
  startBtn.disabled = true;
  try {
    endCoop();
    Audio.resume(); // first gesture: opens AudioContext + kicks off sample decode
    hide("start");
    show("loading");
    await Audio.whenSamplesReady();
    hide("loading");
    startGame();
  } catch {
    showLoadError("Failed to load game audio. Please reload the page.");
  } finally {
    startBtn.disabled = false;
    startingSingleRun = false;
  }
}
```

- [ ] **Step 3: Wire the Start button to the async runner**

Change line 180 from:

```ts
  el("startBtn").onclick = startSingleRun;
```

to:

```ts
  el("startBtn").onclick = () => void startSingleRun();
```

- [ ] **Step 4: Make `main` async and add the Phase-1 boot gate**

Change the `main` signature (line 175) from `function main(): void {` to `async function main(): Promise<void> {`.

Then replace the tail of `main` — the `requestAnimationFrame(frame);` at line 445 and the closing brace at line 446:

```ts
  requestAnimationFrame(frame);
}
```

with:

```ts
  requestAnimationFrame(frame);

  // PHASE 1 (no gesture needed): cover the canvas with the opaque #loading overlay and skip the
  // world draw until the sprite atlas is ready, so the first frames are never broken/incomplete.
  hide("start");
  show("loading");
  try {
    await Renderer.spritesReady();
  } catch {
    showLoadError("Failed to load game graphics. Please reload the page.");
    return;
  }
  spritesLoaded = true;
  hide("loading");
  show("start");
}
```

- [ ] **Step 5: Skip the world draw until sprites are ready**

Change line 403 from:

```ts
    draw();
```

to:

```ts
    if (spritesLoaded) draw();
```

- [ ] **Step 6: Guard the entry point against an early throw**

Change line 1067 from:

```ts
main();
```

to:

```ts
void main().catch(() => showLoadError("Failed to start the game. Please reload the page."));
```

- [ ] **Step 7: Type-check + full test run**

Run: `bun run typecheck && bun run test`
Expected: PASS.

- [ ] **Step 8: Playtest the gate (per repo convention — experiential, not unit-tested)**

Run: `bun run dev`, then in the browser:
- Cold load shows `LOADING…` then the title, with **no** broken/empty canvas frame.
- Click Start: a brief `LOADING…` then the run begins; player + enemies render as sprites.
- Simulate failure: temporarily rename `game/assets/sprites/player.png`, reload → the error text shows in `#loading` and the title never appears. Restore the file after.

- [ ] **Step 9: Commit**

```bash
git add game/main.ts
git commit -m "feat: two-phase asset load gate at boot and Start

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 8: Remove the enemy SDF draw branch + eyes

**Files:**
- Modify: `game/game.ts` (zombie draw path, lines 515-574)

**Interfaces:**
- Consumes: enemy sprite coverage guaranteed by Task 5's test; `Renderer.spritesReady()` gate (Task 7) guarantees sprites are loaded before any run draws.

- [ ] **Step 1: Replace the SDF-conditional draw with sprite-only draw**

In `game/game.ts`, replace lines 515-574 (from `const spriteKey = ...` through the closing `}` of the eyes `for` loop) with:

```ts
    const spriteKey = ENEMY_TYPES[z.type]?.sprite;
    const layer = spriteKey ? R.spriteLayer(spriteKey) : -1;
    if (layer >= 0) {
      // A textured sprite already has its own colors, so its tint is WHITE at full HP (true
      // illustration), darkening toward blood only as it's wounded. The hit-flash is a >1
      // overbright multiply (brightens the texel on hit). Normal pass (u_emissive 0) → still black
      // outside the flashlight cone.
      const flash = 1 + fl * SPRITE_FLASH;
      const tr = (1 + (gg.woundTint[0] - 1) * wound) * dk * flash;
      const tg = (1 + (gg.woundTint[1] - 1) * wound) * dk * flash;
      const tb = (1 + (gg.woundTint[2] - 1) * wound) * dk * flash;
      // Rotate so the illustration's front (its bottom, local -y) points at the target from any
      // direction. Drawn at SPRITE_SCALE× the hitbox (bare rad*2 mushes).
      const sz = rad * 2 * SPRITE_SCALE;
      R.spriteQuad(zx, zy, sz, sz, face + SPRITE_FACE_OFFSET, layer, tr, tg, tb, grow);
    }
```

This removes: the `else` SDF branch (circle/tri/hex fills + the dark silhouette ring, old lines 533-549) and the entire `if (layer < 0)` glowing-eyes block (old lines 551-574). The `shape`/`eye`/`color` fields remain on the types and snapshot encoding (out of scope).

- [ ] **Step 2: Type-check + lint (catches any now-unused imports/locals)**

Run: `bun run typecheck && bun run lint`
Expected: PASS. `SHAPE` is still used elsewhere in `game.ts` (bullets/rings at lines ~620, ~647), so its import stays. If Biome/tsc flags an unused local from the removed block, remove that local.

- [ ] **Step 3: Confirm the enemy-sprite guard still passes**

Run: `bun run test -- game/data/enemies.test.ts`
Expected: PASS (this is the safety net that makes SDF removal safe).

- [ ] **Step 4: Playtest enemy rendering (experiential)**

Run: `bun run dev`, start a run, advance to night: all zombie/runner/brute variants render as sprites (no SDF placeholders, no mismatched glowing eyes), including wound-tint darkening and the hit-flash pop.

- [ ] **Step 5: Commit**

```bash
git add game/game.ts
git commit -m "refactor: remove enemy SDF draw fallback (sprites are required)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Final verification

- [ ] **Full gate run:** `bun run typecheck && bun run lint && bun run test`
Expected: all green (new guards: `audioAssets.test.ts`, `enemies.test.ts`, extended `spriteAssets.test.ts`).

- [ ] **Build:** `bun run build`
Expected: succeeds (`dist/` produced).

---

## Self-Review (author checklist — completed during planning)

**1. Spec coverage** (`docs/superpowers/specs/2026-07-03-asset-load-gate-design.md`):
- Component 1 (renderer spritesReady + fail-loud, two failure modes, required-index readiness) → Task 4.
- Component 2 (audioAssets REQUIRED_SAMPLE_KEYS + shared loadPromise + whenSamplesReady + reject rules + comment rewrite) → Tasks 1, 2.
- Component 3 (Audio.whenSamplesReady pass-through) → Task 3.
- Component 4 (async main gate, frame draw-skip, async startSingleRun + re-entry guard, top-level catch) → Task 7.
- Component 5 (#loading overlay, opaque, no fade) → Task 6.
- Component 6 (remove enemy SDF branch + eyes; keep data/snapshot fields; enemy-sprite test) → Tasks 5, 8.
- Scope decisions (co-op not gated in Phase 2; no progress bar) → honored (Task 7 wraps only single-player Start).
- Testing section (pure-logic guards only; playtest for experiential) → Tasks 1/4/5 unit tests; Tasks 7/8 playtest steps.

**2. Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N"/"write tests for the above". Every code step contains the actual code.

**3. Type consistency:** `spritesReady()`/`whenSamplesReady()`/`unreadyRequiredSprites()`/`missingRequiredSamples()`/`sampleVariantCount()`/`REQUIRED_SAMPLE_KEYS`/`showLoadError()`/`startingSingleRun`/`spritesLoaded` are named identically across the tasks that define and consume them. `REQUIRED_SAMPLE_KEYS` typed `readonly string[]` so `.includes(key: string)` type-checks under strict.
