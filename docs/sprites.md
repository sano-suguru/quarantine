# Adding enemy sprites

Enemies are drawn either as procedural SDF shapes (default) or as a textured **sprite** when their
`ENEMY_TYPES[...].sprite` key resolves to a loaded atlas entry. The sprite system (atlas packing,
`game/engine/spriteAssets.ts` discovery, the `shape >= 16` shader branch) is already in place —
adding a sprite is just: **make the image → drop the PNG in → set the enemy's `sprite` key.**

There is intentionally **no API-generation script**: the nano-banana image model needs a paid
Gemini API tier (free-tier quota is 0), so we generate in the **Gemini chat** (free) and process the
image by hand. The prompts below are the reference.

## 1. Generate the image (Gemini chat)

Paste the **style anchor** + a **subject** line into the Gemini chat and download the result.

**Style anchor (use verbatim, every sprite):**

```
Top-down high-angle sprite of the creature, seen from above and slightly in front. The creature
advances toward the BOTTOM of the frame: its face and reaching hands point down, toward the viewer.
16-bit pixel art, pixel-perfect, crisp hard edges, no anti-aliasing, limited ~16-color palette.
FLAT even lighting, no baked shadows, no highlights, no rim light, neutral local color only (the
game applies its own flashlight lighting at runtime). Transparent background (alpha), single
centered subject, no ground shadow, no props, no text, no border. Full body fits within the frame
with a small margin. Dark survival-horror mood, grotesque but readable silhouette.
Subject: <SUBJECT>
```

**Two load-bearing rules — every sprite must obey both, or it looks wrong in-game:**

1. **Front toward the BOTTOM of the frame.** The renderer draws sprites as an upright billboard
   rotated so the image's bottom edge points at the player (`SPRITE_FACE_OFFSET` in `game/game.ts`,
   a single shared constant). If one sprite faces a different way than the others, it will aim
   wrong — keep all enemies facing/advancing toward the bottom.
2. **FLAT lighting, transparent background.** Baked shadows/highlights fight the game's runtime
   flashlight + desaturation and read as a pasted-on sticker; a non-transparent background shows as
   a box. (The earlier `bird's-eye / directly from above` phrasing also works **only if** the front
   still points down — but match the existing walker's oblique high-angle framing for a consistent
   set.)

**Subjects:**

- `zombie` (walker) — a shambling rotten zombie on all fours: hunched shoulders, long grasping
  outstretched arms, mottled grey-green decayed flesh, torn dark ragged clothing, a patchy exposed
  skull face, asymmetric decayed silhouette, grotesque but readable.
- `runner` — a lean feral runner zombie mid-lunge: emaciated, elongated sinewy arms, blood-streaked
  pale clammy body, tattered rags, a sharp aggressive silhouette, tinted colder blue-grey to read
  as a distinct faster enemy type.
- `brute` — a hulking brute zombie: enormous swollen muscled shoulders and arms, bloated red-brown
  diseased flesh, a small sunken head, thick trunk-like limbs, a heavy hunched menacing silhouette
  that reads as a tank enemy.

## 2. Process into a game-ready PNG

The atlas wants a small, square, hard-alpha PNG (no semi-transparent fringe under NEAREST). Process
the downloaded image (Python + Pillow):

```python
from PIL import Image
TARGET = 128
im = Image.open("<downloaded>.png").convert("RGBA")
# (if the background isn't already transparent, remove it first)
bbox = im.getbbox()
if bbox: im = im.crop(bbox)
w, h = im.size
s = TARGET / max(w, h)
im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.NEAREST)  # crisp downscale
r, g, b, a = im.split()
a = a.point(lambda v: 255 if v >= 128 else 0)                                # binarize alpha
im = Image.merge("RGBA", (r, g, b, a))
canvas = Image.new("RGBA", (TARGET, TARGET), (0, 0, 0, 0))                    # square pad (undistorted)
canvas.paste(im, ((TARGET - im.width) // 2, (TARGET - im.height) // 2), im)
canvas.save("game/assets/sprites/<key>.png")
```

Save it as `game/assets/sprites/<key>.png` — the filename (minus `.png`) is the sprite key.

## 3. Wire it to an enemy

In `game/data/enemies.ts`, set the enemy's `sprite` key to the filename:

```ts
runner: { ...,  sprite: "runner" },
```

`spriteAssets.ts` auto-discovers the PNG, the renderer packs it, and `game.ts` draws that enemy as
the sprite (falling back to its SDF `shape` until the atlas is ready). Then **playtest** — check
orientation (front points at the player), that it sinks in the dark, crispness, and wound/hit reads.
Tune `SPRITE_SCALE` / `SPRITE_FACE_OFFSET` / `SPRITE_FLASH` in `game/game.ts` if needed.
