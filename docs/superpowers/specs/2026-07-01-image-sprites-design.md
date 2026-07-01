# Image sprites — feasibility spike (zombie), with a final-shape carrier

**Date:** 2026-07-01
**Status:** design approved, pending spec review → implementation plan

## Goal

Prove, by playing and feeling, whether replacing a zombie's procedural SDF body with a
Gemini-generated (nano-banana) illustration **works in this game's lighting**: does it stay
pixel-crisp, orient correctly top-down, sink into darkness outside the flashlight cone, light up
inside it, and follow the desaturation grade — i.e. **not read as a pasted-on sticker**.

This is the decisive feel question (CLAUDE.md "feel-first"): sprites are not worth pursuing if a
lit, desaturated horror world with a flat bright cutout floating on top looks wrong.

### Success / exit criteria (spike verdict)

Play a night and judge the zombie sprite on:

1. **Crisp** — hard pixels, no filtering blur (`gl.NEAREST`).
2. **Oriented** — top-down art rotates naturally to face the player (`face`), no side-view break.
3. **Sinks & lifts** — fully dark outside the flashlight cone, lit inside it (shares `lightAt`).
4. **Grades** — follows the HP desaturation/dim grade (`u_sat`/`u_dim`) like every other entity.

Hit → **go full pipeline**. Miss → **revert** the spike and pursue the SDF-enhancement route
instead. No half-measures.

## Scope

**In:** one hand-provided, background-removed zombie PNG, rendered as the zombie body under a new
sprite draw mode.

**Out (deferred, purely additive — must NOT require a rewrite to add later):**
- `scripts/gen-sprites.ts` generation automation (manual PNG for now).
- Multiple distinct sprites, player/wall/pickup sprites, per-type art.
- Color feedback on the sprite (HP wound-tint **and** the white hit-flash) — both are a
  lerp-to-color that a simple `v_color` multiply can't express (white × white = no change); they
  need a separate flash uniform or an additive term, added later as one piece.
- Texture atlas with variable-size sub-rects (not needed while sprites are same-size).

## Design principle for this spike: minimal feature, final-shape carrier

The feature is one zombie. The **mechanism** is built in its final shape so scaling is pure
addition (drop more PNGs, fill more data-table entries) with **zero changes** to the renderer,
shader instance layout, or draw logic. The three places a naive spike would force a rewrite, and
how each is pre-solved:

| Naive spike | Rewrite it would force | Final-shape carrier (built now) |
|---|---|---|
| Bind one texture | Can't distinguish N sprites → layout change or split draw pass | **`sampler2DArray`**; `shape` float encodes `7 + layer`. **10-float instance layout unchanged.** Scales to many layers. |
| Hardcoded `?url` import | Replace with glob discovery | `spriteAssets.ts` using `import.meta.glob` from day one (mirrors `engine/audioAssets.ts`); loader consumes a key→URL map. Add PNGs → auto-discovered. |
| Draw-side "all zombies → sprite" | Per-type/player art needs special-casing in draw | Sprite key lives in the **data table** (`ENEMY_TYPES` gets optional `sprite?: string`). Draw is one path: def has a sprite key → draw sprite layer; else → existing SDF shape. Data-driven, no special branch. |

### Constraint (agreed)

`sampler2DArray` requires **all sprites at one resolution** (standardize, e.g. 128×128). Desirable
for pixel-art consistency; the generation step downscales (nearest-neighbor) to the standard size,
so it is not a practical limit.

## Architecture

Rides the existing single instanced draw. The instance fragment shader already applies
`lightAt` (flashlight cone + personal pool + ambient) and the `u_sat`/`u_dim` grade to **every**
shape at the end of `main()` — so a sprite shape inherits all of it for free. This is the whole
reason the "sticker" risk is structurally mitigated, and why we extend the shape mechanism rather
than add a second textured pass (which would duplicate the lighting math). Precedent: `slash` was
added as shape 6 the same way (see memory: extend-the-mechanism-over-fake-with-primitives).

### Components

- **`game/assets/sprites/zombie.png`** *(new)* — background-removed, standardized-size zombie
  illustration, drawn from directly above, flat/neutral lighting (no baked shadows/highlights).

- **`game/engine/spriteAssets.ts`** *(new)* — pure module: `import.meta.glob` over
  `assets/sprites/*.png` → an ordered `key → url` map and a stable `key → layer index` assignment.
  No GL, no fetch at import (mirrors `audioAssets.ts` purity). Consumed by the renderer's loader.

- **`game/engine/renderer.ts`** *(edit)*
  - `SHAPE.sprite = 7` (base). A sprite instance's `shape` value is `7 + layer`.
  - Async loader: fetch each discovered PNG into an `Image`, upload as one layer of a
    `TEXTURE_2D_ARRAY` (`gl.NEAREST` min/mag, no mipmaps, clamp-to-edge). Track a "ready" flag.
    Spike: 1 layer; scales by loading more layers, same code.
  - Bind the array texture to a unit and set the `u_sprites` sampler once per `flush()`.
  - `spriteQuad(x, y, size, rot, layer, r, g, b, a)` writer → pushes to the **normal** (non-additive)
    buffer with `shape = 7 + layer` (so it darkens fully outside the cone, like the current body).

- **`game/engine/shaders/instance.frag`** *(edit)* — add `uniform highp sampler2DArray u_sprites;`
  and, for `s >= 7`: `vec2 uv = v_local + 0.5;` (flip Y to match the vertex Y-flip),
  `vec4 t = texture(u_sprites, vec3(uv, float(s - 7)));`, `if (t.a < 0.5) discard;`,
  `frag = vec4(t.rgb, t.a) * v_color;` (tint multiply; spike passes **white** so the illustration
  shows true — color feedback like wound-tint/hit-flash is deferred, see Scope). The trailing
  `lightAt`/`u_sat`/`u_dim` lines apply unchanged.
  `instance.vert` needs no change (`v_local = a_quad` already carries local quad coords for UV).

- **`game/data/enemies.ts`** *(edit)* — add optional `sprite?: string` to the enemy type def; set it
  on the basic zombie only for the spike. (Type addition in `types.ts` as needed.)

- **`game/game.ts`** *(edit)* — in the zombie body draw (currently the tri/hex/circle branch,
  ~L520–523): if the enemy def has a `sprite` key **and** the renderer reports its texture ready,
  call `spriteQuad(zx, zy, rad*2, face, layer, 1, 1, 1, grow)` (white tint); otherwise fall back to
  the existing SDF shape. Keep the surrounding glow, silhouette ring, and glowing eyes as-is
  (whether they compose with the illustration is itself a spike finding). Sprite color feedback
  (wound-tint + hit-flash) deferred per Scope.

### Data flow

Startup → `spriteAssets` glob yields `{zombie: url}` and layer 0 → renderer loads the PNG into
`TEXTURE_2D_ARRAY` layer 0, sets ready. Each `draw()` → per zombie, ready + def.sprite present →
`spriteQuad(... layer 0 ...)`, else SDF shape. `flush()` binds `u_sprites`, one instanced draw.
Fragment: `s >= 7` samples layer `s-7`; all shapes then get `lightAt` × grade.

## Single-player & co-op safety

Draw-only + shader change. `update()`, snapshots, and `z.shape`/sim state are untouched — the
sprite is chosen at draw time from the enemy def, not stored or synced. Single-player stays
byte-for-byte; co-op unaffected (clients draw from the same def + interpolated positions).

## Testing

No unit tests — this is renderer/feel work, explicitly outside the unit-tested pure-logic scope
(CLAUDE.md). `spriteAssets.ts` is trivially pure (glob → map) and could get a smoke test if it
grows logic, but not required for the spike. Verification is **playtesting against the four exit
criteria above**, plus `bun run typecheck` / `bun run lint` / `bun run build` green.

## Open risks

- **Sticker read** — the core risk the spike exists to answer. Mitigated structurally by sharing
  `lightAt`/grade; the tint-multiply keeps hit-flash. If the flat art still fights the world, that
  is the verdict → SDF route.
- **Glowing eyes / ring over an illustrated face** may clash. Kept for the spike deliberately to
  surface the finding; easy to drop per-entity later.
- **Orientation** — art must be drawn top-down; a side-view illustration breaks under `face`
  rotation. Enforced at generation time, not in code.
