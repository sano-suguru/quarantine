import { describe, expect, it } from "vitest";
import { ENEMY_TYPES } from "../../sim/data/enemies";
import { WEAPON_ORDER, WEAPONS } from "../../sim/data/weapons";
import { REQUIRED_SAMPLE_KEYS, sampleVariantCount } from "./audioAssets";

// Fixed (non-dynamic) one-shot/loop keys audio.ts always plays. Mirrors game/data/sfx.test.ts so
// the two guards agree on the required set.
const FIXED_KEYS = [
  "hit",
  "kill_big",
  "kill_small",
  "reload",
  "reload_done",
  "weapon_switch",
  "dry_fire",
  "hurt",
  "pickup",
  "heal",
  "repair",
  "click",
  "light_die",
  "dawn",
  "wave_start",
  "game_over",
  "ui_select",
  "ui_reject",
  "screech",
  "search",
  "amb_day",
  "amb_night",
];

// Rebuild the full required set from the SAME data the runtime uses (weapons → shot_<gun>/melee,
// enemies → groan_<type>), so REQUIRED_SAMPLE_KEYS can't silently drift when content is added.
const derived = new Set<string>(FIXED_KEYS);
for (const id of WEAPON_ORDER) {
  const w = WEAPONS[id];
  if (!w) continue;
  derived.add(w.melee ? "melee" : `shot_${id}`);
}
for (const type of Object.keys(ENEMY_TYPES)) derived.add(`groan_${type}`);

describe("required sample assets", () => {
  it("REQUIRED_SAMPLE_KEYS equals the keys the code actually plays", () => {
    expect(new Set(REQUIRED_SAMPLE_KEYS)).toEqual(derived);
  });

  // audio.ts has no synth fallback, so a dropped/renamed MP3 (registry variant count → 0) must fail
  // the build here rather than ship a silent one-shot.
  for (const key of REQUIRED_SAMPLE_KEYS) {
    it(`"${key}" has at least one variant in the registry`, () => {
      expect(sampleVariantCount(key)).toBeGreaterThanOrEqual(1);
    });
  }
});
