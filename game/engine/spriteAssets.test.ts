import { describe, expect, it } from "vitest";
import { REQUIRED_SPRITES, spriteIndex, unreadyRequiredSprites } from "./spriteAssets";

// Build-time guard: the eager import.meta.glob resolves the sprite set at bundle time, so a
// missing/renamed PNG silently drops its key (spriteIndex → -1) instead of erroring. The player
// has no runtime SDF fallback, so this test is the detection mechanism — it fails CI/pre-push if a
// required asset is gone, rather than shipping an invisible/weird character.
describe("required sprite assets", () => {
  for (const key of REQUIRED_SPRITES) {
    it(`"${key}" resolves to a packed atlas index`, () => {
      expect(spriteIndex(key)).toBeGreaterThanOrEqual(0);
    });
  }
});

describe("unreadyRequiredSprites", () => {
  it("returns empty when every required index reports ready", () => {
    expect(unreadyRequiredSprites(() => true)).toEqual([]);
  });

  it("returns every required key when none report ready", () => {
    expect(unreadyRequiredSprites(() => false)).toEqual([...REQUIRED_SPRITES]);
  });

  it("returns only the keys whose index is not ready", () => {
    const bruteIdx = spriteIndex("brute");
    expect(unreadyRequiredSprites((i) => i !== bruteIdx)).toEqual(["brute"]);
  });
});
