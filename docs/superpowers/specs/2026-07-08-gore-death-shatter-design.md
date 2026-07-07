# Gore: Death Shatter + Lingering Blood-Flesh Design

**Date:** 2026-07-08
**Status:** Brainstormed & approved (option A, "all-recommended"); **pending rubber-duck review**, then user review, then plan.
**Kind:** Feel/juice upgrade to the existing gore FX. Sharpens the crowd-sweep satisfaction (SAS3 pillar) without touching the renderer, shaders, or art.
**Depends on:** existing `game/systems/fx.ts` (`goreIntensity`, `gibsToSpawn`, `fxKill`, `fxImpact`, `bloodPool`/`pushDecal`), `CONFIG.fx.gore`/`CONFIG.fx.blood`, the particle + decal systems in `sysFx`.

## Problem

Killing a zombie today emits an **abstract** burst — a shockwave ring plus small `"shard"` particles and embers (`fxKill` in `game/systems/fx.ts`), which expire and vanish. It reads as a generic "pop," not as a body coming apart, and it leaves nothing behind. The crowd-sweep — the game's proven fun — lacks the visceral payoff of bodies bursting and the battlefield accumulating carnage.

## Goal

On death, a zombie's **body visibly shatters into flesh chunks** that fly out and **settle as lingering decals**, so kills feel meaty and the ground fills with the evidence of a hard-fought night. Stylized (pixel + top-down + fantasy zombies) so it stays within PEGI 12 for CrazyGames, and fully tunable behind `CONFIG.fx.gore` so intensity is a data dial, never a rewrite.

## Scope

**In scope:**
- Upgrade `fxKill`'s abstract shard burst into beefier, flesh-colored **body chunks** (a new `ParticleKind: "chunk"`), count/size scaled by the existing `goreIntensity` + the `big` flag.
- Chunks fly with physics and **settle as decals** on expiry (extends the existing decal system).
- New `CONFIG.fx.gore` tuning fields for chunk count/size and chunk-decal radius.

**Explicitly deferred (NOT in this spec):**
- **Procedural living-body carving** (body visibly loses parts *while alive*, per-hit). This is the heavier renderer/shader path (instance-layout + shader change); revisit only if death-shatter alone doesn't satisfy the "身体がちぎれる" craving.
- **Player-facing low-gore toggle / settings UI.** The default is already PEGI-12-safe and every value is in `CONFIG.fx.gore`, so a QA flag is a config edit, not a feature. A player toggle is a separate accessibility/rating concern for later.
- Any change to `fxImpact` (non-lethal hits) beyond what already exists — this spec is about the *death* moment.

## Non-goals / constraints (scope fence)

- **No renderer / shader / instance-layout change, no new art.** Everything rides the existing particle + decal instanced draw.
- **No sim-state change, net-agnostic, single-player-safe.** Chunks/decals are visual-only (`state.particles` / `state.decals`), never affect the sim. Co-op clients already re-derive `fxKill` from the snapshot kill-diff (`client.ts`), so the new chunks + chunk-decals re-derive on clients for free — **no snapshot/wire change, no new synced state.**
- **PEGI 12 / stylized.** Default intensity stays non-realistic (blocky flesh chunks, muted/dark blood consistent with the current `CONFIG.fx.blood` palette). Tunable down if QA flags.
- **Tunable, data-driven.** All new magic numbers live in `CONFIG.fx.gore`; no constants baked into `fx.ts` logic.

## Architecture

All changes are in `game/systems/fx.ts` + `game/config.ts` + `game/types.ts` (the `ParticleKind` union) + `game/systems/fx.test.ts` (pure-helper tests).

### 1. New `ParticleKind: "chunk"`

Add `"chunk"` to the `ParticleKind` union (`game/types.ts:302`, currently `"spark" | "shard" | "ring" | "smoke"`). A chunk is a flesh-colored body fragment: it flies with drag (same physics path as `"shard"` in the `sysFx` update loop — the existing `else` branch that applies `Math.exp(-drag*dt)` already handles any non-`ring` kind, so chunks need no new physics), and it draws as a small solid shape.

**Draw:** chunks render as a small solid, slightly-rotated shape (reuse an existing primitive — `hex` or `rect` from the `SHAPE` enum) in the chunk's color, alpha fading with `life/maxLife`. Wherever particle kinds are dispatched to primitives in the draw pass, add a `chunk` case. (Chunks are drawn in the normal, non-additive layer — flesh, not glow.)

### 2. `fxKill` upgrade — the shatter

`fxKill(state, x, y, color, glow, big)` keeps its shockwave ring, embers, and `bloodPool`. Its body-fragment burst changes from abstract `"shard"` to `"chunk"`:
- Count from a pure helper (see §4), scaled by `big` and a gore level, replacing the current hardcoded `n = big ? 22 : 12` split for the flesh fragments (the ring/ember counts can stay as-is or reference the same helper — decided in the plan).
- Chunk color is a **flesh/wound tone** derived from the passed enemy `color` blended toward the blood tone (`CONFIG.fx.gore.woundTint` / `CONFIG.fx.blood` palette), so chunks read as *body*, not sparks.
- Chunk radius from a `CONFIG.fx.gore` size range (bigger than today's shard `1.5–4.5`), velocity in the existing spread.

`fxKill` is called on death from `killZombie` (host) and re-derived on clients from the snapshot kill-diff — **unchanged call sites**, so co-op and single-player both get the upgrade with no wiring change.

### 3. Chunks settle as decals

In `sysFx`'s particle-expiry branch (`game/systems/fx.ts:~388`, the `if (p.life <= 0)` block that swap-pops), before removing a particle, if `p.kind === "chunk"` call `pushDecal(state, p.x, p.y, <chunkDecalRadius>, <chunkColor>)`. This drops a small flesh/blood decal at the chunk's resting spot. Decals already: persist, fade over `CONFIG.fx.blood.life` (26–40s), and are capped at `CONFIG.fx.blood.maxDecals` (oldest shifted out on overflow) — so lingering gore accumulates and self-limits with **no new lifecycle code**. `pushDecal` is already the shared entry (`fx.ts:366`).

`pushDecal`'s color param lets chunk-decals use the flesh/blood tone. (If `pushDecal` currently hardcodes via `CONFIG.fx.blood`, the plan passes the chunk color through — it already takes a `color` arg.)

### 4. Pure helper for chunk count (testable)

Mirror the existing `gibsToSpawn` pattern: a pure `chunksToSpawn(intensity, big, fillRatio, …CONFIG…)` returning the flesh-chunk count, unit-tested in `fx.test.ts` alongside the existing `goreIntensity`/`gibsToSpawn` tests. Keeps the count logic honest even though `fx.ts` is coverage-excluded feel code (the tests still run and guard it). The burst/decal *look* is validated by playtest, not tests.

## Config (new `CONFIG.fx.gore` fields)

Conservative, playtest-tuned. Indicative names/defaults (tunable):
- `chunkCount: [number, number]` — flesh-chunk count range at death, lerped by intensity (e.g. `[4, 10]`; scaled up when `big`).
- `chunkSize: [number, number]` — chunk radius range (e.g. `[3, 7]`, larger than today's shard 1.5–4.5).
- `chunkDecalRadius: [number, number]` — resting decal radius range (e.g. `[3, 6]`).
- `chunkFillCap: number` — skip chunks once the particle buffer is this full (reserve headroom for muzzle/spark, mirroring the existing `gibFillCap`).
- (Chunk color derives from the enemy color + `woundTint`/`CONFIG.fx.blood` palette — no new color constant unless the plan finds one is cleaner.)

## Co-op

No wire change. `fxKill` is already re-derived on clients from the prev→next snapshot zombie-id diff (a vanished id → `fxKill` + `Audio.kill`, per `client.ts`). The upgraded chunk burst and the chunk-decals re-derive through that same path on every client. Chunks/decals are `state.particles`/`state.decals` (visual-only, never synced, never in the sim). Single-player is unaffected in structure.

## Testing

- `chunksToSpawn` (and any other pure count/scaling helper) unit-tested in `game/systems/fx.test.ts`, alongside `goreIntensity`/`gibsToSpawn`.
- `fx.ts` stays coverage-excluded (feel code); the pure helpers' tests still run and guard the math.
- The shatter feel, the flesh-chunk look, and the lingering-decal accumulation are validated by the playtest gates below — not unit tests.

## Feel gates (human playtest — the real acceptance)

1. **Meaty kills:** does a kill read as the body *shattering into flesh* (satisfying crowd-sweep payoff), not a generic pop?
2. **Lingering carnage, not noise:** does the ground accumulate readable gore that fades naturally, without visual clutter or a decal-cap that clears it too eagerly/too slowly? (perf: the decal cap holds.)
3. **PEGI-12-acceptable:** does the default still read as stylized, not gratuitous/realistic gore? If any "no" → tune `CONFIG.fx.gore` before proceeding.

## Open questions (resolve during plan/playtest, not blocking)

- Exact `chunk*` tuning (counts, sizes, decal radius, chunk color blend) — set conservative, tune by feel.
- Chunk draw primitive (`hex` vs `rect` vs a mix) — pick whichever reads best as a flesh fragment in playtest.
- Whether the ring/ember counts in `fxKill` should also route through the new count helper or stay as-is (minor; decide in the plan).
