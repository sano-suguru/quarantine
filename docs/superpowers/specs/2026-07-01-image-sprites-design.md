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
The verdict then gates only how much **art** we add, never a rebuild of the mechanism — bounded by
one honest limit: a single atlas holds only so much (see Scope & limits).

### Success / exit criteria (feel verdict)

Play a night with the zombie sprite and judge:

1. **Crisp** — hard pixels, no filtering blur (`gl.NEAREST`).
2. **Oriented** — top-down art rotates naturally to face the player (`face`); no side-view break.
3. **Sinks & lifts** — fully dark outside the cone, lit inside it (shares `lightAt`).
4. **Grades** — follows the HP desaturation/dim grade (`u_sat`/`u_dim`) like every other entity.
5. **Damage reads** — wound accumulation (normal-pass multiply toward blood) and hit feedback
   (glow-flash + blood fx) are legible **on the illustration** and, critically, a hit on a zombie
   **outside the cone does not light it up** in the dark. Gore feedback is a product core (see the
   recent combat-gore work), so a sprite that can't show damage — or that leaks lurkers on hit —
   fails even if it looks great standing still.

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
| Color feedback (wound-tint, hit-flash) needs a shader term not designed | Wound-tint via `v_color` **multiply** in the **normal** pass (darken + shift toward blood; `u_emissive 0` so it still goes black outside the cone). Hit-flash is **not** a separate sprite draw — an additive-pass sprite would carry the `u_emissive` floor and **light the zombie in the dark when shot** (lurker reveal, breaks the sink-into-darkness feel). Instead hit feedback rides the **existing glow-flash** (the zombie glow alpha already boosts by `fl`, game.ts ~L517) **+ blood particles/decals** — the established feedback channels, same dark behavior as today. No new per-instance float, no dark leak. |
| Sampler incomplete before art loads → whole instanced draw affected | **1×1 transparent dummy texture bound at init**, always complete (see Safety). |

## Scope & limits

"Rebuild-proof" is honest **within one bound**: all sprites share a single `TEXTURE_2D` atlas, so
total packed area is capped by `GL_MAX_TEXTURE_SIZE²`. For the expected art scale (enemy types,
player, a modest set of props/walls at pixel-art sizes) this is ample and adding art is pure
addition. If the game ever needs *more* sprite area than one max-size atlas holds, going to
multiple atlases would touch the sampler/draw path — that is a **deliberate out-of-scope** future,
called out here rather than discovered later. This design does not build multi-atlas support.

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
    **Await all discovered PNGs** (`Promise.all` over `Image`/`createImageBitmap`), then pack in
    **stable glob-index order** (never load-completion order — otherwise index↔rect drifts
    non-deterministically), upload each via `gl.texSubImage2D` and record its UV rect. Each
    sub-rect gets a **1–2px gutter** and the recorded UV is **half-texel inset**, so `NEAREST`
    sampling never bleeds a neighbor's texels into a sprite edge (crisp is an exit criterion — this
    matters). Flip `ready` **once**, after the whole atlas is packed. **Atlas scale limit:** a
    single `TEXTURE_2D` is bounded by `GL_MAX_TEXTURE_SIZE` (WebGL2 floor 2048; commonly 4096–16384);
    total packed area must fit. See "Scope & limits" — beyond that is out of scope, not a silent
    truncation.
  - Bind the atlas texture to a unit and set the `u_sprites` sampler + `u_spriteRects` uniform once
    per `flush()`. Bind a **1×1 transparent dummy** at init so the sampler is complete from frame 0.
  - **`u_spriteRects[MAX_SPRITES]`**: fix `MAX_SPRITES` small (e.g. 32) and document it against the
    fragment uniform-vector budget; **zero-init every rect** so an out-of-range/unloaded index
    samples an empty rect (ES3 dynamic uniform-array indexing is legal but out-of-range is
    undefined and a known mobile-driver footgun). The draw side only emits `shape = 16 + index` for
    a **ready** index (else SDF fallback), so the shader never receives an unpacked index — the
    zero-init is the belt-and-suspenders backstop.
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
  wb, grow)` — passing the **wound-tinted** color (existing `wr/wg/wb`) as the normal-pass multiply
  tint. **No separate hit-flash sprite draw** (an additive one would light lurkers in the dark, see
  the color-feedback row); the existing glow-flash (`z.flash` already boosts the glow alpha) and
  blood fx carry the hit read. Else fall back to the existing SDF shape. **Drop the silhouette ring
  for sprite-drawn zombies** (it is a normal-pass circle drawn over the body and will mis-overlap a
  non-circular illustration). Keep the surrounding glow and glowing eyes (additive) — whether they
  compose with the illustration is a real feel finding worth seeing.

### Data flow

Startup → `spriteAssets` glob yields `{zombie: url}` + index 0 → renderer loads the PNG, packs it
into the atlas, records its UV rect, sets ready. Each `draw()` → per zombie, ready + `def.sprite`
present → `spriteQuad(... index 0 ...)` (wound tint, normal pass); else SDF shape. Hit feedback is
the existing glow-flash + blood fx (unchanged). `flush()` binds `u_sprites`/`u_spriteRects`, one
instanced draw per layer. Fragment: `s >=
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
  sharing `lightAt`/grade; wound-multiply (normal pass) + the existing glow-flash/blood fx keep gore
  feedback without a dark leak. If flat art still fights the world → verdict is "no", mechanism
  stays unused, SDF route for zombies.
- **Gore legibility on a photo-ish texture** — a multiply wound-tint darkens/reddens but cannot
  brighten, and blood may not read on already-dark texels. This is exit criterion 5, judged by
  feel; if wound doesn't read, a per-instance wound scalar (a layout float) is the known next lever
  — deliberately not added pre-verdict.
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
