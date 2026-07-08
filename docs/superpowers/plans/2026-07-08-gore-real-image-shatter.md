# Gore: Real-Image Death Shatter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On zombie death, the actual sprite fragments into N×N real-pixel pieces that fly out, fade, and a few settle as darkened real-pixel stains.

**Architecture:** A per-instance sprite sub-cell capability (instance `FLOATS 10→11` + a `gridN`/`atlasTexel` uniform + a shader UV remap with a half-texel clamp) lets the renderer draw one cell of a sprite. `fxKill` spawns N² such `"frag"` particles from the dying zombie's sprite; the draw loop resolves the sprite key→layer; a capped few settle into the existing decal list on expiry. Builds on the merged abstract "chunk" work (`feat/gore-death-shatter`), completely replacing that visual.

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess), WebGL2 GLSL ES 3.00 instanced renderer, Vitest, `CONFIG` tree, Biome.

**Spec:** `docs/superpowers/specs/2026-07-08-gore-real-image-shatter-design.md`

## Global Constraints

- **Render-only, no sim/wire change.** Fragments/decals are `state.particles`/`state.decals` (visual-only, never synced). Co-op re-derives via the existing `fxKill` kill-diff; the sprite **key** comes from the synced `z.type` (`ENEMY_TYPES[type].sprite`, pure data).
- **Systems & net stay render-agnostic.** `fx.ts`/`bullets.ts`/`client.ts` must NOT import the renderer. The particle carries the sprite **key** (string); `game.ts` resolves `R.spriteLayer(key)` at draw time.
- **Instance layout is `FLOATS 10→11`, `spriteQuad` byte-unchanged** (fragCell defaults to 0 = whole sprite). Both normal+additive buffers share `makeLayer()` — one edit.
- **Chunk goes in the NORMAL (non-additive) draw loop.** Fragments are textured sprites, not glow.
- **Complete removal of the abstract chunk code** (no dual chunk/frag path): the `"chunk"` `ParticleKind`, the `R.hex` chunk draw branch, `deathChunkCount` + its `fx.test.ts` tests, and the `chunkCount`/`chunkSize` config; **rename `chunkDecalMax`→`fragDecalMax`**.
- **mediump-safe:** `fragCell` encodes `cellY*gridN + cellX + 1` (≤17 at N=4); `gridN` is a uniform, `v_frag` is a `flat` varying.
- **All-or-nothing fragment spawn:** if the particle buffer can't fit all N², spawn none (ring/embers/blood still fire) — never a half-eaten sprite.
- Conservative, data-driven `CONFIG.fx.gore`; `fx.ts`/`renderer.ts`/shaders are coverage-excluded (pure helpers still unit-tested).

---

### Task 1: Renderer sub-cell capability + pure fragment helpers

Adds the ability to draw one cell of a sprite. No caller yet (that's Task 2), so no visible change; the deliverable is the tested pure helpers + a compiling renderer/shader that draws a sub-cell when asked.

**Files:**
- Create: `game/engine/fragment.ts`, `game/engine/fragment.test.ts`
- Modify: `game/engine/renderer.ts` (`FLOATS`, `makeLayer`, `write`, new `spriteFragQuad`, `atlasSize` module var, `u_gridN`/`u_atlasTexel` uniforms + `flush` sets them, export `spriteFragQuad`)
- Modify: `game/engine/shaders/instance.vert`, `game/engine/shaders/instance.frag`

**Interfaces:**
- Produces:
  - `packFragCell(cx: number, cy: number, gridN: number): number` (= `cy*gridN + cx + 1`)
  - `unpackFragCell(fragCell: number, gridN: number): { cx: number; cy: number }`
  - `cellOffset(cx: number, cy: number, gridN: number, drawSize: number): { lx: number; ly: number }` (local offset from sprite center, Y-flipped to match the shader)
  - `Renderer.spriteFragQuad(x, y, w, h, rot, index, cx, cy, r, g, b, a)`

- [ ] **Step 1: Write the failing pure-helper tests**

Create `game/engine/fragment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cellOffset, packFragCell, unpackFragCell } from "./fragment";

describe("fragCell pack/unpack", () => {
  it("packs cell (0,0) to 1 (0 is reserved for whole-sprite)", () => {
    expect(packFragCell(0, 0, 4)).toBe(1);
  });
  it("round-trips every cell of a 4x4 grid", () => {
    for (let cy = 0; cy < 4; cy++)
      for (let cx = 0; cx < 4; cx++) {
        const p = packFragCell(cx, cy, 4);
        expect(unpackFragCell(p, 4)).toEqual({ cx, cy });
      }
  });
  it("max cell of a 4x4 grid stays small (mediump-safe)", () => {
    expect(packFragCell(3, 3, 4)).toBe(16); // <= 17, safe for fp16
  });
});

describe("cellOffset (Y-flip matches shader 0.5 - v_local.y)", () => {
  it("top row (cy=0) is on the POSITIVE local-Y side", () => {
    // shader: atlas row 0 (PNG top) maps to +v_local.y side → cellOffset.ly must be positive for cy=0
    expect(cellOffset(0, 0, 4, 100).ly).toBeGreaterThan(0);
  });
  it("bottom row (cy=gridN-1) is on the NEGATIVE local-Y side", () => {
    expect(cellOffset(0, 3, 4, 100).ly).toBeLessThan(0);
  });
  it("left column negative X, right column positive X", () => {
    expect(cellOffset(0, 0, 4, 100).lx).toBeLessThan(0);
    expect(cellOffset(3, 0, 4, 100).lx).toBeGreaterThan(0);
  });
  it("center of an even grid is offset half a cell from origin (no cell sits exactly at center)", () => {
    // cx=2 of N=4 → ((2+0.5)/4 - 0.5)*100 = 12.5
    expect(cellOffset(2, 0, 4, 100).lx).toBeCloseTo(12.5, 5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- fragment`
Expected: FAIL — module `./fragment` not found.

- [ ] **Step 3: Implement `game/engine/fragment.ts`**

```ts
/**
 * Pure helpers for real-image sprite fragmentation (gore death-shatter). No GL — unit-tested.
 * `fragCell` is the per-instance encoding the renderer/shader use: 0 = whole sprite, otherwise
 * `cellY*gridN + cellX + 1`. `cellOffset` gives a cell's LOCAL offset from the sprite center,
 * Y-flipped to match the fragment shader's `0.5 - v_local.y` mapping (so a fragment spawns where
 * its pixels render on the intact sprite). The caller rotates this local offset by the sprite's
 * draw angle to get the world spawn position.
 */
export function packFragCell(cx: number, cy: number, gridN: number): number {
  return cy * gridN + cx + 1;
}

export function unpackFragCell(fragCell: number, gridN: number): { cx: number; cy: number } {
  const i = fragCell - 1;
  return { cx: i % gridN, cy: Math.floor(i / gridN) };
}

export function cellOffset(
  cx: number,
  cy: number,
  gridN: number,
  drawSize: number,
): { lx: number; ly: number } {
  return {
    lx: ((cx + 0.5) / gridN - 0.5) * drawSize,
    // Y-flip: cy=0 (atlas top / PNG top rows) → shader maps to the +v_local.y side, so +ly.
    ly: (0.5 - (cy + 0.5) / gridN) * drawSize,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- fragment`
Expected: PASS.

- [ ] **Step 5: Instance layout — `FLOATS`, `makeLayer`, `write`**

In `game/engine/renderer.ts`:

`game/engine/renderer.ts:11` — bump the layout:

```ts
const FLOATS = 11;
```

In `makeLayer()` (`renderer.ts:119`), after `set(5, 1, 36);` add the fragCell attribute (float index 10 = byte offset 40):

```ts
  set(5, 1, 36);
  set(6, 1, 40); // a_frag (sprite sub-cell; 0 = whole sprite)
```

Extend `write()` (`renderer.ts:315`) with a trailing `frag` param and write index 10:

```ts
function write(
  layer: Layer,
  x: number,
  y: number,
  sx: number,
  sy: number,
  rot: number,
  r: number,
  g: number,
  b: number,
  a: number,
  shape: number,
  frag = 0,
): void {
  if (layer.count >= CONFIG.maxInstances) return;
  const o = layer.count * FLOATS;
  const d = layer.data;
  d[o] = x;
  d[o + 1] = y;
  d[o + 2] = sx;
  d[o + 3] = sy;
  d[o + 4] = rot;
  d[o + 5] = r;
  d[o + 6] = g;
  d[o + 7] = b;
  d[o + 8] = a;
  d[o + 9] = shape;
  d[o + 10] = frag;
  layer.count++;
}
```

(All existing `write(...)` callers omit `frag` → 0 = whole sprite; no other change needed.)

- [ ] **Step 6: `spriteFragQuad` + `atlasSize` + uniforms**

Add `spriteFragQuad` next to `spriteQuad` (`renderer.ts:419`), importing the pack helper at the top of the file (`import { packFragCell } from "./fragment";`):

```ts
function spriteFragQuad(
  x: number,
  y: number,
  w: number,
  h: number,
  rot: number,
  index: number,
  cx: number,
  cy: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  write(normal, x, y, w, h, rot, r, g, b, a, SHAPE.sprite + index, packFragCell(cx, cy, CONFIG.fx.gore.gridN));
}
```

Add a module-level atlas-size var near `spriteRects` (`renderer.ts:87`):

```ts
let atlasSize = 1; // px size of the square sprite atlas; feeds u_atlasTexel (half-texel guard)
```

In `loadSprites` (`renderer.ts:389`, right after `const packed = packSprites(...)`):

```ts
  atlasSize = packed.atlas;
```

Get the new uniform locations where the others are fetched (near `renderer.ts:169`, add module `let u_gridN`/`let u_atlasTexel` alongside the other `let u_*` decls, then):

```ts
  u_gridN = gl.getUniformLocation(instProg, "u_gridN");
  u_atlasTexel = gl.getUniformLocation(instProg, "u_atlasTexel");
```

Set them once per frame in `flush()`, in the `instProg` uniform block (after `renderer.ts:628`):

```ts
  gl.uniform1f(u_gridN, CONFIG.fx.gore.gridN);
  gl.uniform1f(u_atlasTexel, 1 / atlasSize);
```

Add `spriteFragQuad` to the exported `Renderer` object (wherever `spriteQuad` is exported).

- [ ] **Step 7: Vertex shader — pass `a_frag` through as flat**

In `game/engine/shaders/instance.vert`, add the attribute + flat varying:

```glsl
layout(location=5) in float a_shape;
layout(location=6) in float a_frag;
```
```glsl
out vec2 v_local; out vec4 v_color; out float v_shape; out vec2 v_world;
flat out float v_frag;
```
and in `main()` after `v_shape=a_shape;`:
```glsl
  v_frag=a_frag;
```

- [ ] **Step 8: Fragment shader — sub-cell remap + half-texel clamp**

In `game/engine/shaders/instance.frag`, add near the other uniforms/ins:

```glsl
flat in float v_frag;
uniform float u_gridN;
uniform float u_atlasTexel;
```

Replace the sprite branch (`instance.frag`, the `} else if(s >= 16){ ... }` block) with:

```glsl
  } else if(s >= 16){
    int i = s - 16;
    vec4 rc = u_spriteRects[i];
    vec2 uv;
    if(v_frag != 0.0){
      float cellIdx = v_frag - 1.0;              // 0 .. N*N-1
      float cxc = mod(cellIdx, u_gridN);
      float cyc = floor(cellIdx / u_gridN);
      vec2 cellSz = rc.zw / u_gridN;             // sub-rect size in atlas UV
      vec2 base   = rc.xy + vec2(cxc, cyc) * cellSz;
      uv = base + vec2(v_local.x + 0.5, 0.5 - v_local.y) * cellSz;
      // interior cell boundaries aren't inset by uvRect — clamp by half a texel to stop bleed
      vec2 hlf = vec2(u_atlasTexel * 0.5);
      uv = clamp(uv, base + hlf, base + cellSz - hlf);
    } else {
      uv = rc.xy + vec2(v_local.x + 0.5, 0.5 - v_local.y) * rc.zw;
    }
    vec4 t = texture(u_sprites, uv);
    if(t.a < 0.5) discard;
    frag = vec4(t.rgb, t.a) * v_color;
  } else {
```

- [ ] **Step 9: Typecheck, lint, test, build (shaders compile at build)**

Run: `bun run typecheck && bun run lint && bun run test -- fragment && bun run build`
Expected: all clean; `fragment` tests pass; `build` succeeds (GLSL imported as strings — a syntax error won't fail build, but tsc/vite must be green).

- [ ] **Step 10: Commit**

```bash
git add game/engine/fragment.ts game/engine/fragment.test.ts game/engine/renderer.ts game/engine/shaders/instance.vert game/engine/shaders/instance.frag
git commit -m "feat(render): per-instance sprite sub-cell (fragCell) for gore fragmentation"
```

---

### Task 2: The shatter — `frag` particles replace abstract `chunk`; draw + call sites

Kills spawn real-pixel fragments that fly and fade; machines don't shatter. Removes all abstract-chunk code. Ends with the **flying-shatter playtest gate**.

**Files:**
- Modify: `game/types.ts` (`ParticleKind` chunk→frag; `Particle` fields)
- Modify: `game/config.ts` (`fx.gore`: remove `chunkCount`/`chunkSize`, rename `chunkDecalMax`→`fragDecalMax`, add `gridN`/`fragSpeed`/`fragLife`)
- Modify: `game/systems/fx.ts` (remove `deathChunkCount`; rewrite `fxKill`)
- Modify: `game/systems/fx.test.ts` (remove `deathChunkCount` describe + its import)
- Modify: `game/game.ts` (NORMAL particle draw loop: chunk→frag via `spriteFragQuad`)
- Modify: `game/systems/bullets.ts` (`killZombie`: import `ENEMY_TYPES`, pass sprite key + face)
- Modify: `game/net/client.ts` (kill re-derive: pass `t.sprite` key)

**Interfaces:**
- Consumes: `cellOffset` (`../engine/fragment`), `R.spriteLayer`/`R.spriteFragQuad`, `SPRITE_SCALE`/`SPRITE_FACE_OFFSET` (`game.ts`), `ENEMY_TYPES` (`../data/enemies`).
- Produces: `fxKill(state, x, y, color, glow, big, flesh = true, spriteKey = "", face = 0, rad = 0)`; `Particle` gains `spriteKey?: string; cellX?: number; cellY?: number` (keeps `settle?`; reuses `r` for fragment cell size); `ParticleKind` = `"spark" | "shard" | "ring" | "smoke" | "frag"`; `CONFIG.render = { spriteScale, spriteFaceOffset }`.

- [ ] **Step 1: `ParticleKind` + `Particle` fields**

In `game/types.ts:302`:

```ts
export type ParticleKind = "spark" | "shard" | "ring" | "smoke" | "frag";
```

Replace the `Particle` `settle?` block (`game/types.ts:316-317`) with:

```ts
  /** real-image fragment (gore shatter): the sprite KEY + sub-cell it draws (game.ts resolves key→layer) */
  spriteKey?: string;
  cellX?: number;
  cellY?: number;
  /** fragment settles into a decal on expiry (set by fxKill for the first fragDecalMax fragments) */
  settle?: boolean;
```

- [ ] **Step 2: CONFIG — remove chunk*, add frag***

In `game/config.ts`, replace the three chunk lines (`game/config.ts:91-93`) with:

```ts
      gridN: 4, // fragmentation grid: 4 → 16 real-pixel pieces per kill (also the u_gridN uniform)
      fragSpeed: [60, 240] as [number, number], // outward fly speed range
      fragLife: [0.45, 0.8] as [number, number], // fragment particle lifetime (s) before fade
      fragDecalMax: 3, // max fragments that settle into decals per kill (Task 3)
```

Also add a top-level `render` block to `CONFIG` (so `fx.ts` can read the sprite constants without importing `game.ts` — which would be circular, since `game.ts` imports `fx.ts`):

```ts
  render: { spriteScale: 2.6, spriteFaceOffset: Math.PI / 2 },
```

Then in `game/game.ts`, rewire its two local consts to read CONFIG (keeps every existing `SPRITE_SCALE`/`SPRITE_FACE_OFFSET` use in game.ts working, zero further churn):

```ts
const SPRITE_SCALE = CONFIG.render.spriteScale;
const SPRITE_FACE_OFFSET = CONFIG.render.spriteFaceOffset;
```

- [ ] **Step 3: Update the failing test first — remove `deathChunkCount`**

In `game/systems/fx.test.ts`: change the import (`fx.test.ts:3`) to drop `deathChunkCount`:

```ts
import { gibsToSpawn, goreIntensity } from "./fx";
```

Delete the entire `describe("deathChunkCount", () => { … })` block (`fx.test.ts:73-85`).

- [ ] **Step 4: Run tests to confirm the suite is green without deathChunkCount refs**

Run: `bun run test -- fx`
Expected: FAIL to typecheck/run at first if `fxKill`/`deathChunkCount` still reference removed config — that's expected mid-edit; proceed to Step 5, then re-run.

- [ ] **Step 5: `fx.ts` — remove `deathChunkCount`, rewrite `fxKill`**

In `game/systems/fx.ts`: delete the `deathChunkCount` function (`fx.ts:47-54`). Add the import at the top (`Particle` is already used in the file; `CONFIG` already imported):

```ts
import { cellOffset } from "../engine/fragment";
```

Replace `fxKill` (`fx.ts:189` through its closing `}`) with (note the new `rad` param — the enemy radius — needed to size fragments to the real sprite; and `CONFIG.render.*` instead of a circular `game.ts` import):

```ts
/** death burst — shockwave ring, real-image sprite fragments (organic deaths only), glowing embers */
export function fxKill(
  state: State,
  x: number,
  y: number,
  color: RGB,
  glow: RGB,
  big: boolean,
  flesh = true,
  spriteKey = "",
  face = 0,
  rad = 0,
): void {
  const g = CONFIG.fx.gore;
  const n = big ? 22 : 12;
  spawn(state, x, y, 0, 0, big ? 0.32 : 0.22, big ? 46 : 26, glow, "ring", 0);

  // Real-image fragments: organic deaths with a known sprite + radius only (machines pass flesh=false / "").
  if (flesh && spriteKey && rad > 0) {
    const N = g.gridN;
    const cells = N * N;
    // All-or-nothing: never spawn a partial (half-eaten) set. Ring/embers/blood still fire below.
    if (state.particles.length + cells <= CONFIG.fx.maxParticles) {
      const drawSize = 2 * rad * CONFIG.render.spriteScale; // matches the enemy draw size (rad*2*scale)
      const cellSz = drawSize / N; // on-screen size of one fragment
      const ang = face + CONFIG.render.spriteFaceOffset; // parent draw rotation
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      let idx = 0;
      for (let cy = 0; cy < N; cy++) {
        for (let cx = 0; cx < N; cx++) {
          const o = cellOffset(cx, cy, N, drawSize);
          const wx = x + o.lx * ca - o.ly * sa; // local offset rotated into world
          const wy = y + o.lx * sa + o.ly * ca;
          const sp = rand(g.fragSpeed[0], g.fragSpeed[1]);
          const dir = Math.atan2(wy - y, wx - x) + rand(-0.5, 0.5); // fly outward-ish
          const life = rand(g.fragLife[0], g.fragLife[1]);
          state.particles.push({
            x: wx,
            y: wy,
            vx: Math.cos(dir) * sp,
            vy: Math.sin(dir) * sp,
            life,
            maxLife: life,
            r: cellSz, // fragment on-screen size (used by the draw loop)
            rot: ang, // start aligned to the body, then tumble via drag-free spin below
            color: [1, 1, 1],
            kind: "frag",
            drag: 4,
            spriteKey,
            cellX: cx,
            cellY: cy,
            settle: idx < g.fragDecalMax,
          });
          idx++;
        }
      }
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

(`SPRITE_SCALE`/`SPRITE_FACE_OFFSET` are read from `CONFIG.render` — see Step 2 — so `fx.ts` needs no `game.ts` import. Fragments keep `rot` constant here; if playtest wants visible tumble, add a per-frame `rot += spin*dt` in `sysFx` for `"frag"` — deferred as tuning, not built now.)

- [ ] **Step 6: `game.ts` — draw frag in the NORMAL loop**

In `game/game.ts`, replace the chunk branch (`game.ts:577-578`) in the NORMAL particle loop:

```ts
    else if (pt.kind === "frag" && pt.spriteKey) {
      const fl = R.spriteLayer(pt.spriteKey);
      if (fl >= 0)
        R.spriteFragQuad(pt.x, pt.y, pt.r, pt.r, pt.rot, fl, pt.cellX ?? 0, pt.cellY ?? 0, 1, 1, 1, a);
    }
```

(`pt.r` is the fragment's on-screen cell size, set by `fxKill` from the enemy radius — big enemies get bigger pieces.)

Also update the loop comment `game.ts:570` from "flesh chunks" to "flesh fragments".

- [ ] **Step 7: Call sites — pass the sprite key (+face on host)**

In `game/systems/bullets.ts`: add the import:
```ts
import { ENEMY_TYPES } from "../data/enemies";
```
Replace the `killZombie` `fxKill` call (`bullets.ts:86`) — pass sprite key, facing (`atan2` of the zombie's velocity), and the actual radius `z.r`:
```ts
  const sprite = ENEMY_TYPES[z.type]?.sprite ?? "";
  fxKill(state, z.x, z.y, z.color, z.glow, big, true, sprite, Math.atan2(z.vy, z.vx), z.r);
```

In `game/net/client.ts`, the kill re-derive (`client.ts:249`) — `t` is already `ENEMY_TYPES[z.type]`; the snapshot zombie has no `r`/velocity, so pass the type's base `radius` and `face=0` (fragment spawn positions are cosmetic and unsynced, so this is fine):
```ts
        fxKill(st, z.x, z.y, (t?.color ?? GREY) as RGB, (t?.glow ?? GREY) as RGB, big, true, t?.sprite ?? "", 0, t?.radius ?? 0);
```

Leave the two machine sites (`deployables.ts:62`, `client.ts:341`) as `flesh=false` — they already skip fragments.

- [ ] **Step 8: Typecheck, lint, full test**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass (no more `deathChunkCount`/`chunk` refs; `fragment` + existing tests green).

- [ ] **Step 9: Commit**

```bash
git add game/types.ts game/config.ts game/systems/fx.ts game/systems/fx.test.ts game/game.ts game/systems/bullets.ts game/net/client.ts
git commit -m "feat(gore): real-image sprite fragments on death (replaces abstract chunks)"
```

- [ ] **Step 10: FLYING-SHATTER PLAYTEST GATE (feel #1 & #3 + the toy-unverifiable checks)**

Hand off to the human. **#1 meaty, real kills** — does a kill read as the body shattering into its real pixels, in the gloom too? **Toy-unverifiable in-engine checks:** (a) no neighbour-cell **bleed** and no over-clamp **seam** between fragments; (b) fragments fly from the **correct side** (cell-offset flip); (c) orientation reads as body-cracking-then-tumbling. **#3** not gratuitous (PEGI-12). **Machines** (turret/barricade) still show NO fragments. If wrong, tune `CONFIG.fx.gore.gridN`/`fragSpeed`/`fragLife` (or fix the shader clamp/offset) before Task 3. Lingering stains come in Task 3.

---

### Task 3: Fragments settle as lingering real-pixel decals

The capped fragments (marked `settle` in Task 2) drop darkened real-pixel decals on expiry. Ends with the **lingering playtest gate**.

**Files:**
- Modify: `game/config.ts` (`fx.gore`: add `fragDecalLife`, `fragDecalDarken`)
- Modify: `game/types.ts` (`Decal` fields)
- Modify: `game/systems/fx.ts` (`pushFragDecal`; settle in `sysFx` expiry)
- Modify: `game/game.ts` (decal draw branch)

**Interfaces:**
- Consumes: `Particle.settle/spriteKey/cellX/cellY` (Task 2); `R.spriteFragQuad`/`R.spriteLayer`; `CONFIG.fx.gore.fragDecalLife`/`fragDecalDarken`.
- Produces: `Decal` gains `spriteKey?: string; cellX?: number; cellY?: number` (reuses existing `rot`).

- [ ] **Step 1: CONFIG — add decal fields**

In `game/config.ts`, in `fx.gore` after `fragDecalMax`:

```ts
      fragDecalLife: [8, 16] as [number, number], // settled-fragment decal life (s) — shorter than blood.life
      fragDecalDarken: 0.5, // brightness multiplier for a settled fragment (dried stain)
```

- [ ] **Step 2: `Decal` fields**

In `game/types.ts`, add to the `Decal` interface (after `maxLife`):

```ts
  /** real-image fragment decal (gore): sprite KEY + sub-cell (game.ts resolves key→layer); plain blood leaves undefined */
  spriteKey?: string;
  cellX?: number;
  cellY?: number;
```

- [ ] **Step 3: `pushFragDecal` + settle on expiry**

In `game/systems/fx.ts`, add a sibling to `pushDecal`:

```ts
function pushFragDecal(state: State, x: number, y: number, rot: number, spriteKey: string, cellX: number, cellY: number): void {
  const cfg = CONFIG.fx.blood;
  if (state.decals.length >= cfg.maxDecals) state.decals.shift();
  const fl = CONFIG.fx.gore.fragDecalLife;
  const life = rand(fl[0], fl[1]);
  state.decals.push({ x, y, r: 0, rot, color: [1, 1, 1], life, maxLife: life, spriteKey, cellX, cellY });
}
```

In `sysFx`'s particle-expiry branch (`fx.ts`, the `if (p.life <= 0) { … }` block), **before** the swap-pop assignment:

```ts
    if (p.life <= 0) {
      if (p.kind === "frag" && p.settle && p.spriteKey)
        pushFragDecal(state, p.x, p.y, p.rot, p.spriteKey, p.cellX ?? 0, p.cellY ?? 0);
      P[i] = P[P.length - 1] as (typeof P)[number];
      P.pop();
      continue;
    }
```

- [ ] **Step 4: Decal draw branch in `game.ts`**

In `game/game.ts`, the decal loop (`game.ts:559-562`), branch on fragment-decals:

```ts
  for (const d of state.decals) {
    const cap = CONFIG.fx.blood.maxAlpha;
    const a = Math.min(cap, (d.life / d.maxLife) * cap);
    if (d.spriteKey) {
      const dl = R.spriteLayer(d.spriteKey);
      if (dl < 0) continue;
      const dk = CONFIG.fx.gore.fragDecalDarken;
      const dsz = (2 * 32 * SPRITE_SCALE) / CONFIG.fx.gore.gridN;
      R.spriteFragQuad(d.x, d.y, dsz, dsz, d.rot, dl, d.cellX ?? 0, d.cellY ?? 0, dk, dk, dk, a);
    } else {
      R.circle(d.x, d.y, d.r, d.color[0], d.color[1], d.color[2], a);
    }
  }
```

- [ ] **Step 5: Typecheck, lint, full test**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all pass (no test changes — settle is feel code in coverage-excluded `fx.ts`; the fragment pure tests from Task 1 still pass).

- [ ] **Step 6: Commit**

```bash
git add game/config.ts game/types.ts game/systems/fx.ts game/game.ts
git commit -m "feat(gore): fragments settle as lingering real-pixel decals (capped per kill)"
```

- [ ] **Step 7: LINGERING PLAYTEST GATE (feel #2)**

Hand off to the human. **#2 lingering, not noise + no perf hit** — a few real-pixel fragment-stains settle (darkened) on top of blood pools and read as accumulating carnage that fades; on a dense horde night no perf hitch, no clutter, and blood pools aren't visibly evicted (shared `maxDecals` holds; frag-decals are shorter-lived). Re-confirm #1/#3 still hold. If pools get evicted, raise `CONFIG.fx.blood.maxDecals` or lower `fragDecalLife`. Only after all three gates pass is the feature done.

---

## Notes for the executor

- **Playtest gates are human** (Task 2 Step 10, Task 3 Step 7) — do not self-certify feel. `CONFIG.fx.gore.frag*` are first guesses; expect to tune. The half-texel clamp, cell-offset flip, and orientation are the toy-unverifiable items — verify them in-engine at the Task 2 gate.
- **Circular import (resolved):** `game.ts` imports `fx.ts` (confirmed), so `SPRITE_SCALE`/`SPRITE_FACE_OFFSET` move to `CONFIG.render` (Task 2 Step 2) and are read from CONFIG in both files — `fx.ts` never imports `game.ts`.
- **Deferred (do NOT build):** procedural living-body carving; player-facing low-gore toggle; per-`big` fragment *count* differences (per-`big` fragment *size* is already free via the enemy draw size).
- **Git:** Task 1's abstract-chunk commit stays in branch history (built on, not reverted); squash-or-not is a PR-hygiene call at merge time.