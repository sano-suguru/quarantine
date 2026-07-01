/**
 * Single source of truth for the game's generated enemy sprites: each key maps to a nano-banana
 * (Gemini 2.5 Flash Image) prompt. `scripts/gen-sprites.ts` reads this to generate + post-process
 * `game/assets/sprites/<key>.png`, where `engine/spriteAssets.ts` auto-discovers them and the
 * renderer packs them into one atlas.
 *
 * The `key` is the sprite-atlas key an enemy references via `ENEMY_TYPES[...].sprite` (e.g. the
 * walker's `sprite: "zombie"` → `zombie.png`).
 *
 * NOTE: this module is imported by the generator (Bun) only — NOT by the browser runtime — so the
 * prompt strings never reach the JS bundle (spriteAssets.ts does the runtime discovery instead).
 *
 * Generation is NON-DETERMINISTIC and costs API credits; existing PNGs are skipped unless --force.
 * Commit the generated PNGs to lock them in, then judge them by playing (feel-first).
 */

export type SpriteSpec = {
  /** the subject clause appended to SPRITE_STYLE to form the full nano-banana prompt. */
  prompt: string;
};

/**
 * Shared style/orientation anchor prepended to every subject. Orientation is load-bearing: the
 * renderer draws sprites as a billboard rotated so the illustration's BOTTOM edge is its front and
 * points at the target (game.ts SPRITE_FACE_OFFSET). So every sprite must face/lunge toward the
 * bottom of the frame, from a high top-down-ish angle, or it will point the wrong way in-game.
 * FLAT lighting is also load-bearing: the game applies its own flashlight cone + desaturation at
 * runtime, so baked shadows/highlights fight it and read as a pasted-on sticker.
 */
export const SPRITE_STYLE = [
  "Top-down high-angle view, looking down at the creature from above and slightly in front.",
  "The creature advances toward the BOTTOM of the frame: its face and reaching hands point down, toward the viewer.",
  "16-bit pixel art, pixel-perfect, crisp hard edges, no anti-aliasing, limited ~16-color palette.",
  "FLAT even lighting: no baked shadows, no highlights, no rim light — neutral local color only.",
  "Transparent background (alpha), single centered subject, no ground shadow, no props, no text, no border.",
  "Full body within the frame with a small margin. Dark survival-horror mood, grotesque but readable silhouette.",
].join(" ");

export const SPRITE_GEN: Record<string, SpriteSpec> = {
  // walker (ENEMY_TYPES.walker.sprite = "zombie")
  zombie: {
    prompt:
      "a shambling rotten zombie on all fours: hunched shoulders, long grasping outstretched arms, " +
      "mottled grey-green decayed flesh, torn dark ragged clothing, a patchy exposed skull face, " +
      "asymmetric decayed silhouette.",
  },
  // prospective additional enemy sprites — generate + wire to ENEMY_TYPES later (drop the PNG in
  // and set the enemy's `sprite` key). Kept here so `bun run gen:sprites` can produce them.
  runner: {
    prompt:
      "a lean feral runner zombie mid-lunge: emaciated, elongated sinewy arms, blood-streaked pale " +
      "clammy body, tattered rags, a sharp aggressive silhouette, tinted colder blue-grey to read " +
      "as a distinct faster enemy type.",
  },
  brute: {
    prompt:
      "a hulking brute zombie: enormous swollen muscled shoulders and arms, bloated red-brown " +
      "diseased flesh, a small sunken head, thick trunk-like limbs, a heavy hunched menacing " +
      "silhouette that reads as a tank enemy.",
  },
};
