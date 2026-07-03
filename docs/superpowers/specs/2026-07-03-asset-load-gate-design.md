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
- `loadSprites` becomes **fail-loud for required assets** on TWO distinct failure modes:
  1. **Missing from the glob** — a required key renamed/deleted disappears from `SPRITE_ASSETS`
     entirely, so there is no image load to fail. `spritesReady()` must reject if any
     `REQUIRED_SPRITES` key has `spriteIndex(key) < 0`. (CI's `spriteAssets.test.ts` catches this
     at build time, but the runtime gate must not resolve on a broken build served locally.)
  2. **Fetch/decode failure** — a required key that IS in the glob but fails to load rejects the
     promise instead of `console.warn` + 1×1 placeholder.
- `spritesReady()` resolves **only after every required index has `spriteReady[index] === true`**
  — not merely after `loadSprites` returns. This closes the gap where the aggregate promise could
  resolve while a specific required sprite's texels never uploaded.
- The existing single-404-tolerance (keep other sprites' stable atlas index on one failure) is
  preserved for the packing/index logic; "fail loud" is layered on top as a required-set check, so
  a non-required future sprite can still fail gracefully while a required one aborts to the error
  state.

### 2. `audioAssets.ts` — expose sample-load completion; required-set; fix comments

- Introduce `REQUIRED_SAMPLE_KEYS` (analogous to `REQUIRED_SPRITES`) enumerating every key
  `audio.ts` actually plays, expanding the dynamic families explicitly: `shot_<weapon>` for each
  weapon in `WEAPON_ORDER`/the shot set, `groan_<walker|runner|brute>`, `kill_big`/`kill_small`,
  the loops `search`/`amb_day`/`amb_night`, and the flat keys (`hit`, `reload`, `reload_done`,
  `weapon_switch`, `hurt`, `dry_fire`, `pickup`, `melee`, `heal`, `click`, `dawn`, `repair`,
  `ui_select`, `ui_reject`, `wave_start`, `game_over`, `screech`, `light_die`). A Vitest guard
  (mirroring `spriteAssets.test.ts`) asserts each required key has ≥1 variant in the glob — so a
  dropped MP3 fails CI, not the player.
- `loadSamples(ctx, dest)` retains a module-level `loadPromise: Promise<void> | null`:
  - First call creates and stores it (decodes every registered sample);
  - subsequent calls are no-ops that keep the same promise (preserves today's `loadStarted`
    idempotency — `resume()` is invoked from many paths);
  - the promise **resolves only after every REQUIRED key has decoded ≥1 variant**, and **rejects**
    if a required key has zero variants or a required variant fails to fetch/decode (drops the
    current silent `catch(() => {})` swallow for required keys; non-required extras may still be
    tolerated).
- `whenSamplesReady(): Promise<void>` returns that shared `loadPromise`. If called before
  `loadSamples` has run (no AudioContext yet), it rejects with a clear "samples not started"
  error — callers must `Audio.resume()` first. This makes the Start-path ordering explicit and
  avoids a per-call fresh promise that could never resolve.
- Rewrite the module/function doc comments: samples are the sole one-shot source; the procedural
  beds in `audio.ts` are a separate layer, **not** a fallback for missing samples.

### 3. `audio.ts` — surface sample completion

- `Audio` gains `whenSamplesReady(): Promise<void>` (thin pass-through to `audioAssets`) so the
  Start path can await decode. `resume()` still triggers the load on first gesture as today.

### 4. `main.ts` — implement the gate

- `main()` becomes `async` and is invoked as `void main().catch(showFatalLoadingError)` (or wraps
  its body in `try/catch`) so a throw around `Renderer.spritesReady()` renders the `#loading`
  error state instead of an unhandled rejection:
  - immediately hide `#start` and show `#loading` (so no title flash over the canvas),
  - start the rAF loop (loop runs, but see draw gating below),
  - `await Renderer.spritesReady()`,
  - on success: hide `#loading`, show the title;
  - on failure: show the error state in `#loading`, stop (no title).
- rAF `frame()`: skip the world `draw()` until sprites are ready (a `spritesReady`-resolved flag).
  HUD/overlay handling is unaffected. **Draw-skip method chosen over delaying loop start** for
  minimal disruption to existing per-frame logic. The gate only suppresses world rendering before
  phase 1 completes; it does not block the worker ticker or co-op networking (those activate only
  after mode selection, which happens after phase 1).
- `startSingleRun()` becomes `async` with a **re-entry guard** (disable the Start button / a
  `startingSingleRun` latch before the first await) so a double-click can't launch concurrent
  awaits or call `startGame()` twice:
  - `Audio.resume()`, show `#loading`,
  - `await Audio.whenSamplesReady()`,
  - on success: `startGame()`; on failure: error state in `#loading`, re-enable Start.

### 5. `index.html` / `game/style.css` — `#loading` overlay

- New `<div id="loading" class="overlay">` reusing the title's horror styling (grime/vig/torch).
- Minimal content: a "LOADING…" label and an error text region (hidden unless a phase fails).
- **Must be fully opaque with no boot fade-in** (unlike `#start`, which animates from opacity 0 and
  can briefly reveal the canvas). Combined with the draw-skip, this guarantees no broken world frame
  is ever visible during phase 1.

### 6. Fallback removal — `game.ts`

- Remove the `layer < 0` SDF branch in the zombie draw path (circle/tri/hex fills + the dark
  silhouette ring). Enemies are drawn as sprites; the three enemy sprites are guaranteed by
  `REQUIRED_SPRITES` + `spriteAssets.test.ts`.
- The engine-drawn glowing **eyes** are already gated to SDF bodies only (`layer < 0`); they go
  away with that branch (sprites have baked faces). This is consistent, not a regression.
- Player SDF fallback is already removed (prior work).
- **Draw-time only.** This removes the SDF *rendering* branch. The `shape` and `eye` fields on
  `EnemyType`/`Zombie` (and their snapshot encoding in `net/snapshot.ts`) are left in place — a
  data-model/protocol cleanup is out of scope here to avoid a multiplayer wire change. Add a test
  that every `ENEMY_TYPES[*].sprite` resolves, so a future enemy without a sprite can't ship
  invisible.

## Scope decisions (YAGNI)

- **Co-op start paths are not wrapped in the Phase-2 audio gate.** Correction to an earlier
  assumption: the co-op lobby buttons (`mpCoopBtn`, `coop-quick`, `coop-host`, `coop-joincode`) do
  **not** fire `Audio.resume()` today (verified in `main.ts`), so samples are *not* guaranteed
  pre-loaded when a co-op run begins. However, co-op audio is **not regressed** by this change:
  `startGame()` (host) and `startClientGame()` (client) already call `Audio.resume()` themselves
  today, exactly as before — samples simply decode during the opening moments of the run (one-shots
  are briefly silent until decoded; the procedural dread bed plays immediately). Gating the net
  start paths would mean threading an async await through host-deploy and snapshot-driven client
  start for a marginal opening-seconds benefit. **Decision: Phase 2 wraps only the single-player
  Start button; co-op keeps today's exact audio behavior as a documented known limitation.** Phase 1
  (boot sprite gate) is mode-agnostic — it runs in `main()` before any mode is chosen, so all modes
  get the sprite gate.
  - *Note:* the client's `Audio.resume()` at `startClientGame` is snapshot-triggered, not
    gesture-triggered — a pre-existing condition unchanged by this design. Out of scope here.
- **No progress bar / percentage.** The gates are short; a label is enough. Can be added later if
  load time grows.

## Testing

- Follows the repo's "pure logic only" testing convention. The load gate, overlays, and draw
  wiring are experiential (async IO, DOM, GL) and are validated by **playtest**, not unit tests.
- Keep/extend the existing build-time guard `spriteAssets.test.ts` (asserts every
  `REQUIRED_SPRITES` key resolves) — it's the mechanism that makes fail-loud safe. Add a parallel
  `audioAssets.test.ts` asserting every `REQUIRED_SAMPLE_KEYS` entry has ≥1 variant, and a test that
  every `ENEMY_TYPES[*].sprite` resolves (so no enemy ships invisible after SDF removal).
- Playtest checklist: cold boot shows LOADING then title with no broken frame; Start shows a brief
  LOADING then the run; enemies/player render as sprites throughout; simulate a failed asset (e.g.
  temporarily rename a required PNG) and confirm the error state shows instead of a broken game.

## Risks

- **Runtime asset failure now blocks the game** (by design). Mitigated by the build-time required-
  asset test, so this only triggers on genuine network/decode failures — where an explicit error is
  the desired behavior.
- **Audio sample decode failure blocks Start.** Same rationale; required samples all exist and are
  guarded, so this is an exceptional-path safeguard, not an expected flow.
