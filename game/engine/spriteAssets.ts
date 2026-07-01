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
