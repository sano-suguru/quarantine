import { describe, expect, it } from "vitest";
import { spriteIndex } from "../engine/spriteAssets";
import { ENEMY_TYPES } from "./enemies";

// After the SDF draw path is removed, an enemy with no packed sprite would render invisible. This
// guard fails the build if any enemy's `sprite` key isn't in the atlas.
describe("enemy sprite coverage", () => {
  for (const [name, e] of Object.entries(ENEMY_TYPES)) {
    it(`enemy "${name}" (sprite "${e.sprite}") resolves to a packed atlas index`, () => {
      expect(spriteIndex(e.sprite)).toBeGreaterThanOrEqual(0);
    });
  }
});
