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

/**
 * Sprites the game hard-depends on. The player has NO runtime SDF fallback (an invisible
 * operable character is worse than a hard failure), so a missing/renamed asset must be caught at
 * build time rather than degrading silently — `spriteAssets.test.ts` asserts each of these
 * resolves. Enemies additionally keep their SDF fallback, but we still require the assets so a
 * silently-dropped PNG fails CI instead of shipping.
 */
export const REQUIRED_SPRITES = ["player", "zombie", "runner", "brute", "stalker"] as const;

export function spriteIndex(key: string): number {
  return INDEX.get(key) ?? -1;
}

/**
 * Required sprites that are NOT usable yet: either missing from the glob (spriteIndex < 0) or
 * their atlas texels haven't uploaded (`isReady(index)` false). Empty = all required sprites ready.
 * The renderer's spritesReady() gate uses this so a broken/incomplete required set fails loud
 * instead of drawing an invisible player/enemy.
 */
export function unreadyRequiredSprites(isReady: (index: number) => boolean): string[] {
  return REQUIRED_SPRITES.filter((key) => {
    const i = spriteIndex(key);
    return i < 0 || !isReady(i);
  });
}
