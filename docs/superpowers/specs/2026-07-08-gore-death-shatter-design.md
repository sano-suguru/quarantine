# Gore: Death Shatter + Lingering Blood-Flesh Design

> **SUPERSEDED (2026-07-08)** by `2026-07-08-gore-real-image-shatter-design.md`. This *abstract* hex-chunk approach was built (Task 1 on `feat/gore-death-shatter`) and playtested as too subtle / not the real image; replaced by real-sprite fragmentation. Kept for history. The `fxKill` `flesh` guard + deployable gating from this spec's Task 1 are retained by the successor.

**Date:** 2026-07-08
**Status:** Brainstormed & approved (option A, "all-recommended"); **rubber-duck reviewed and revised** (named the correct draw-dispatch loop, reuse the existing gib mechanism instead of a parallel counter, `flesh` guard so deployable destruction doesn't bleed, capped chunk-decals per kill so blood pools aren't evicted); **pending user review**, then plan.
**Kind:** Feel/juice upgrade to the existing gore FX. Sharpens the crowd-sweep satisfaction (SAS3 pillar) without touching the renderer, shaders, or art.
**Depends on:** existing `game/systems/fx.ts` (`goreIntensity`, `gibsToSpawn`, `fxKill`, `fxImpact`, `bloodPool`/`pushDecal`), `CONFIG.fx.gore`/`CONFIG.fx.blood`, the particle + decal systems in `sysFx`.

## Problem

Killing a zombie today emits an **abstract** burst — a shockwave ring plus small `"shard"` particles and embers (`fxKill` in `game/systems/fx.ts`), which expire and vanish. It reads as a generic "pop," not as a body coming apart, and it leaves nothing behind. The crowd-sweep — the game's proven fun — lacks the visceral payoff of bodies bursting and the battlefield accumulating carnage.

## Goal

On death, a zombie's **body visibly shatters into flesh chunks** that fly out and **settle as lingering decals**, so kills feel meaty and the ground fills with the evidence of a hard-fought night. Stylized (pixel + top-down + fantasy zombies) so it stays within PEGI 12 for CrazyGames, and fully tunable behind `CONFIG.fx.gore` so intensity is a data dial, never a rewrite.

## Scope

**In scope:**
- Upgrade `fxKill`'s abstract shard burst into beefier, flesh-colored **body chunks** (a new `ParticleKind: "chunk"`), count/size scaled by the existing `goreIntensity` + the `big` flag.
- Chunks fly with physics and **settle as decals** on expiry (extends the existing decal system), capped to a few per kill so lingering gore accumulates without evicting blood pools.
- **Reuse** the existing gib mechanism (`gibsToSpawn` + `CONFIG.fx.gore.gibCount`/`gibThreshold`/`gibFillCap`) for the death burst count; add only the genuinely new death-specific `CONFIG.fx.gore` fields (chunk size, chunk-decal radius + settle cap).
- A `flesh` guard on `fxKill` so non-organic deaths (turret/barricade destruction) don't spray flesh + blood.

**Explicitly deferred (NOT in this spec):**
- **Procedural living-body carving** (body visibly loses parts *while alive*, per-hit). This is the heavier renderer/shader path (instance-layout + shader change); revisit only if death-shatter alone doesn't satisfy the "身体がちぎれる" craving.
- **Player-facing low-gore toggle / settings UI.** Start with a conservative default; because `CONFIG.fx.gore` is a build-time constant, a CrazyGames QA flag is a config-edit-and-rebuild (not runtime, but still a value change, not a rewrite). A player toggle is a separate accessibility/rating concern for later.
- **`fxImpact` (non-lethal hits) is unchanged.** Note it already spawns transient flesh gibs via `gibsToSpawn` as `"shard"` — those stay transient (do NOT settle). Only the *death* burst becomes settling `"chunk"`s. Promoting hit-gibs to settling chunks is a deferred option (it would raise decal load; see §3).

## Non-goals / constraints (scope fence)

- **No renderer / shader / instance-layout change, no new art.** Everything rides the existing particle + decal instanced draw.
- **No sim-state change, net-agnostic, single-player-safe.** Chunks/decals are visual-only (`state.particles` / `state.decals`), never affect the sim. Co-op clients already re-derive `fxKill` from the snapshot zombie-id kill-diff (`client.ts`) with matching `color`/`glow`/`big` args, and the stalker is excluded from that diff (separate snapshot block), so the new chunks + chunk-decals re-derive on zombie deaths on clients for free — **no snapshot/wire change, no new synced state.**
- **`fxKill` is shared with deployable destruction.** It is also called for turret/barricade destruction (`deployables.ts`, and its client re-derivation) — a *machine* must not spray flesh chunks or a blood pool. The `flesh` param (§2) gates the organic FX off for those call sites.
- **PEGI 12 / stylized.** Default intensity stays non-realistic (blocky flesh chunks, muted/dark blood consistent with the current `CONFIG.fx.blood` palette). Tunable down if QA flags.
- **Tunable, data-driven.** All new magic numbers live in `CONFIG.fx.gore`; no constants baked into `fx.ts` logic.

## Architecture

All changes are in `game/systems/fx.ts` + `game/config.ts` + `game/types.ts` (the `ParticleKind` union) + `game/systems/fx.test.ts` (pure-helper tests).

### 1. New `ParticleKind: "chunk"`

Add `"chunk"` to the `ParticleKind` union (`game/types.ts:302`, currently `"spark" | "shard" | "ring" | "smoke"`). A chunk is a flesh-colored body fragment: it flies with drag (same physics path as `"shard"` in the `sysFx` update loop — the existing `else` branch that applies `Math.exp(-drag*dt)` already handles any non-`ring` kind, so chunks need no new physics), and it draws as a small solid shape.

**Draw:** chunks render as a small solid, slightly-rotated shape — recommend `hex` (`R.hex(x, y, rad, rot, …)`, which reads as a flesh lump; `"shard"` uses a thin `R.rect`) — in the chunk's color, alpha fading with `life/maxLife`. **There are TWO particle dispatch loops in `game.ts`: the NORMAL/non-additive loop (where `"shard"`→`R.rect`, `"smoke"`→`R.circle`) and the ADDITIVE loop (where `"spark"`→`R.glow`, `"ring"`→`R.add`). The `chunk` case goes in the NORMAL loop, next to `"shard"` — it is flesh, not glow.** Both loops are `if/else` chains (not exhaustive `switch`), so adding `"chunk"` to the union does NOT produce a type error if the draw case is missed — the plan must add the case explicitly.

### 2. `fxKill` upgrade — the shatter

`fxKill` gains a `flesh` parameter: **`fxKill(state, x, y, color, glow, big, flesh = true)`**. When `flesh` is true (zombie deaths) it keeps its shockwave ring + embers and its body-fragment burst becomes flesh **chunks**; when false (turret/barricade destruction) it emits only the ring + embers (no flesh chunks, no `bloodPool`) so a machine doesn't bleed. The flesh burst:
- **Count reuses the existing gib mechanism** — `gibsToSpawn(intensity, fillRatio, CONFIG.fx.gore.gibThreshold, gibCount[0], gibCount[1], gibFillCap)` — rather than a parallel counter. The current hardcoded `n = big ? 22 : 12` flesh-fragment split is replaced by this (the ring/ember counts stay as-is). If the plan finds `gibsToSpawn` genuinely can't express the death count (e.g. a `big` multiplier), it may extend `gibsToSpawn` — but must NOT create a duplicate `chunksToSpawn` without justifying why the existing helper is insufficient.
- Chunk color is a **flesh/wound tone** derived from the passed enemy `color` blended toward the blood tone (`CONFIG.fx.gore.woundTint` / `CONFIG.fx.blood` palette), so chunks read as *body*, not sparks.
- Chunk radius from a new `CONFIG.fx.gore.chunkSize` range (bigger than today's shard `1.5–4.5`), velocity in the existing spread.

`fxKill(...flesh=true)` is called on zombie death from `killZombie` (host) and re-derived on clients from the snapshot kill-diff; the deployable-destruction call sites (`deployables.ts` + its client re-derivation) pass `flesh=false`. Zombie call sites are otherwise unchanged, so co-op and single-player both get the upgrade with no wiring change.

### 3. Chunks settle as decals

In `sysFx`'s particle-expiry branch (`game/systems/fx.ts:~388`, the `if (p.life <= 0)` block that swap-pops), before removing a particle — **specifically before the `P[i] = P[last]` swap assignment, while `p` still points to the expiring particle** — if `p.kind === "chunk"` call `pushDecal(state, p.x, p.y, <chunkDecalRadius>, <chunkColor>)`. `pushDecal` touches only `state.decals` (not the particle array `P`), so it does not interfere with the swap-pop. `pushDecal` already takes a `color` arg (`fx.ts:366`), so chunk-decals use the flesh/blood tone with no draw-branch change (they render through the existing decal pass at `game.ts` with `CONFIG.fx.blood.maxAlpha`/`life` fade).

**Decal budget (do NOT settle every chunk).** Decals share one capped array (`CONFIG.fx.blood.maxDecals`, oldest `shift()`ed out). A `bloodPool` already spends ~5 decals/kill (1 center + 4 satellites); settling *every* chunk (many per kill) would blow the cap on a heavy horde night and evict blood pools. So **only a small capped number of chunks settle per kill** (new `CONFIG.fx.gore.chunkDecalMax`, e.g. 2–3) — the rest fly and fade without settling. This bounds lingering-decal load to a few per kill and looks better (not every speck stains). The shared cap staying healthy under a dense night is a **playtest gate** (feel gate #2); if it still evicts pools, the fallback is a raised `maxDecals` or a shorter chunk-decal life (decided in playtest, noted in §Open questions).

### 4. Pure helper for chunk count (testable)

**Default to reusing `gibsToSpawn` for the death chunk count** (it already lerps count by intensity with a fill cap — exactly what the death burst needs). Only if the death burst genuinely needs something `gibsToSpawn` can't express (e.g. a `big`-enemy multiplier) does the plan add a thin wrapper or extend `gibsToSpawn` — with justification, not a duplicate `chunksToSpawn`. Whatever pure count logic is added or changed is unit-tested in `fx.test.ts` alongside `goreIntensity`/`gibsToSpawn`. The burst/decal *look* is validated by playtest, not tests.

## Config (`CONFIG.fx.gore`)

**Reuse existing** for the death burst count/throttle: `gibCount`, `gibThreshold`, `gibFillCap` (already present, used today by `fxImpact`'s gibs). **New fields** (conservative, playtest-tuned; indicative defaults):
- `chunkSize: [number, number]` — death-chunk radius range (e.g. `[3, 7]`, larger than today's shard 1.5–4.5).
- `chunkDecalRadius: [number, number]` — resting decal radius range (e.g. `[3, 6]`).
- `chunkDecalMax: number` — max chunks that settle into decals **per kill** (e.g. `3`) — bounds lingering-decal load so blood pools aren't evicted (see §3).
- (Chunk color derives from the enemy color + `woundTint`/`CONFIG.fx.blood` palette — no new color constant unless the plan finds one cleaner.)

## Co-op

No wire change. `fxKill` is already re-derived on clients from the prev→next snapshot zombie-id diff (a vanished id → `fxKill(..., flesh=true)` + `Audio.kill`, per `client.ts`) with matching `color`/`glow`/`big` args, so chunks are flesh-toned and correctly sized on clients. The stalker is excluded from that diff (it's a separate snapshot block), so it never spuriously spawns chunks. The deployable-destruction re-derivation on clients passes `flesh=false` (matching the host), so destroyed machines don't bleed on any peer. Chunks/decals are `state.particles`/`state.decals` (visual-only, never synced, never in the sim). Single-player is unaffected in structure.

## Testing

- Any pure count/scaling helper added or changed for the death burst (ideally just reusing `gibsToSpawn`) is unit-tested in `game/systems/fx.test.ts`, alongside `goreIntensity`/`gibsToSpawn`. If `gibsToSpawn` is reused unchanged, its existing tests already cover the count; no new test needed there.
- `fx.ts` stays coverage-excluded (feel code); the pure helpers' tests still run and guard the math.
- The shatter feel, the flesh-chunk look, and the lingering-decal accumulation are validated by the playtest gates below — not unit tests.

## Feel gates (human playtest — the real acceptance)

1. **Meaty kills:** does a kill read as the body *shattering into flesh* (satisfying crowd-sweep payoff), not a generic pop?
2. **Lingering carnage, not noise:** does the ground accumulate readable gore that fades naturally, without visual clutter or a decal-cap that clears it too eagerly/too slowly? (perf: the decal cap holds.)
3. **PEGI-12-acceptable:** does the default still read as stylized, not gratuitous/realistic gore? If any "no" → tune `CONFIG.fx.gore` before proceeding.

## Open questions (resolve during plan/playtest, not blocking)

- Exact `chunk*` tuning (size, decal radius, `chunkDecalMax`, chunk color blend) — set conservative, tune by feel.
- Chunk draw primitive (`hex` recommended; playtest confirms it reads as flesh, not a UI shape).
- Decal-budget fallback if a dense night still evicts blood pools despite `chunkDecalMax`: raise `CONFIG.fx.blood.maxDecals`, or give chunk-decals a shorter life than blood pools. Decide by playtest (feel gate #2).
- Whether hit-gibs (`fxImpact`) should later also settle as chunks (deferred; would raise decal load).
