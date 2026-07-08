# Gore: Real-Image Death Shatter Design

**Date:** 2026-07-08
**Status:** Brainstormed & approved; **visual approach prototype-validated** (throwaway toy: real-sprite N×N fragmentation reads as gore, not glitch; N=4 good; holds up in gloom); **pending rubber-duck review**, then user review, then plan.
**Kind:** Feel/juice core-mechanic — the crowd-sweep payoff. Touches the renderer core (instance layout + shaders), so it is *not* a light FX tweak.
**Supersedes:** `docs/superpowers/specs/2026-07-08-gore-death-shatter-design.md` (the *abstract* hex-chunk approach). That approach was built (Task 1 on `feat/gore-death-shatter`), playtested, and found too subtle / not the real image — the user wants the actual sprite to break apart. This spec replaces the abstract chunk visual with real-image fragmentation.

## Problem

The abstract flesh-chunk death burst (small dark-red `R.hex` particles) was barely visible in the gloom and — the deeper issue — is *not* the zombie's actual body coming apart, just colored shapes. Kills don't read as meaty; the crowd-sweep lacks its visceral payoff.

## Goal

On death, a zombie's **actual sprite fragments into flying pieces that carry real body pixels**, then a few pieces **settle as lingering (darkened, real-pixel) decals**. Meaty, legible kills + accumulating carnage. Stylized (pixel + top-down + fantasy zombies) → PEGI-12-safe for CrazyGames; tunable behind `CONFIG.fx.gore`.

## Prototype validation (already done)

A throwaway HTML toy sliced a real zombie PNG into N×N pieces and exploded them on a gloom-dark background. Findings the user confirmed: **real-image fragmentation reads as gore (not a glitch)**; **N=4 (4×4=16 pieces) works**; **it holds up with the beam off (gloom)**. This de-risked the renderer investment before touching the core.

## Scope

**In scope:**
- A renderer capability to draw a **sub-cell of a sprite** (per-instance UV sub-rect) — the enabling core change.
- Death fragmentation: `fxKill` spawns N×N real-pixel fragment particles from the dying zombie's sprite.
- A capped few fragments **settle as darkened real-pixel decals**.
- Keep from the superseded abstract work: the `fxKill` `flesh` guard (machines don't bleed) + the deployable-destruction gating.

**Deferred (NOT in this spec):**
- Procedural living-body carving (damage while alive).
- Player-facing low-gore toggle (start conservative; `CONFIG` is the dial; rebuild-and-resubmit if CrazyGames QA flags).
- Per-`big`-enemy fragment-count differences (uniform N in v1; tune later).

## Non-goals / constraints (scope fence)

- **The core change is bounded: +1 instance float.** Instance layout goes `FLOATS 10 → 11` (a new `fragCell` channel); `spriteQuad` is byte-unchanged (writes `fragCell = 0` = whole sprite). No other renderer semantics change. This is the CLAUDE.md "changing instance layout means updating both the shader attributes and the writer" case — done deliberately and minimally.
- **No new sprite atlas slots.** Fragments reuse the parent sprite's atlas rect + a per-instance sub-cell, so `MAX_SPRITES = 32` is not pressured (this is why the "pre-slice into fragment sprites" alternative was rejected — 3 enemy types × 4×4 = 48 > 32, and it wouldn't scale to more enemy types).
- **No sim-state change, net-agnostic, single-player-safe.** Fragments/decals are visual-only (`state.particles` / `state.decals`), never synced, never affect the sim. Co-op clients re-derive via the existing `fxKill` kill-diff; the sprite layer is derived from the synced `z.type`, so **no snapshot/wire change**.
- **PEGI 12 / stylized, data-driven.** Conservative defaults; all new magic numbers in `CONFIG.fx.gore`.

## Architecture

### 1. Renderer: per-instance sprite sub-cell (the enabling change)

Files: `game/engine/renderer.ts`, `game/engine/shaders/instance.vert`, `game/engine/shaders/instance.frag`.

- **Instance layout:** `FLOATS` 10 → 11. New trailing channel `fragCell` (float). `0` means "whole sprite" (all existing writes); non-zero packs the sub-cell as `gridN*256 + cellY*16 + cellX` (supports N and cell indices up to 15 — float-exact). Update the interleaved-attribute setup (`renderer.ts` `stride = FLOATS*4`, the `vertexAttribPointer`/`vertexAttribDivisor` block) and the `write()` writer (it currently writes indices 0–9; add index 10).
- **Vertex shader (`instance.vert`):** add `layout(location=6) in float a_frag;` and pass it through: `out float v_frag; … v_frag = a_frag;`.
- **Fragment shader (`instance.frag`) sprite branch (`s >= 16`):** currently `uv = rc.xy + vec2(v_local.x+0.5, 0.5-v_local.y) * rc.zw`. When `v_frag != 0.0`, unpack `N`, `cx`, `cy` and remap to the sub-cell:
  ```glsl
  // gridN*256 + cellY*16 + cellX
  float fc = v_frag;
  float N = floor(fc / 256.0);
  float cyc = floor((fc - N*256.0) / 16.0);
  float cxc = fc - N*256.0 - cyc*16.0;
  vec2 cell = rc.zw / N;                                  // sub-rect size in atlas UV
  vec2 uv = rc.xy + vec2(cxc + (v_local.x+0.5), cyc + (0.5 - v_local.y)) * cell;
  ```
  (When `v_frag == 0.0`, keep the existing full-rect mapping.) The `t.a < 0.5` discard still applies, so transparent cells (e.g. a corner cell that's all background) simply draw nothing.
- **New writer `spriteFragQuad(x, y, w, h, rot, index, gridN, cx, cy, r, g, b, a)`** — same as `spriteQuad` but writes `fragCell = gridN*256 + cy*16 + cx` and shape `SHAPE.sprite + index`. `spriteQuad` stays and writes `fragCell = 0`.

### 2. Fragments as particles

Files: `game/types.ts`, `game/systems/fx.ts`, `game/game.ts`.

- **`ParticleKind`**: replace the abstract `"chunk"` with `"frag"`. Extend the `Particle` interface with the fields a fragment needs to draw its sub-cell: `spriteLayer?: number; gridN?: number; cellX?: number; cellY?: number;` (plus the existing `settle?: boolean`). These are optional/visual-only; particles are never synced.
- **`fxKill` gains the sprite layer** so it knows which sprite to fragment: `fxKill(state, x, y, color, glow, big, flesh = true, spriteLayer = -1)`. When `flesh` and `spriteLayer >= 0`, it spawns `N×N` `"frag"` particles (N = `CONFIG.fx.gore.gridN`, default 4): for each cell `(cx, cy)`, a particle at that cell's offset from center, flying outward (velocity from the existing spread + rotation + drag), carrying `spriteLayer, gridN=N, cellX=cx, cellY=cy`, with `settle = (index < CONFIG.fx.gore.chunkDecalMax)`. Ring + embers stay; `bloodPool` still `flesh`-gated. If `spriteLayer < 0` (no sprite — shouldn't happen for zombies) it falls back to no fragments (ring/embers only) rather than crashing.
- **Draw (`game/game.ts` NORMAL particle loop, ~line 571):** add a `"frag"` case → `R.spriteFragQuad(pt.x, pt.y, cellSize, cellSize, pt.rot, pt.spriteLayer, pt.gridN, pt.cellX, pt.cellY, tint..., a)`. Fragment on-screen size = the zombie's draw size / N. Tint white (real pixels) with the wound/blood darkening consistent with the live-body tint; alpha fades with `life/maxLife`. NORMAL (non-additive) loop — it's a textured sprite, not glow.
- **Call sites:** `bullets.ts:killZombie` passes the zombie's sprite layer (`R.spriteLayer(ENEMY_TYPES[z.type].sprite)` or the layer already resolved at draw — the plan picks the cleanest source). `client.ts:249` (kill re-derive) passes the same, derived from `z.type`. The two deployable sites stay `flesh=false` (no sprite arg needed → fragments skipped).

### 3. Fragments settle as real-pixel decals

Files: `game/types.ts` (`Decal`), `game/systems/fx.ts` (`sysFx` expiry + `pushDecal`/a frag variant), `game/game.ts` (decal draw).

- Extend `Decal` with optional `spriteLayer?, gridN?, cellX?, cellY?` (a "fragment decal"). In the `sysFx` particle-expiry branch, a `"frag"` particle with `settle` pushes a fragment-decal at its resting position (a new `pushFragDecal` or `pushDecal` overload carrying the sub-cell).
- **Decal draw:** where decals render (currently `R.circle` blobs), a fragment-decal draws via `R.spriteFragQuad` **darkened** (a low brightness/desaturated tint) so it reads as a settled body piece staining the ground; fades over the existing decal life. Blood-pool decals are unchanged.
- Capped per kill via the reused `chunkDecalMax`; shares the `CONFIG.fx.blood.maxDecals` cap (fallback if a dense night evicts pools: raise the cap or shorten frag-decal life — playtest decides, per Open questions).

### 4. Reuse vs replace (from the superseded abstract Task 1)

Task 1 (commit on `feat/gore-death-shatter`) is **built on**, not reverted:
- **Keep:** `fxKill`'s `flesh` param + the two deployable `flesh=false` call sites; the `CONFIG.fx.gore` scaffold; the `settle` flag concept; the deployable-doesn't-bleed behavior.
- **Replace:** the abstract `"chunk"` kind → `"frag"`; the `R.hex` chunk draw → `spriteFragQuad`; `deathChunkCount` (random count) → fixed N×N cells; `chunkSize` config (irrelevant — cell size = sprite/N).

## Config (`CONFIG.fx.gore`)

Keep from Task 1: `chunkDecalMax` (max settling fragments per kill, e.g. 3). New / changed:
- `gridN: number` — fragmentation grid (default `4` → 16 pieces). Tunable per playtest.
- `fragSpeed: [number, number]` — outward fly speed range.
- `fragLife: [number, number]` — fragment lifetime (s) before it fades / settles.
- `fragDecalDarken: number` — how much a settled fragment-decal is darkened (0..1).
- Remove `chunkSize` (superseded — cell size derives from the sprite draw size / `gridN`).

## Co-op

No wire change. `fxKill` is re-derived on clients from the snapshot zombie-id kill-diff; the sprite layer is derived from the synced `z.type` (`ENEMY_TYPES[type].sprite` → `R.spriteLayer`), so clients fragment the correct sprite. The stalker is excluded from that diff (separate snapshot block) → never fragments spuriously. Deployable destruction passes `flesh=false` on both host and client. Fragments/decals are `state.particles`/`state.decals` (visual-only, never synced). Differing fragment positions host-vs-client are fine (cosmetic).

## Testing

- **Pure + unit-tested:** the `fragCell` pack (`gridN*256 + cy*16 + cx`) and its unpack (mirroring the shader's arithmetic) — round-trip test; and the per-cell world-offset geometry (cell `(cx,cy)` → offset from sprite center at grid N). Put these pure helpers where they can be tested (e.g. a small exported `packFragCell`/`unpackFragCell` and `cellOffset` in `fx.ts` or a renderer helper module), mirroring the `goreIntensity`/`gibsToSpawn` precedent.
- `fx.ts` stays coverage-excluded; `renderer.ts`/shaders are already coverage-excluded (feel). The shader remap + the shatter/settle *look* are validated by the playtest gates (the toy already validated the visual approach).

## Feel gates (human playtest — the real acceptance)

1. **Meaty, real kills:** in-engine, does a kill read as the body shattering into real pieces (matching the toy), satisfying the crowd-sweep — including in the gloom?
2. **Lingering carnage, not noise:** do a few real-pixel fragments settle and stain the ground readably, fading naturally, without clutter — and **no perf hitch** on a dense horde night (particle count under cap; instanced draw holds)?
3. **PEGI-12-acceptable:** does the default read as stylized, not gratuitous? If any "no" → tune `CONFIG.fx.gore` (gridN, speeds, decal count/darken) before proceeding.

## Open questions (resolve during plan/playtest, not blocking)

- Exact tuning (`gridN` 3 vs 4, `fragSpeed`/`fragLife`, `fragDecalDarken`, how many settle) — conservative defaults, tune by feel. Toy suggested N=4 is good.
- Fragment tint: pure white (raw pixels) vs slight wound/blood darkening — pick what reads best in-cone and in gloom.
- Perf ceiling: if 16 frags/kill × dense horde stresses the particle cap, either lower `gridN`, shorten `fragLife`, or throttle fragment spawn when the buffer is near full (a partial shatter) — decide by playtest; `log`/note any cap-driven truncation rather than silently dropping.
- Decal-budget fallback (shared `maxDecals`): raise the cap or give fragment-decals a shorter life if blood pools get evicted on a heavy night.
- Git: whether to keep Task 1's abstract-chunk commit in history (build on it) or squash it away when this ships — a plan/PR-hygiene call, not a design one.
