# Gore: Death Shatter + Lingering Blood-Flesh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On death, a zombie's body shatters into flesh chunks that fly out and settle as lingering decals — meaty kills + accumulating carnage — without touching the renderer core, shaders, or art.

**Architecture:** A new `ParticleKind: "chunk"` (drawn in the existing NORMAL particle loop as a `hex`), spawned by an upgraded `fxKill` that gains a `flesh` guard (so turret/barricade destruction doesn't bleed). Chunk count reuses the existing gib helper (`gibsToSpawn`) via a thin `deathChunkCount` wrapper with death-specific `CONFIG.fx.gore` values. A capped few chunks per kill settle into the existing decal system on particle expiry. Co-op re-derives for free through the existing `fxKill` kill-diff.

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess), Vitest, WebGL2 instanced renderer (`R.hex`), `CONFIG` tuning tree, Biome.

**Spec:** `docs/superpowers/specs/2026-07-08-gore-death-shatter-design.md`

## Global Constraints

Every task's requirements implicitly include these (from the spec):
- **Render/audio-only, no sim change.** Chunks/decals live in `state.particles`/`state.decals` (visual-only, never synced, never affect the sim). No renderer/shader/instance-layout change, no new art.
- **Co-op / single-player safe.** `fxKill` is already re-derived on clients from the snapshot zombie-id kill-diff with matching `color`/`glow`/`big`; the stalker is excluded from that diff. No snapshot/wire change, no new synced state. Particles are client-local — differing chunk positions between host/client are fine (cosmetic).
- **`fxKill` is shared with deployable destruction.** Turret/barricade destruction (`deployables.ts` + its client re-derivation) must pass `flesh=false` so a machine emits no flesh chunks and no blood pool.
- **Chunk goes in the NORMAL (non-additive) particle draw loop** (`game/game.ts`, where `"shard"`→`R.rect`), NOT the additive loop — it's flesh, not glow. The loops are `if/else` chains, so a missed case is NOT a type error.
- **PEGI 12 / stylized, data-driven.** All new magic numbers in `CONFIG.fx.gore`; conservative defaults, playtest-tuned. No constants baked into `fx.ts` logic.
- **Reuse, don't duplicate.** The chunk count reuses `gibsToSpawn` (the helper); death-specific *values* (`chunkCount`) are justified because a death shatter needs a bigger burst than a hit gib.

---

### Task 1: The shatter — `"chunk"` kind, `fxKill` flesh guard + chunk burst, draw, deployable gating

Kills spawn visible flesh chunks; machines don't bleed. No settling yet (that's Task 2). Independently playtestable (meaty kills; turret destruction stays non-organic) and unit-tested (`deathChunkCount`).

**Files:**
- Modify: `game/types.ts` (add `"chunk"` to `ParticleKind` at `game/types.ts:302`; add `settle?: boolean` to the `Particle` interface)
- Modify: `game/config.ts` (add `chunkCount`, `chunkSize`, `chunkDecalMax` to the `fx.gore` block)
- Modify: `game/systems/fx.ts` (`spawn()` gains a `settle` param; new exported `deathChunkCount`; `fxKill` gains `flesh` param + chunk burst)
- Modify: `game/game.ts` (add the `"chunk"` draw case to the NORMAL particle loop at `game/game.ts:571-577`)
- Modify: `game/systems/deployables.ts:62` and `game/net/client.ts:341` (pass `flesh=false` at the two deployable-destruction call sites)
- Test: `game/systems/fx.test.ts` (test `deathChunkCount`)

**Interfaces:**
- Consumes: `gibsToSpawn(intensity, fillRatio, threshold, countMin, countMax, fillCap)` (existing, `fx.ts:33`); `spawn(state, x, y, vx, vy, life, r, color, kind, drag)` (existing private, `fx.ts:46`); `rand`, `lerp` (existing in `fx.ts`); `R.hex(x, y, rad, rot, r, g, b, a)` (existing, `renderer.ts:474`); `CONFIG.fx.gore.woundTint`/`gibFillCap`/`maxParticles`.
- Produces: `export function deathChunkCount(fill: number): number`; `fxKill(state, x, y, color, glow, big, flesh = true)`; `ParticleKind` now includes `"chunk"`; `Particle.settle?: boolean`.

- [ ] **Step 1: Add `"chunk"` to `ParticleKind` and `settle` to `Particle`**

In `game/types.ts`, line 302:

```ts
export type ParticleKind = "spark" | "shard" | "ring" | "smoke" | "chunk";
```

In the `Particle` interface (same file — it has `x, y, vx, vy, life, maxLife, r, rot, color, kind, drag`), add:

```ts
  /** flesh chunk that settles into a decal on expiry (set by fxKill for the first chunkDecalMax chunks) */
  settle?: boolean;
```

- [ ] **Step 2: Add the CONFIG fields**

In `game/config.ts`, inside the `fx.gore` block (after `woundDarken`, the last field before the `gore` block closes — around `game/config.ts:90`), add:

```ts
      chunkCount: [8, 14] as [number, number], // death flesh-chunk count range (via gibsToSpawn at intensity 1); a shatter is bigger than a hit gib
      chunkSize: [3, 7] as [number, number], // death-chunk radius range (larger than shard 1.5–4.5)
      chunkDecalMax: 3, // max chunks that settle into decals PER kill (bounds lingering-decal load; see Task 2)
```

- [ ] **Step 3: Write the failing test for `deathChunkCount`**

In `game/systems/fx.test.ts`, **merge `deathChunkCount` into the existing `./fx` import** (it currently imports `{ gibsToSpawn, goreIntensity } from "./fx"` — make it `{ deathChunkCount, gibsToSpawn, goreIntensity }`, alphabetical for Biome), and add a `CONFIG` import if not already present:

```ts
import { CONFIG } from "../config";
// existing import becomes: import { deathChunkCount, gibsToSpawn, goreIntensity } from "./fx";

describe("deathChunkCount", () => {
  it("returns the max chunk count on an empty particle buffer (death is full intensity)", () => {
    // fill=0 ⇒ gibsToSpawn(1, 0, 0, min, max, cap) = round(max * 1) = max
    expect(deathChunkCount(0)).toBe(CONFIG.fx.gore.chunkCount[1]);
  });
  it("throttles toward zero as the particle buffer fills", () => {
    expect(deathChunkCount(0.5)).toBeLessThan(CONFIG.fx.gore.chunkCount[1]);
    expect(deathChunkCount(1)).toBe(0);
  });
  it("is throttled off once past the gib fill cap", () => {
    expect(deathChunkCount(CONFIG.fx.gore.gibFillCap)).toBe(0);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `bun run test -- fx`
Expected: FAIL — `deathChunkCount` is not exported.

- [ ] **Step 5: Add `deathChunkCount` and the `settle` param to `spawn`**

In `game/systems/fx.ts`, add the exported helper near `gibsToSpawn` (after it, around `fx.ts:45`):

```ts
/**
 * Flesh-chunk count for a DEATH shatter — reuses gibsToSpawn (the throttle logic) but with
 * death-calibrated CONFIG values (a shatter is bigger than a hit gib). Death is full intensity (1),
 * threshold 0 (a kill always shatters). Pure — unit-tested.
 */
export function deathChunkCount(fill: number): number {
  const g = CONFIG.fx.gore;
  return gibsToSpawn(1, fill, 0, g.chunkCount[0], g.chunkCount[1], g.gibFillCap);
}
```

Extend `spawn()` (`fx.ts:46`) with a trailing `settle` param and carry it onto the particle:

```ts
function spawn(
  state: State,
  x: number,
  y: number,
  vx: number,
  vy: number,
  life: number,
  r: number,
  color: RGB,
  kind: ParticleKind,
  drag: number,
  settle = false,
): void {
  if (state.particles.length >= CONFIG.fx.maxParticles) return;
  state.particles.push({
    x,
    y,
    vx,
    vy,
    life,
    maxLife: life,
    r,
    rot: rand(0, 6.28),
    color,
    kind,
    drag,
    settle,
  });
}
```

- [ ] **Step 6: Upgrade `fxKill` (flesh guard + chunk burst)**

Replace `fxKill` (`game/systems/fx.ts:178-221`) with:

```ts
/** death burst — shockwave ring, flesh chunks (organic deaths only), glowing embers */
export function fxKill(
  state: State,
  x: number,
  y: number,
  color: RGB,
  glow: RGB,
  big: boolean,
  flesh = true,
): void {
  const g = CONFIG.fx.gore;
  const n = big ? 22 : 12;
  spawn(state, x, y, 0, 0, big ? 0.32 : 0.22, big ? 46 : 26, glow, "ring", 0);

  // Flesh chunks: organic deaths only (a machine doesn't bleed — deployable destruction passes flesh=false).
  if (flesh) {
    const fill = state.particles.length / CONFIG.fx.maxParticles;
    const chunks = deathChunkCount(fill);
    // Flesh tone: enemy color blended toward the wound/blood tint so chunks read as body, not sparks.
    const cc: RGB = [
      lerp(color[0], g.woundTint[0], 0.6),
      lerp(color[1], g.woundTint[1], 0.6),
      lerp(color[2], g.woundTint[2], 0.6),
    ];
    for (let i = 0; i < chunks; i++) {
      const a = rand(0, 6.28);
      const sp = rand(60, big ? 240 : 180);
      // The first chunkDecalMax chunks settle into decals (Task 2); the rest fly and fade.
      spawn(
        state,
        x,
        y,
        Math.cos(a) * sp,
        Math.sin(a) * sp,
        rand(0.35, 0.7),
        rand(g.chunkSize[0], g.chunkSize[1]),
        cc,
        "chunk",
        4,
        i < g.chunkDecalMax,
      );
    }
  }

  // Embers (glowing sparks) — kept for both organic and machine deaths.
  for (let i = 0; i < n / 2; i++) {
    const a = rand(0, 6.28);
    const sp = rand(60, 220);
    spawn(state, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.2, 0.45), rand(2, 4), glow, "spark", 5);
  }

  if (flesh) bloodPool(state, x, y, big);
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun run test -- fx`
Expected: PASS (the `deathChunkCount` tests + all existing `fx` tests).

- [ ] **Step 8: Draw the `"chunk"` kind in the NORMAL particle loop**

In `game/game.ts`, the normal particle loop (`game/game.ts:571-577`), add a `chunk` branch after the `smoke` branch:

```ts
  // --- normal particles (shards / smoke / flesh chunks) ---
  for (const pt of state.particles) {
    const a = pt.life / pt.maxLife;
    if (pt.kind === "shard")
      R.rect(pt.x, pt.y, pt.r * 2, pt.r, pt.rot, pt.color[0], pt.color[1], pt.color[2], a);
    else if (pt.kind === "smoke")
      R.circle(pt.x, pt.y, pt.r, pt.color[0], pt.color[1], pt.color[2], a * 0.5);
    else if (pt.kind === "chunk")
      R.hex(pt.x, pt.y, pt.r, pt.rot, pt.color[0], pt.color[1], pt.color[2], a);
  }
```

- [ ] **Step 9: Gate deployable destruction to `flesh=false`**

In `game/systems/deployables.ts:62`:

```ts
        fxKill(state, d.x, d.y, def.color, def.color, true, false); // loud destruction burst (no flesh — it's a machine)
```

In `game/net/client.ts:341`:

```ts
          fxKill(st, d.x, d.y, color, color, true, false); // loud destruction burst (no flesh — it's a machine)
```

(The two zombie-death call sites — `bullets.ts:86` and `client.ts:249` — are left unchanged; they get `flesh=true` by default.)

- [ ] **Step 10: Typecheck, lint, full test**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: typecheck clean; lint clean; all tests pass.

- [ ] **Step 11: Commit**

```bash
git add game/types.ts game/config.ts game/systems/fx.ts game/game.ts game/systems/deployables.ts game/net/client.ts game/systems/fx.test.ts
git commit -m "feat(gore): death shatter — flesh chunks on kill, machines don't bleed"
```

- [ ] **Step 12: STAGE PLAYTEST (feel gates #1 & #3, partial)**

Hand off to the human: play a night. **#1 meaty kills** — does a kill read as the body shattering into flesh (not a generic pop)? **#3 not too gory** — does the default read as stylized, PEGI-12-acceptable? Also confirm **turret/barricade destruction shows NO flesh/blood** (sparks + ring only). Lingering decals come in Task 2 — don't gate on that yet. If kills feel wrong, tune `CONFIG.fx.gore.chunkCount`/`chunkSize` before Task 2.

---

### Task 2: Lingering carnage — chunks settle as decals (capped per kill)

The capped chunks (marked `settle` in Task 1) drop decals when they come to rest, so the ground accumulates gore that fades naturally.

**Files:**
- Modify: `game/config.ts` (add `chunkDecalRadius` to `fx.gore`)
- Modify: `game/systems/fx.ts` (`sysFx` expiry branch: settle `chunk` particles as decals)

**Interfaces:**
- Consumes: `pushDecal(state, x, y, r, color)` (existing private in `fx.ts:366`, same file as `sysFx`); `Particle.settle` (Task 1); `rand` (existing); `CONFIG.fx.gore.chunkDecalRadius`.
- Produces: nothing consumed downstream (behavior only).

- [ ] **Step 1: Add the `chunkDecalRadius` CONFIG field**

In `game/config.ts`, in the `fx.gore` block next to the Task 1 chunk fields:

```ts
      chunkDecalRadius: [3, 6] as [number, number], // radius range of a settled chunk decal
```

- [ ] **Step 2: Settle chunks as decals in the `sysFx` expiry branch**

In `game/systems/fx.ts`, the particle-expiry block in `sysFx` (`fx.ts:386-391`). Add the settle **before** the swap-pop assignment (while `p` still points to the expiring particle):

```ts
    if (p.life <= 0) {
      if (p.kind === "chunk" && p.settle) {
        const cr = CONFIG.fx.gore.chunkDecalRadius;
        pushDecal(state, p.x, p.y, rand(cr[0], cr[1]), p.color);
      }
      P[i] = P[P.length - 1] as (typeof P)[number];
      P.pop();
      continue;
    }
```

- [ ] **Step 3: Typecheck + full test**

Run: `bun run typecheck && bun run test`
Expected: typecheck clean; all tests pass (no test change — settling is feel code in the coverage-excluded `fx.ts`; `deathChunkCount` tests from Task 1 still pass).

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add game/config.ts game/systems/fx.ts
git commit -m "feat(gore): flesh chunks settle into lingering decals (capped per kill)"
```

- [ ] **Step 6: STAGE PLAYTEST (feel gate #2 — lingering, not noise)**

Hand off to the human. **#2 lingering carnage, not noise** — on a dense horde night, does the ground accumulate readable gore that fades naturally, WITHOUT blood pools being evicted too eagerly or visual clutter? Watch the decal cap: if blood pools vanish under a heavy night, apply a fallback (raise `CONFIG.fx.blood.maxDecals`, or give chunk-decals a shorter life than pools) — decided by feel. Re-confirm #1/#3 still hold with decals present. Only after the human confirms all three gates is the feature done.

---

## Notes for the executor

- **Playtest gates are human, not automated** (Task 1 Step 12, Task 2 Step 6). Do not self-certify feel. The `CONFIG.fx.gore.chunk*` values are first guesses; expect to tune from playtest.
- **Spec reconciliation (chunkCount vs gibCount):** the spec's §Config said "reuse `gibCount`" for the death count, but `gibCount` is `[2,7]` — hit-calibrated and smaller than a satisfying shatter (the old burst was 12/22). Per the spec's own escape clause ("if `gibsToSpawn` genuinely can't express the death count… it may extend"), this plan reuses the `gibsToSpawn` *helper* via `deathChunkCount` but with a new death-calibrated `chunkCount` range. This is the justified-non-duplicate path, not a parallel counter.
- **Deferred (do NOT build here):** procedural living-body carving; player-facing low-gore toggle; promoting `fxImpact` hit-gibs to settling chunks (would raise decal load). All logged in the spec.
- **Big-enemy chunk scaling** is intentionally uniform in v1 (chunk count not scaled by `big`, unlike the ring/ember counts). If brutes feel under-shattered in playtest, add a `big` multiplier then — not speculatively.
