# Image sprites — final-form sprite system, seeded with one zombie for the feel verdict

**Date:** 2026-07-01
**Status:** design revised after rubber-duck review; pending spec review → implementation plan

## Goal

Give the engine a **rebuild-proof sprite-rendering system** and seed it with one Gemini-generated
(nano-banana) zombie illustration, so we can answer the decisive feel question by playing:
does a textured illustration **survive this game's lighting** — pixel-crisp, oriented top-down,
sinking into darkness outside the flashlight cone, lifting inside it, following the desaturation
grade — or does it read as a **pasted-on sticker** (CLAUDE.md "feel-first, playtest-verified")?

**Scope decision (chosen by the user, after a rubber-duck review flagged that a half-carrier would
still need rework):** build the *true* final form now — variable-size atlas, per-sprite color
feedback, data-table-driven sprite keys — not a throwaway spike and not a same-size-only carrier.
The verdict then gates only how much **art** we add, never a rebuild of the mechanism.

### Success / exit criteria (feel verdict)

Play a night with the zombie sprite and judge:

1. **Crisp** — hard pixels, no filtering blur (`gl.NEAREST`).
2. **Oriented** — top-down art rotates naturally to face the player (`face`); no side-view break.
3. **Sinks & lifts** — fully dark outside the cone, lit inside it (shares `lightAt`).
4. **Grades** — follows the HP desaturation/dim grade (`u_sat`/`u_dim`) like every other entity.

Hit → add more art (more PNGs + data entries), the mechanism is done. Miss → the mechanism stays
but goes unused; pursue the SDF-enhancement route for zombies instead.

## Why this is the true final form (not a half-carrier)

A rubber-duck review established that the engine has **no texture support today** (grep: zero
`bindTexture`/`sampler`/`texImage*` — the renderer is instance-VBO only), so this is the engine's
first texture. It also established that a `sampler2DArray` "carrier" is only final for same-size
enemy art and would force rework for walls/players (different aspect ratios) and for color
feedback. This design closes each of those so the mechanism never needs rebuilding:

| Rework risk a naive carrier leaves | Closed here by |
|---|---|
| Same-size-only (`sampler2DArray`) breaks on wall/player aspect ratios | **Single atlas + per-sprite UV sub-rect** (`uniform vec4 u_spriteRects[]`); each rect any size. On-screen aspect set by the caller's `sx,sy`, so no distortion for any entity. |
| `shape` float overloaded as `7+layer` collides with future SDF shape types | **Base-offset gap:** `SHAPE.sprite = 16`; shape types keep 0–15, sprite atlas index is `shape − 16`. **Instance layout stays 10 floats** — no shared-buffer bandwidth change, single-player byte-for-byte trivially preserved. |
| Color feedback (wound-tint, hit-flash) needs a shader term not designed | Wound-tint via `v_color` **multiply** (normal pass); hit-flash via a **second additive-pass draw** of the same sprite tinted `(fl,fl,fl)` — the additive `SRC_ALPHA,ONE` blend adds the lit sprite scaled by flash (a brighten-flash; exact tone tuned on feel, not a pure-white silhouette). Reuses the existing two-pass structure; no new per-instance float. |
| Sampler incomplete before art loads → whole instanced draw affected | **1×1 transparent dummy texture bound at init**, always complete (see Safety). |

## Architecture

Everything rides the existing single instanced draw (`flush` → one `drawArraysInstanced` per
layer: `normal`, then `additive`). The instance fragment shader already applies `lightAt`
(flashlight cone + personal pool + ambient) and the `u_sat`/`u_dim` grade to **every** instance at
the end of `main()`, so a sprite inherits all of it for free — this is why the "sticker" risk is
structurally mitigated and why we extend the shape mechanism rather than add a second textured pass
that would duplicate the lighting math (precedent: `slash` added as shape 6; memory
extend-mechanism-over-fake-with-primitives).

Verified facts this rests on: `QUAD` is `[-0.5, 0.5]` (renderer.ts:97) and `v_local = a_quad`
(instance.vert:17), so `v_local + 0.5` is a correct `[0,1]` unit UV; `flush` issues one
`drawArraysInstanced` over the whole `normal` layer (renderer.ts:449, 484–486), so the sprite
sampler is part of the shader every normal-pass instance runs through — hence the dummy-texture
requirement below.

### Components

- **`game/assets/sprites/*.png`** *(new)* — background-removed, top-down, flat/neutral-lit
  illustrations (no baked shadows/highlights). One `zombie.png` for now. Any size (atlas is
  variable-size); nearest-neighbor downscale at generation keeps pixels crisp.

- **`game/engine/spriteAssets.ts`** *(new)* — pure module: `import.meta.glob("../assets/sprites/*.png",
  { query: "?url", import: "default", eager: true })` → an ordered `key → url` map plus a stable
  `key → atlas index` assignment. `?url` is explicit (matches `audioAssets.ts`) so small PNGs are
  **not** base64-inlined and the loader can `fetch`/`Image`-load them. No GL, no fetch at import.

- **`game/engine/renderer.ts`** *(edit)*
  - `SHAPE.sprite = 16` (base). A sprite instance's `shape` value is `16 + atlasIndex`.
  - **Atlas build:** create one `TEXTURE_2D` (`gl.NEAREST` min/mag, no mipmaps, clamp-to-edge).
    Load each discovered PNG (`Image`/`createImageBitmap`), row-pack by loaded size, upload each
    via `gl.texSubImage2D` into its sub-region, and record its UV rect `(x, y, w, h)` in a
    `u_spriteRects` array. No 2D canvas, no build step; individual PNGs stay separate files (reroll
    one by replacing its file). Track a `ready` flag / per-index ready.
  - Bind the atlas texture to a unit and set the `u_sprites` sampler + `u_spriteRects` uniform once
    per `flush()`. Bind a **1×1 transparent dummy** at init so the sampler is complete from frame 0.
  - `spriteQuad(x, y, w, h, rot, index, r, g, b, a)` writer → `shape = 16 + index`, pushed to the
    **normal** buffer (so it darkens fully outside the cone). A sibling that pushes to **additive**
    for the hit-flash overlay.

- **`game/engine/shaders/instance.frag`** *(edit)* — add `uniform sampler2D u_sprites;` and
  `uniform vec4 u_spriteRects[MAX_SPRITES];`. For `s >= 16`:
  `int i = s - 16; vec4 rc = u_spriteRects[i]; vec2 uv = rc.xy + vec2(v_local.x + 0.5, VFLIP) * rc.zw;`
  `vec4 t = texture(u_sprites, uv); if (t.a < 0.5) discard; frag = vec4(t.rgb, t.a) * v_color;`
  where `VFLIP` is `0.5 - v_local.y` **or** `v_local.y + 0.5` — **decided on device** (see risk;
  the vertex `-clip.y` flip and texture V-origin interact, so orientation is verified by looking,
  not asserted here). The trailing `lightAt`/`u_sat`/`u_dim` lines apply unchanged. `instance.vert`
  needs no change.

- **`game/data/enemies.ts`** *(edit)* — add optional `sprite?: string` (an `spriteAssets` key) to
  the enemy type def; set it on the basic zombie only. (`types.ts` gets the field.)

- **`game/game.ts`** *(edit)* — in the zombie body draw (~L520–523): if the enemy def has a
  `sprite` key and that atlas index is ready, `spriteQuad(zx, zy, rad*2, rad*2, face, index, wr, wg,
  wb, grow)` — passing the **wound-tinted** color (existing `wr/wg/wb`) as the multiply tint — and,
  when `z.flash > 0`, a second **additive** sprite draw tinted `(fl, fl, fl)` with `alpha = grow`
  for the brighten-flash. Else fall back to the existing SDF shape. **Drop the silhouette ring for
  sprite-drawn zombies** (it is a normal-pass circle drawn over the body and will mis-overlap a
  non-circular illustration). Keep the surrounding glow and glowing eyes (additive) — whether they
  compose with the illustration is a real feel finding worth seeing.

### Data flow

Startup → `spriteAssets` glob yields `{zombie: url}` + index 0 → renderer loads the PNG, packs it
into the atlas, records its UV rect, sets ready. Each `draw()` → per zombie, ready + `def.sprite`
present → `spriteQuad(... index 0 ...)` (wound tint) + optional additive flash quad; else SDF
shape. `flush()` binds `u_sprites`/`u_spriteRects`, one instanced draw per layer. Fragment: `s >=
16` samples the atlas rect for index `s-16`; all instances then get `lightAt` × grade.

## Single-player & co-op safety

Instance layout unchanged (10 floats) and `update()`/snapshots/`z.shape` untouched — the sprite is
chosen at draw time from the enemy def, not stored or synced. Single-player stays byte-for-byte;
co-op unaffected (clients draw from the same def + interpolated positions). The added
`u_sprites`/`u_spriteRects` uniforms and the dummy texture are pure render state.

## Testing

No unit tests — renderer/feel work, outside the pure-logic unit-tested scope (CLAUDE.md).
`spriteAssets.ts` is trivially pure (glob → map + index); a smoke test is optional if it grows
logic. Verification is **playtesting against the four exit criteria**, plus `bun run typecheck` /
`lint` / `build` green.

## Open risks

- **Sticker read** — the core question the seed sprite exists to answer. Mitigated structurally by
  sharing `lightAt`/grade; wound-multiply + additive-flash keep gore feedback. If flat art still
  fights the world → verdict is "no", mechanism stays unused, SDF route for zombies.
- **UV V orientation** — the vertex `-clip.y` flip vs texture V-origin means up/down must be
  confirmed on device; the shader keeps `VFLIP` as the one knob to flip. Directly tied to the
  "oriented/crisp" criteria, so verified by looking, not assumed.
- **Glowing eyes over an illustrated face** may clash — kept deliberately to surface the finding;
  trivial to drop per-entity later.
- **Orientation of the art** — must be drawn top-down; a side-view illustration breaks under
  `face` rotation. Enforced at generation time.
- **HMR** — replacing a PNG won't hot-reload the GL texture (glob eager loads once). During feel
  tuning, a full reload is fine for the spike; an `import.meta.hot` re-upload hook can be added if
  art iteration gets painful. Noted, not built now.
