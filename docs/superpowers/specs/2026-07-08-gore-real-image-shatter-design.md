# Gore: Real-Image Death Shatter Design

**Date:** 2026-07-08
**Status:** Brainstormed & approved; **visual approach prototype-validated** (throwaway toy: real-sprite N×N fragmentation reads as gore, not glitch; N=4 good; holds up in gloom); **rubber-duck reviewed and revised** (half-texel sub-cell clamp for atlas bleed, `gridN` as a uniform + `cell+1` pack for mediump safety + `flat` varying, all-or-nothing fragment spawn, complete removal of the abstract chunk code + its tests). Settle-as-decal is **kept in v1** (user decision — a modest add; not split out). **Pending user review, then plan.**
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
- A renderer capability to draw a **sub-cell of a sprite** (per-instance sub-cell + a `gridN` uniform) — the enabling core change.
- Death fragmentation: `fxKill` spawns N×N real-pixel fragment particles from the dying zombie's sprite; they fly out and fade.
- A capped few fragments **settle as darkened real-pixel decals** (the "破片が残る" the user wants — kept in v1 as a modest add on top of the fragment mechanism; the net-position-drift "concern" is a non-issue since decals are cosmetic and never synced, exactly like today's blood-pool decals).
- Keep from the superseded abstract Task 1 (already merged): the `fxKill` `flesh` guard (machines don't bleed) + the deployable-destruction gating; complete-remove the abstract `chunk` visual it added.

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

- **Instance layout:** `FLOATS` 10 → 11. New trailing channel `fragCell` (float). Encoding is kept small (mediump-safe): `0` = whole sprite (every existing write); a fragment cell is `cellY*gridN + cellX + 1` (range 1..N²; ≤17 at N=4, well inside fp16's exact-integer range). **`gridN` is a shader UNIFORM, not packed per-instance** (it's one global constant per frame = `CONFIG.fx.gore.gridN`), which both shrinks the pack and drops a per-instance value. Update: `renderer.ts` `FLOATS = 11`, the single shared `makeLayer()` attribute setup (adding `location=6`, stride is `FLOATS*4` derived — both normal + additive buffers use `makeLayer`, so this is one edit), and the `write()` writer (add index 10; existing calls pass 0).
- **New uniforms:** `u_gridN` (float) and `u_atlasTexel` (float = `1.0 / atlasSizePx`, the half-texel guard needs it — see below). Set once per frame from `CONFIG.fx.gore.gridN` and the packed atlas size (`packed.atlas`, already known at upload).
- **Vertex shader (`instance.vert`):** add `layout(location=6) in float a_frag;` and pass it through as **`flat out float v_frag;`** (flat — it's a per-instance constant, never interpolated).
- **Fragment shader (`instance.frag`) sprite branch (`s >= 16`):** currently `uv = rc.xy + vec2(v_local.x+0.5, 0.5-v_local.y) * rc.zw`. When `v_frag != 0.0`, unpack the cell from `gridN` (uniform) and remap to the sub-cell **with a per-cell half-texel clamp** so a NEAREST fetch can't bleed into the neighbour cell:
  ```glsl
  float cellIdx = v_frag - 1.0;                 // 0..N*N-1
  float cxc = mod(cellIdx, u_gridN);
  float cyc = floor(cellIdx / u_gridN);
  vec2 cellSz = rc.zw / u_gridN;                // sub-rect size in atlas UV
  vec2 base   = rc.xy + vec2(cxc, cyc) * cellSz;
  vec2 uv     = base + vec2(v_local.x + 0.5, 0.5 - v_local.y) * cellSz;
  // Clamp inside the cell by half a texel — the outer sprite rect is already inset by uvRect,
  // but interior cell boundaries are NOT, so guard them here to stop neighbour-cell bleed.
  vec2 h = vec2(u_atlasTexel * 0.5);
  uv = clamp(uv, base + h, base + cellSz - h);
  ```
  (When `v_frag == 0.0`, keep the existing full-rect mapping.) The `t.a < 0.5` discard still applies, so an all-background cell draws nothing. **This half-texel clamp is the fix for a bug the throwaway toy could NOT surface** — the toy sliced a raw PNG, not the packed/inset atlas, so it never exercised interior-cell sampling. Getting this right is the top in-engine visual-verification item.
- **New writer `spriteFragQuad(x, y, w, h, rot, index, cx, cy, r, g, b, a)`** — same as `spriteQuad` but writes `fragCell = cy*gridN + cx + 1` (using the CONFIG `gridN`) and shape `SHAPE.sprite + index`. `spriteQuad` stays and writes `fragCell = 0`.

### 2. Fragments as particles

Files: `game/types.ts`, `game/systems/fx.ts`, `game/game.ts`.

- **`ParticleKind`**: replace the abstract `"chunk"` with `"frag"` (a complete swap — see §4). Extend the `Particle` interface with the fields a fragment needs to draw its sub-cell: `spriteLayer?: number; cellX?: number; cellY?: number;` (plus the existing `settle?: boolean`, used by §3 to mark the first `chunkDecalMax` fragments as settling). `gridN` is NOT per-particle (it's the global uniform). Optional/visual-only; particles are never synced.
- **`fxKill` gains only the sprite layer** (it *already* has `flesh` from Task 1): `fxKill(state, x, y, color, glow, big, flesh = true, spriteLayer = -1)`. When `flesh && spriteLayer >= 0`, it spawns the `N×N` `"frag"` particles (N = `CONFIG.fx.gore.gridN`, default 4): one per cell `(cx, cy)` at that cell's offset from center, flying outward (velocity/rotation/drag from the existing spread), carrying `spriteLayer, cellX=cx, cellY=cy`, with `settle = (spawnIndex < CONFIG.fx.gore.chunkDecalMax)` so the first few will settle (§3). **All-or-nothing guard:** if `state.particles` can't fit all `N*N` fragments under `CONFIG.fx.maxParticles`, spawn NONE (the ring + embers + `bloodPool` still fire, so the kill still reads) — never spawn a partial set, which would render a half-eaten sprite. Ring + embers always; `bloodPool` still `flesh`-gated. `spriteLayer < 0` (atlas not ready — shouldn't happen post-load-gate) → no fragments, no crash.
- **Draw (`game/game.ts` NORMAL particle loop, ~line 571):** add a `"frag"` case → `R.spriteFragQuad(pt.x, pt.y, cellSize, cellSize, pt.rot, pt.spriteLayer, pt.cellX, pt.cellY, tint…, a)`. Fragment on-screen size = the zombie's draw size / `gridN`. Tint white (real pixels), alpha fades with `life/maxLife`. NORMAL (non-additive) loop — textured sprite, not glow.
- **Call sites (four `fxKill` calls total):** the two **zombie-death** sites pass the sprite layer — `bullets.ts:86` (`killZombie`; `R.spriteLayer(ENEMY_TYPES[z.type].sprite)`) and `client.ts:249` (kill re-derive; `client.ts:247` already resolved `const t = ENEMY_TYPES[z.type]`, so the layer is one cheap call). The two **machine-destruction** sites stay `flesh=false` (no fragments) — `deployables.ts:62` (host) and `client.ts:341` (client). All four already pass `flesh` explicitly from Task 1.

### 3. Fragments settle as real-pixel decals

Files: `game/types.ts` (`Decal`), `game/systems/fx.ts` (`sysFx` expiry + a `pushFragDecal`), `game/game.ts` (decal draw).

- Extend `Decal` with optional `spriteLayer?: number; cellX?: number; cellY?: number;` (a "fragment decal"; a plain blood decal leaves them undefined). In the `sysFx` particle-expiry branch, a `"frag"` particle with `settle` calls `pushFragDecal(state, x, y, rot, spriteLayer, cellX, cellY)` at its resting position (a sibling of the existing `pushDecal`, sharing the `maxDecals` FIFO cap).
- **Decal draw (`game/game.ts` decal loop, currently `R.circle` blobs):** branch — a fragment-decal (has `spriteLayer`) draws via `R.spriteFragQuad` **darkened** (`CONFIG.fx.gore.fragDecalDarken` brightness) so it reads as a settled body piece staining the ground; a plain blood decal keeps `R.circle`. Fades over the existing decal life.
- **Budget:** capped per kill via `chunkDecalMax` (e.g. 3), so a kill adds ~3 fragment-decals on top of the blood pool's ~5. Shares `CONFIG.fx.blood.maxDecals` (480, FIFO). The net-position-drift is a non-issue — decals are cosmetic, never synced, and blood pools already differ per client harmlessly. Fallback if a dense night still evicts pools: raise `maxDecals` or give fragment-decals a shorter life (Open questions).

### 4. Reuse vs replace (from the superseded abstract Task 1)

Task 1 (commit on `feat/gore-death-shatter`) is **built on**, not reverted:
- **Keep:** `fxKill`'s `flesh` param + the two `flesh=false` machine call sites; the `CONFIG.fx.gore` scaffold; the `settle` flag; the deployable-doesn't-bleed behavior.
- **Completely remove** (no dual `frag`/`chunk` path — CLAUDE.md zero-special-case-debt): the `"chunk"` `ParticleKind`, the `R.hex` chunk draw branch in `game.ts`, the `deathChunkCount` function **and its `fx.test.ts` tests**, and the `chunkCount`/`chunkSize` CONFIG fields. (Leaving them would rot as dead code / failing tests.)

## Config (`CONFIG.fx.gore`)

Keep from Task 1: `chunkDecalMax` (max settling fragments per kill, e.g. 3). **Remove** `chunkCount`, `chunkSize` (superseded — fragment count is fixed N², cell size derives from sprite draw size / `gridN`). New:
- `gridN: number` — fragmentation grid (default `4` → 16 pieces). Also drives the `u_gridN` shader uniform. Tunable per playtest.
- `fragSpeed: [number, number]` — outward fly speed range.
- `fragLife: [number, number]` — fragment lifetime (s) before it fades.
- `fragDecalDarken: number` — brightness multiplier for a settled fragment-decal (0..1), so it reads as a dried stain.

## Co-op

No wire change. `fxKill` is re-derived on clients from the snapshot zombie-id kill-diff; the sprite layer is derived from the synced `z.type` (`ENEMY_TYPES[type].sprite` → `R.spriteLayer`), so clients fragment the correct sprite. The stalker is excluded from that diff (separate snapshot block) → never fragments spuriously. Machine destruction passes `flesh=false` on both host and client. Fragments and their settle-decals are `state.particles`/`state.decals` (visual-only, never synced). Differing fragment/decal positions host-vs-client are fine (cosmetic — blood pools already behave this way).

## Testing

- **Pure + unit-tested:** `fragCell` pack (`cy*gridN + cx + 1`) and its unpack (mirroring the shader), round-trip; and the per-cell world-offset geometry (`cellOffset(cx, cy, gridN, drawSize)` → offset from sprite center). Small exported pure helpers (e.g. `packFragCell`/`unpackFragCell`/`cellOffset` in `fx.ts` or a renderer helper), mirroring the `goreIntensity`/`gibsToSpawn` precedent.
- **Remove** the superseded `deathChunkCount` `describe` block and its `chunkCount`/`chunkSize` references in `game/systems/fx.test.ts` (they reference config this spec deletes → they WILL fail on pre-push otherwise). Replace with the pack/offset tests.
- `fx.ts` stays coverage-excluded; `renderer.ts`/shaders are already coverage-excluded (feel). The shader sub-cell remap + the shatter *look* are playtest-validated. **The half-texel clamp (§1) is the #1 in-engine visual-verification item** — the toy could not surface atlas-inset bleed.

## Feel gates (human playtest — the real acceptance)

1. **Meaty, real kills:** in-engine, does a kill read as the body shattering into real pieces (matching the toy), satisfying the crowd-sweep — including in the gloom? **No half-eaten / bleeding-edge sprites** (confirms the half-texel clamp + all-or-nothing guard).
2. **Lingering, not noise + no perf hit:** a few real-pixel fragment-stains settle (on top of the existing blood pools) and read as accumulating carnage that fades naturally. On a dense horde night: no perf hitch, no clutter, and blood pools aren't visibly evicted by fragment-decals (the shared `maxDecals` cap holds; the all-or-nothing guard means kills either fully shatter or skip cleanly).
3. **PEGI-12-acceptable:** does the default read as stylized, not gratuitous? If any "no" → tune `CONFIG.fx.gore` (gridN, speeds) before proceeding.

## Open questions (resolve during plan/playtest, not blocking)

- Exact tuning (`gridN` 3 vs 4, `fragSpeed`/`fragLife`, `fragDecalDarken`, `chunkDecalMax`) — conservative defaults, tune by feel. Toy suggested N=4 is good.
- Fragment tint: pure white (raw pixels) vs slight wound/blood darkening — pick what reads best in-cone and in gloom.
- Perf ceiling: if 16 frags/kill × dense horde stresses the particle cap, lower `gridN` or shorten `fragLife`. The all-or-nothing guard already prevents partial (half-eaten) shatters; a kill that can't fit simply keeps ring/embers/blood. `log`/note if kills are frequently skipping fragments rather than silently degrading.
- Decal-budget fallback (shared `maxDecals`): raise the cap or give fragment-decals a shorter life than blood pools if a heavy night visibly evicts pools.
- Git: keep Task 1's abstract-chunk commit in history (build on it) vs squash when this ships — a plan/PR-hygiene call, not a design one.
