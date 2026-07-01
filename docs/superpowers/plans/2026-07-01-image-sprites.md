# Image Sprites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the engine a rebuild-proof textured-sprite system (single variable-size atlas) and seed it with one zombie illustration, so we can judge by playing whether a sprite survives the flashlight lighting or reads as a pasted-on sticker.

**Architecture:** Sprites ride the existing single instanced draw. A new shape mode `SHAPE.sprite = 16` (base-offset gap from the SDF shapes 0–6) carries the atlas index as `shape − 16`. All PNGs are packed at load into one `TEXTURE_2D` atlas; per-sprite UV rects live in a `u_spriteRects[]` uniform. The instance fragment shader samples the atlas for `shape >= 16` and then applies the existing `lightAt`/desaturation to it for free, so darkness/flashlight behavior matches every other entity. No instance-layout change (stays 10 floats); `update()`/snapshots untouched, so single-player stays byte-for-byte and co-op is unaffected.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), WebGL2, GLSL ES 3.00, Vite (`import.meta.glob` for asset discovery, `?url` imports), Vitest (pure-logic tests only), Biome (lint/format), Bun.

## Global Constraints

- **Single-player byte-for-byte:** never touch `update()`, snapshots, sim state, or the 10-float instance layout. Sprites are chosen at **draw** time from data, never stored on `Zombie` or synced.
- **Feel-first, playtest-verified:** the renderer/shader/draw changes are NOT unit-tested (CLAUDE.md scope). Only pure math (`spritePack.ts`) gets Vitest tests. Everything else is verified by `bun run typecheck` + `bun run build` green and by the Task 7 playtest against the 5 exit criteria.
- **Data-driven, no special-case:** the sprite key lives in the enemy data table (`ENEMY_TYPES[...].sprite`); the draw path is one branch (sprite if a ready key exists, else the existing SDF shape).
- **Quality gates:** pre-commit runs `biome check --write` on staged files; pre-push runs `bun run typecheck` + `bun run test`. Keep both green.
- **Pixel-perfect:** atlas texture uses `gl.NEAREST` (no filtering), `CLAMP_TO_EDGE`, no mipmaps; sub-rects get a gutter + half-texel UV inset so `NEAREST` never bleeds a neighbor.
- **Spec:** `docs/superpowers/specs/2026-07-01-image-sprites-design.md` is the source of truth.

---

## File Structure

- **Create** `game/engine/spritePack.ts` — pure atlas math: `packSprites()` (deterministic shelf packing in stable index order) + `uvRect()` (half-texel-inset UV). Unit-tested.
- **Create** `game/engine/spritePack.test.ts` — Vitest for the above.
- **Create** `game/engine/spriteAssets.ts` — `import.meta.glob` over `game/assets/sprites/*.png` → stable ordered `SPRITE_ASSETS: {key,url}[]` and `spriteIndex(key)`.
- **Create** `game/assets/sprites/zombie.png` — the (background-removed) zombie illustration.
- **Modify** `game/engine/shaders/instance.frag` — add `u_sprites` sampler + `u_spriteRects[32]`; `shape >= 16` samples the atlas.
- **Modify** `game/engine/renderer.ts` — `SHAPE.sprite = 16`, atlas texture (init 1×1 transparent so the sampler is always complete), `loadSprites()`, `spriteQuad()` writer, `spriteLayer()`, bind atlas + upload `u_spriteRects` in `flush()`, export the two new methods.
- **Modify** `game/types.ts` — add `sprite?: string` to `EnemyType`.
- **Modify** `game/data/enemies.ts` — set `sprite: "zombie"` on `walker`.
- **Modify** `game/game.ts` — import `ENEMY_TYPES`; in the zombie draw, use the sprite when its layer is ready (and drop the silhouette ring), else the existing SDF shape.

---

### Task 1: Pure atlas-packing math (`spritePack.ts`)

**Files:**
- Create: `game/engine/spritePack.ts`
- Test: `game/engine/spritePack.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Size { w: number; h: number }`
  - `interface Rect { x: number; y: number; w: number; h: number }`
  - `interface Packed { atlas: number; rects: Rect[] }`
  - `packSprites(sizes: Size[], gutter: number, maxAtlas: number): Packed` — shelf-packs `sizes` **in input order** into the smallest power-of-two square (starting 64) that fits within `maxAtlas`; throws `Error("sprite atlas over budget")` if none fits. `rects[i]` corresponds to `sizes[i]`.
  - `uvRect(r: Rect, atlas: number): [number, number, number, number]` — returns `[u0, v0, uWidth, vHeight]` with a half-texel inset (`u0=(x+0.5)/atlas`, `uWidth=(w-1)/atlas`, same for v).

- [ ] **Step 1: Write the failing test**

Create `game/engine/spritePack.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { packSprites, uvRect } from "./spritePack";

describe("packSprites", () => {
  it("puts a single sprite at the origin in the smallest fitting pow2 atlas", () => {
    const p = packSprites([{ w: 100, h: 100 }], 2, 2048);
    expect(p.atlas).toBe(128); // 100 + gutter = 102 > 64, fits 128
    expect(p.rects).toEqual([{ x: 0, y: 0, w: 100, h: 100 }]);
  });

  it("advances x by width+gutter for the next sprite on the same shelf", () => {
    const p = packSprites(
      [
        { w: 40, h: 40 },
        { w: 30, h: 30 },
      ],
      2,
      2048,
    );
    expect(p.rects[0]).toEqual({ x: 0, y: 0, w: 40, h: 40 });
    expect(p.rects[1]).toEqual({ x: 42, y: 0, w: 30, h: 30 });
  });

  it("wraps to the next shelf when the row overflows the atlas width", () => {
    // atlas 64: first 40 fits at x=0 (advance to 42); second 40 needs 42+42=84 > 64 → wrap
    const p = packSprites(
      [
        { w: 40, h: 40 },
        { w: 40, h: 40 },
      ],
      2,
      2048,
    );
    expect(p.atlas).toBe(128); // both 42-wide rows: 84 > 64 so 64 fails; 128 holds both on one shelf
    expect(p.rects[1]).toEqual({ x: 42, y: 0, w: 40, h: 40 });
  });

  it("throws when the sprites cannot fit within maxAtlas", () => {
    expect(() => packSprites([{ w: 100, h: 100 }], 2, 64)).toThrow("sprite atlas over budget");
  });
});

describe("uvRect", () => {
  it("insets by half a texel on every side", () => {
    expect(uvRect({ x: 0, y: 0, w: 100, h: 100 }, 128)).toEqual([
      0.5 / 128,
      0.5 / 128,
      99 / 128,
      99 / 128,
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test spritePack`
Expected: FAIL — cannot resolve `./spritePack` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `game/engine/spritePack.ts`:

```ts
/** Pure atlas geometry: deterministic shelf packing + half-texel-inset UVs. No GL, no I/O. */

export interface Size {
  w: number;
  h: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Packed {
  atlas: number;
  rects: Rect[];
}

/**
 * Shelf-pack `sizes` IN INPUT ORDER (so the caller's stable index maps to rects[i]) into the
 * smallest pow2 square atlas (from 64) that fits within `maxAtlas`. `gutter` px of trailing
 * spacing separates neighbors so NEAREST sampling can't bleed. Throws if nothing fits.
 */
export function packSprites(sizes: Size[], gutter: number, maxAtlas: number): Packed {
  for (let atlas = 64; atlas <= maxAtlas; atlas *= 2) {
    const rects = tryPack(sizes, gutter, atlas);
    if (rects) return { atlas, rects };
  }
  throw new Error("sprite atlas over budget");
}

function tryPack(sizes: Size[], gutter: number, atlas: number): Rect[] | null {
  const rects: Rect[] = [];
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const s of sizes) {
    const cellW = s.w + gutter;
    const cellH = s.h + gutter;
    if (x + cellW > atlas) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    if (y + cellH > atlas) return null;
    rects.push({ x, y, w: s.w, h: s.h });
    x += cellW;
    if (cellH > rowH) rowH = cellH;
  }
  return rects;
}

/** UV rect [u0, v0, uWidth, vHeight] for a packed rect, inset half a texel so NEAREST stays inside. */
export function uvRect(r: Rect, atlas: number): [number, number, number, number] {
  return [(r.x + 0.5) / atlas, (r.y + 0.5) / atlas, (r.w - 1) / atlas, (r.h - 1) / atlas];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test spritePack`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add game/engine/spritePack.ts game/engine/spritePack.test.ts
git commit -m "feat(engine): pure atlas packing math (spritePack)"
```

---

### Task 2: Sprite asset discovery + the zombie PNG (`spriteAssets.ts`)

**Files:**
- Create: `game/engine/spriteAssets.ts`
- Create: `game/assets/sprites/zombie.png` (the background-removed illustration)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SPRITE_ASSETS: { key: string; url: string }[]` — every `game/assets/sprites/*.png`, sorted by filename so the index is stable across builds. `key` is the filename without extension (`zombie.png` → `"zombie"`).
  - `spriteIndex(key: string): number` — index into `SPRITE_ASSETS`, or `-1` if unknown.

- [ ] **Step 1: Place the zombie PNG**

The illustration must be background-removed, drawn top-down (bird's-eye), flat/neutral-lit, saved as RGBA PNG with transparent background. Put it at `game/assets/sprites/zombie.png`.

- If you have the raw generated image at `<RAW>` and it has a solid/near-solid background, remove it and hard-threshold the alpha (avoids `NEAREST` fringe):

```bash
mkdir -p game/assets/sprites
# chroma-key example (white bg → transparent) + binarize alpha; adjust fuzz/color to the source:
magick "<RAW>" -fuzz 12% -transparent white -channel A -threshold 50% +channel \
  -trim +repage game/assets/sprites/zombie.png
```

- If the real art is not ready yet, generate a temporary opaque-silhouette placeholder so the pipeline builds and runs (swap for real art before Task 7):

```bash
mkdir -p game/assets/sprites
magick -size 96x96 xc:none -fill "#6b8e3a" -draw "circle 48,48 48,12" game/assets/sprites/zombie.png
```

Verify it exists and is RGBA:

Run: `magick identify game/assets/sprites/zombie.png`
Expected: prints `... PNG 96x96 ...` (or your art's size) with an alpha channel.

- [ ] **Step 2: Write `spriteAssets.ts`**

Create `game/engine/spriteAssets.ts`:

```ts
/**
 * Discovers sprite PNGs at build time (Vite glob) and exposes a stable, filename-sorted list so a
 * sprite's atlas index is deterministic across builds. `?url` keeps small PNGs as real URLs (not
 * base64-inlined) so the renderer can Image-load them. Pure: no GL, no fetch at import.
 * Mirrors game/engine/audioAssets.ts.
 */
const modules = import.meta.glob("../assets/sprites/*.png", {
  query: "?url",
  import: "default",
  eager: true,
}) as Record<string, string>;

export const SPRITE_ASSETS: { key: string; url: string }[] = Object.keys(modules)
  .sort()
  .map((path) => {
    const file = path.slice(path.lastIndexOf("/") + 1);
    const key = file.slice(0, file.lastIndexOf("."));
    return { key, url: modules[path] as string };
  });

const INDEX = new Map(SPRITE_ASSETS.map((a, i) => [a.key, i]));

export function spriteIndex(key: string): number {
  return INDEX.get(key) ?? -1;
}
```

- [ ] **Step 3: Verify it typechecks and the glob resolves**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add game/engine/spriteAssets.ts game/assets/sprites/zombie.png
git commit -m "feat(engine): sprite asset discovery + zombie sprite PNG"
```

---

### Task 3: Fragment shader — sample the atlas for `shape >= 16`

**Files:**
- Modify: `game/engine/shaders/instance.frag`

**Interfaces:**
- Consumes: `v_local` (already `[-0.5,0.5]`), `v_color`, `v_shape`, `v_world` (existing).
- Produces (contract the renderer must satisfy): a `uniform sampler2D u_sprites;` and a `uniform vec4 u_spriteRects[MAX_SPRITES];` where `MAX_SPRITES = 32`; each rect is `[u0, v0, uWidth, vHeight]`. For an instance with `shape = 16 + i`, the shader samples `u_spriteRects[i]`.

- [ ] **Step 1: Add the uniforms**

In `game/engine/shaders/instance.frag`, after the existing uniform block (right before `out vec4 frag;` on line 15), add:

```glsl
const int MAX_SPRITES = 32;
uniform sampler2D u_sprites;
uniform vec4 u_spriteRects[MAX_SPRITES]; // per-sprite atlas UV rect: [u0, v0, uWidth, vHeight]
```

- [ ] **Step 2: Add the sprite branch**

In `main()`, the shape dispatch is a chain ending in `} else { frag = v_color; }` (line ~114). Replace that final `else` with a sprite branch, then keep a plain fallback:

```glsl
  } else if(s >= 16){
    int i = s - 16;
    vec4 rc = u_spriteRects[i];
    // VFLIP: the vertex shader flips clip-space Y (-clip.y); whether the texture's V must also flip
    // depends on the PNG's row order. Start with (0.5 - v_local.y); if the sprite renders upside
    // down on device, change this one line to (v_local.y + 0.5). Verified by looking (exit crit 2).
    vec2 uv = rc.xy + vec2(v_local.x + 0.5, 0.5 - v_local.y) * rc.zw;
    vec4 t = texture(u_sprites, uv);
    if(t.a < 0.5) discard;
    frag = vec4(t.rgb, t.a) * v_color;
  } else {
    frag = v_color;
  }
```

(Leave the trailing `frag.rgb *= mix(u_emissive, 1.0, lightAt(v_world));` and the `u_sat`/`u_dim` line exactly as-is — the sprite inherits lighting + grade from them.)

- [ ] **Step 3: Verify the shader still compiles via a build**

Run: `bun run build`
Expected: build succeeds. (A GLSL compile error would surface at runtime, not build; the runtime check happens in Task 4/7. `build` confirms the `?raw` import and TS are fine.)

- [ ] **Step 4: Commit**

```bash
git add game/engine/shaders/instance.frag
git commit -m "feat(shader): sample sprite atlas for shape>=16 (lighting/grade inherited)"
```

---

### Task 4: Renderer — atlas texture, loader, `spriteQuad`, `spriteLayer`, flush binding

**Files:**
- Modify: `game/engine/renderer.ts`

**Interfaces:**
- Consumes: `packSprites`, `uvRect`, `Size` (Task 1); `SPRITE_ASSETS`, `spriteIndex` (Task 2); the shader uniforms `u_sprites`, `u_spriteRects` (Task 3).
- Produces (used by Task 6):
  - `SHAPE.sprite = 16`.
  - `Renderer.spriteQuad(x, y, w, h, rot, index, r, g, b, a)` — writes a normal-layer instance with `shape = 16 + index`.
  - `Renderer.spriteLayer(key: string): number` — the atlas index for `key` if its texels are loaded, else `-1`.

- [ ] **Step 1: Add imports and module state**

At the top of `game/engine/renderer.ts`, add to the imports:

```ts
import { packSprites, uvRect } from "./spritePack";
import { SPRITE_ASSETS, spriteIndex } from "./spriteAssets";
```

Change the SHAPE enum (line 12) to add the base-offset sprite mode:

```ts
export const SHAPE = { rect: 0, circle: 1, glow: 2, ring: 3, tri: 4, hex: 5, slash: 6, sprite: 16 };
```

Near the other module-level `let`s (after line 69), add sprite state:

```ts
const MAX_SPRITES = 32; // must match instance.frag
const SPRITE_GUTTER = 2; // px between packed sprites; pairs with uvRect's half-texel inset
let u_sprites: WebGLUniformLocation | null;
let u_spriteRects: WebGLUniformLocation | null;
let atlasTex: WebGLTexture;
const spriteRects = new Float32Array(MAX_SPRITES * 4); // [u0,v0,uW,vH] * MAX_SPRITES, zero-init
const spriteReady: boolean[] = []; // per index, true once its texels are uploaded
```

- [ ] **Step 2: Create the always-complete atlas texture at init and grab uniform locations**

In `init()`, right after the `u_dim` location line (line 144), add:

```ts
  u_sprites = gl.getUniformLocation(instProg, "u_sprites");
  u_spriteRects = gl.getUniformLocation(instProg, "u_spriteRects");
  // 1x1 transparent atlas so the sampler is COMPLETE from frame 0 (before art loads / if none).
  atlasTex = gl.createTexture() as WebGLTexture;
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
```

Then, at the very end of `init()` (after the last setup line in the function), kick off the async load:

```ts
  void loadSprites();
```

- [ ] **Step 3: Add the loader, writer, and layer lookup**

Add these functions near the other writers (e.g. after the `sprite` function ~line 298):

```ts
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`sprite load failed: ${url}`));
    img.src = url;
  });
}

/**
 * Load every discovered PNG, pack them deterministically in glob-index order (NOT completion
 * order), upload into one atlas, and record half-texel-inset UV rects. ready flips per index only
 * after its texels are uploaded, so the draw side never emits an index the shader can't sample.
 */
async function loadSprites(): Promise<void> {
  if (SPRITE_ASSETS.length === 0) return;
  const imgs = await Promise.all(SPRITE_ASSETS.map((a) => loadImage(a.url)));
  const sizes = imgs.map((im) => ({ w: im.width, h: im.height }));
  const maxAtlas = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const packed = packSprites(sizes, SPRITE_GUTTER, maxAtlas);

  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    packed.atlas,
    packed.atlas,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  for (let i = 0; i < imgs.length && i < MAX_SPRITES; i++) {
    const r = packed.rects[i];
    const im = imgs[i];
    if (!r || !im) continue;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, gl.RGBA, gl.UNSIGNED_BYTE, im);
    spriteRects.set(uvRect(r, packed.atlas), i * 4);
    spriteReady[i] = true;
  }
}

function spriteQuad(
  x: number,
  y: number,
  w: number,
  h: number,
  rot: number,
  index: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  write(normal, x, y, w, h, rot, r, g, b, a, SHAPE.sprite + index);
}

function spriteLayer(key: string): number {
  const i = spriteIndex(key);
  return i >= 0 && spriteReady[i] ? i : -1;
}
```

- [ ] **Step 4: Bind the atlas + upload the rects in `flush()`**

In `flush()`, after the `gl.uniform1f(u_dim, gradeDim);` line (just before `// normal pass ...` at line 487) and while `instProg` is the active program, add:

```ts
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.uniform1i(u_sprites, 0);
  gl.uniform4fv(u_spriteRects, spriteRects);
```

- [ ] **Step 5: Export the new methods**

In the `Renderer` export object (line 516), add `spriteQuad` and `spriteLayer`:

```ts
  sprite,
  spriteQuad,
  spriteLayer,
  circle,
```

- [ ] **Step 6: Verify build + lint + a runtime sanity check**

Run: `bun run typecheck && bun run build`
Expected: both succeed.

Run: `bun run dev`, open http://localhost:5173, start a run, open the browser console.
Expected: no WebGL errors/warnings about incomplete textures or `u_spriteRects`; the game renders exactly as before (no sprite is drawn yet — Task 6 wires that). If the console is clean and the game looks unchanged, the atlas/sampler wiring is safe.

- [ ] **Step 7: Commit**

```bash
git add game/engine/renderer.ts
git commit -m "feat(engine): sprite atlas texture, loader, spriteQuad/spriteLayer, flush binding"
```

---

### Task 5: Data — add the sprite key to the enemy table

**Files:**
- Modify: `game/types.ts:59-80` (the `EnemyType` interface)
- Modify: `game/data/enemies.ts:5-19` (the `walker` entry)

**Interfaces:**
- Consumes: nothing (a plain data field).
- Produces: `EnemyType.sprite?: string` populated as `"zombie"` on `walker` (matches the `spriteAssets` key derived from `zombie.png`).

- [ ] **Step 1: Add the field to `EnemyType`**

In `game/types.ts`, inside `interface EnemyType`, after the `shape: number;` line (line 67), add:

```ts
  /** optional sprite-atlas key (a game/assets/sprites/<key>.png); when present and loaded, the
   *  renderer draws this illustration instead of the SDF `shape`. Draw-time only, never synced. */
  sprite?: string;
```

- [ ] **Step 2: Set it on the walker**

In `game/data/enemies.ts`, in the `walker` object, add after `shape: SHAPE.circle,` (line 13):

```ts
    sprite: "zombie",
```

- [ ] **Step 3: Verify typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add game/types.ts game/data/enemies.ts
git commit -m "feat(data): walker enemy gets a sprite key"
```

---

### Task 6: Draw — use the sprite when ready, drop the ring for sprite zombies

**Files:**
- Modify: `game/game.ts` (imports block ~line 2–33; zombie draw ~line 519–525)

**Interfaces:**
- Consumes: `Renderer.spriteQuad`, `Renderer.spriteLayer` (Task 4); `ENEMY_TYPES[...].sprite` (Task 5).
- Produces: nothing (final consumer).

- [ ] **Step 1: Import `ENEMY_TYPES`**

In `game/game.ts`, add near the other `data/` imports (after line 15):

```ts
import { ENEMY_TYPES } from "./data/enemies";
```

- [ ] **Step 2: Branch the zombie body draw to the sprite**

In `game/game.ts`, the body is drawn at lines 520–525:

```ts
    if (z.shape === SHAPE.tri) R.tri(zx, zy, rad, face, col[0], col[1], col[2], grow);
    else if (z.shape === SHAPE.hex)
      R.hex(zx, zy, rad, state.time * 0.6 + z.wob, col[0], col[1], col[2], grow);
    else R.circle(zx, zy, rad, col[0], col[1], col[2], grow);
    // dark silhouette outline
    R.ring(zx, zy, rad * 1.04, 0.02, 0.03, 0.02, 0.7 * grow);
```

Replace that whole block with:

```ts
    const spriteKey = ENEMY_TYPES[z.type]?.sprite;
    const layer = spriteKey ? R.spriteLayer(spriteKey) : -1;
    if (layer >= 0) {
      // wound-tinted color (wr/wg/wb) is the normal-pass multiply; darkness/flashlight come free.
      // No silhouette ring: it is a circle and would mis-overlap a non-circular illustration.
      R.spriteQuad(zx, zy, rad * 2, rad * 2, face, layer, col[0], col[1], col[2], grow);
    } else {
      if (z.shape === SHAPE.tri) R.tri(zx, zy, rad, face, col[0], col[1], col[2], grow);
      else if (z.shape === SHAPE.hex)
        R.hex(zx, zy, rad, state.time * 0.6 + z.wob, col[0], col[1], col[2], grow);
      else R.circle(zx, zy, rad, col[0], col[1], col[2], grow);
      // dark silhouette outline
      R.ring(zx, zy, rad * 1.04, 0.02, 0.03, 0.02, 0.7 * grow);
    }
```

(The glow above this block and the glowing eyes below it are left untouched — they still draw over the sprite, which is a deliberate feel finding for Task 7.)

- [ ] **Step 3: Verify build + lint**

Run: `bun run typecheck && bun run lint && bun run build`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add game/game.ts
git commit -m "feat(game): draw walker zombies as a sprite when the atlas is ready"
```

---

### Task 7: Feel verification (the verdict)

**Files:** none (playtest). This is the deliverable that gates whether sprites proceed.

**Interfaces:**
- Consumes: the running game with the real zombie art in place (Task 2 — swap out any placeholder first).
- Produces: a written verdict.

- [ ] **Step 1: Ensure the real art is in place**

Confirm `game/assets/sprites/zombie.png` is the actual illustration (not the placeholder). If you used the placeholder, replace it now and rebuild.

- [ ] **Step 2: Run and play a night**

Run: `bun run dev`, open http://localhost:5173, deploy into a night, and get walker zombies around you inside and outside the flashlight cone; shoot some; let HP drop.

- [ ] **Step 3: Judge against the 5 exit criteria (from the spec)**

Look, specifically:
1. **Crisp** — hard pixels, no blur; no bright/dark fringe at the sprite edges (gutter/inset working).
2. **Oriented** — the zombie faces the player and rotates naturally as it moves; not upside-down. If upside-down, flip the one `VFLIP` line in `instance.frag` (Task 3 Step 2) from `0.5 - v_local.y` to `v_local.y + 0.5` and rebuild.
3. **Sinks & lifts** — a zombie outside the cone is black/invisible; sweeping the flashlight over it reveals it. It must NOT self-illuminate.
4. **Grades** — as HP drops, the sprite desaturates/darkens with the world (blood-vignette grade), same as before.
5. **Damage reads** — wound tint is visible on the illustration and a hit gives feedback (glow-flash + blood), and critically a hit on a zombie OUTSIDE the cone does not light it up.

- [ ] **Step 4: Record the verdict**

Write the outcome (which criteria passed/failed, screenshots if useful) into the PR description or a short note. 

- **Hit** (feels good): the mechanism is done — scaling is adding PNGs + `sprite:` keys. Proceed to open the PR.
- **Miss** (sticker / wrong feel): the mechanism stays but goes unused. Set `walker.sprite` back to unset (revert Task 5 Step 2) so the game ships on the SDF shape, keep the engine capability, and pursue the SDF-enhancement route for zombies in a separate effort. Note exactly which criterion failed so that decision is grounded.

- [ ] **Step 5 (if Hit): finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to open the PR against `main`.

---

## Self-Review

**1. Spec coverage:**
- Variable-size atlas + UV rect table → Task 1 (`packSprites`/`uvRect`), Task 4 (upload). ✓
- `SHAPE.sprite = 16` base-offset gap, 10-float layout unchanged → Task 4 Step 1 (SHAPE), Task 3 (branch). ✓
- Color feedback: wound = normal-pass multiply; no additive flash draw; hit rides glow-flash + blood → Task 6 Step 2 (passes `col` = `wr/wg/wb`; ring dropped; glow/eyes untouched). ✓
- 1×1 dummy/complete sampler from frame 0 → Task 4 Step 2. ✓
- Deterministic glob-index packing, gutter + half-texel inset → Task 1 (order + `uvRect`), Task 4 Step 3 (index-order loop). ✓
- `u_spriteRects[32]` fixed, zero-init, ready-only indices → Task 4 Step 1 (zero-init `spriteRects`, `spriteReady`), Task 6 (`spriteLayer` returns −1 until ready). ✓
- glob `?url`, filename-stable index → Task 2. ✓
- Data-driven sprite key → Task 5. ✓
- VFLIP as an on-device knob → Task 3 Step 2 + Task 7 Step 3(2). ✓
- Atlas scale limit (`MAX_TEXTURE_SIZE`) → Task 4 (`packSprites` throws over budget; `maxAtlas` from `MAX_TEXTURE_SIZE`). ✓
- 5 exit criteria playtest → Task 7. ✓
- Single-player byte-for-byte → no `update()`/snapshot/layout edits in any task. ✓

**2. Placeholder scan:** No TBD/TODO. The `VFLIP` choice and the asset-processing `magick` fuzz values are genuine on-device/source-dependent decisions, called out explicitly (not hidden placeholders). Real code shown in every code step.

**3. Type consistency:** `packSprites(sizes, gutter, maxAtlas)` / `uvRect(rect, atlas)` used with matching signatures in Task 4. `SHAPE.sprite = 16`; `spriteQuad` writes `SHAPE.sprite + index`; shader reads `s - 16` → consistent. `spriteLayer(key)`/`spriteIndex(key)` names consistent across Tasks 2/4/6. `sprite?: string` key `"zombie"` matches the `zombie.png` filename-derived key. `u_sprites`/`u_spriteRects`/`MAX_SPRITES = 32` identical in Task 3 (shader) and Task 4 (renderer).
