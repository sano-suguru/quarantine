# Asset load gate & fallback removal — design

## Problem

The renderer starts drawing the world before its sprite atlas finishes loading, so the first
frames after boot show a broken/incomplete world (SDF placeholder enemies, and — now that the
player has no SDF fallback — a missing player). The game also carries runtime fallbacks that no
longer earn their keep now that sprites are first-class content: enemy SDF shapes, the renderer's
silent per-sprite degradation, and stale "falls back to synth" comments in the audio layer whose
one-shot synth was already removed.

Two goals:

1. **Load gate** — don't show anything playable/broken until the assets it needs are ready.
2. **Fallback removal** — with a load guarantee in place, remove the runtime fallbacks so a bad
   state fails loudly at build/load time instead of shipping a degraded experience.

## Constraints

- **Audio can't load before a user gesture.** `AudioContext` (and therefore sample decode via
  `loadSamples`) can only start after the first user interaction (browser autoplay policy). So
  images can be loaded at boot, but samples can only be loaded after the player clicks Start.
- **Procedural audio beds are not fallbacks.** `heartbeat`, `setDread`, `setTension` in
  `audio.ts` are a continuous, real-time-modulated layer with no sample equivalent. They stay.
- **One-shot synth fallback is already gone.** Every one-shot SFX in `audio.ts` (`shot`, `hit`,
  `kill`, `groan`, `screech`, …) already calls `playSample` only. The `audioAssets.ts` comments
  still claim a synth fallback — those are stale and get corrected here.
- **All required samples exist.** Every key referenced by `audio.ts` has a generated MP3 under
  `game/audio/sfx/` (verified). Complete fallback removal is therefore safe.
- **Single-player must stay behavior-identical** apart from the added boot/start gating.

## Approach: two-phase load gate

```
[boot] main() (async)
  → show #loading (rAF loop runs but draw() skips the world until sprites are ready)
  → PHASE 1: await Renderer.spritesReady()   (no gesture needed)
  → hide #loading → show title (#start)

[Start pressed = first gesture] startSingleRun()
  → Audio.resume()  (starts AudioContext + kicks off sample decode)
  → show #loading
  → PHASE 2: await Audio.whenSamplesReady()
  → startGame()

[failure in either phase]
  → show an error message in #loading and DO NOT proceed
```

### Why a loading screen at Start too

Samples can only decode after the gesture, so a second brief gate at Start is the price of
"everything loaded before play." In practice most of the decode overlaps title reading, so the
visible wait is short.

## Components

### 1. `renderer.ts` — expose sprite-load completion; fail loud

- Replace fire-and-forget `void loadSprites()` with a retained promise, exposed as
  `Renderer.spritesReady(): Promise<void>`.
- `loadSprites` becomes **fail-loud for required assets**: a fetch/decode failure of a
  `REQUIRED_SPRITES` entry rejects the promise instead of `console.warn` + 1×1 placeholder.
  (Non-required future sprites may keep tolerant behavior, but the current set is all required.)

### 2. `audioAssets.ts` — expose sample-load completion; fail loud; fix comments

- `loadSamples(ctx, dest)` tracks its decode promises and exposes completion, e.g.
  `whenSamplesReady(): Promise<void>` that resolves once every registered sample is decoded.
- Failure of a required sample rejects (drops the current silent `catch(() => {})` swallow).
- Rewrite the module/function doc comments: samples are the sole one-shot source; the procedural
  beds in `audio.ts` are a separate layer, **not** a fallback for missing samples.

### 3. `audio.ts` — surface sample completion

- `Audio` gains `whenSamplesReady(): Promise<void>` (thin pass-through to `audioAssets`) so the
  Start path can await decode. `resume()` still triggers the load on first gesture as today.

### 4. `main.ts` — implement the gate

- `main()` becomes `async`:
  - show `#loading`, start the rAF loop (loop runs, but see draw gating below),
  - `await Renderer.spritesReady()`,
  - on success: hide `#loading`, show the title;
  - on failure: show the error state in `#loading`, stop.
- rAF `frame()`: skip the world `draw()` until sprites are ready (a `spritesReady`-resolved flag).
  HUD/overlay handling is unaffected. **Draw-skip method chosen over delaying loop start** for
  minimal disruption to existing per-frame logic.
- `startSingleRun()`:
  - `Audio.resume()`, show `#loading`,
  - `await Audio.whenSamplesReady()`,
  - on success: `startGame()`; on failure: error state in `#loading`.

### 5. `index.html` / `game/style.css` — `#loading` overlay

- New `<div id="loading" class="overlay">` reusing the title's horror styling (grime/vig/torch).
- Minimal content: a "LOADING…" label and an error text region (hidden unless a phase fails).

### 6. Fallback removal — `game.ts`

- Remove the `layer < 0` SDF branch in the zombie draw path (circle/tri/hex fills + the dark
  silhouette ring). Enemies are drawn as sprites; the three enemy sprites are guaranteed by
  `REQUIRED_SPRITES` + `spriteAssets.test.ts`.
- The engine-drawn glowing **eyes** are already gated to SDF bodies only (`layer < 0`); they go
  away with that branch (sprites have baked faces). This is consistent, not a regression.
- Player SDF fallback is already removed (prior work).

## Scope decisions (YAGNI)

- **Co-op start paths are not wrapped in the Phase-2 audio gate.** Host-deploy and client-join go
  through the lobby, whose interactions (opening Co-op, entering a code) already fire
  `Audio.resume()` well before a run starts, so samples are effectively loaded by then. Gating the
  net start paths would touch host/client code for negligible benefit. Phase 2 wraps only the
  single-player Start button. Phase 1 (boot sprite gate) is mode-agnostic — it runs in `main()`
  before any mode is chosen, so all modes benefit.
- **No progress bar / percentage.** The gates are short; a label is enough. Can be added later if
  load time grows.

## Testing

- Follows the repo's "pure logic only" testing convention. The load gate, overlays, and draw
  wiring are experiential (async IO, DOM, GL) and are validated by **playtest**, not unit tests.
- Keep/extend the existing build-time guard `spriteAssets.test.ts` (asserts every
  `REQUIRED_SPRITES` key resolves) — it's the mechanism that makes fail-loud safe.
- Playtest checklist: cold boot shows LOADING then title with no broken frame; Start shows a brief
  LOADING then the run; enemies/player render as sprites throughout; simulate a failed asset (e.g.
  temporarily rename a required PNG) and confirm the error state shows instead of a broken game.

## Risks

- **Runtime asset failure now blocks the game** (by design). Mitigated by the build-time required-
  asset test, so this only triggers on genuine network/decode failures — where an explicit error is
  the desired behavior.
- **Audio sample decode failure blocks Start.** Same rationale; required samples all exist and are
  guarded, so this is an exceptional-path safeguard, not an expected flow.
