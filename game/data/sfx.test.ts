import { describe, expect, it } from "vitest";
import { ENEMY_TYPES } from "./enemies";
import { SFX } from "./sfx";
import { WEAPON_ORDER, WEAPONS } from "./weapons";

/**
 * Drift guard between the SFX manifest (game/data/sfx.ts), the playback keys the code actually
 * requests (engine/audio.ts / game.ts), and the generated files on disk. The runtime doesn't
 * import the manifest (to keep prompts out of the bundle), so this is the one place that keeps
 * the three in lockstep — add a weapon/enemy or a new sound and a missing prompt/file fails here.
 */

// Every key the code can pass to playSample()/Audio.loop(), reconstructed from the same data the
// runtime uses. Dynamic: shot_<weapon> (non-melee), melee (melee weapons), groan_<enemyType>.
const FIXED_KEYS = [
  "hit",
  "kill_big",
  "kill_small",
  "reload",
  "reload_done",
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
  // loops
  "search",
  "amb_day",
  "amb_night",
];

const requiredKeys = new Set<string>(FIXED_KEYS);
for (const id of WEAPON_ORDER) {
  const w = WEAPONS[id];
  if (!w) continue;
  requiredKeys.add(w.melee ? "melee" : `shot_${id}`);
}
for (const type of Object.keys(ENEMY_TYPES)) requiredKeys.add(`groan_${type}`);

// keys that have at least one generated file on disk (<key>.mp3 or <key>_<n>.mp3), enumerated
// via the same Vite glob the runtime uses (no node:fs → no @types/node needed; works in vitest).
const sfxFiles = import.meta.glob("../audio/sfx/*.mp3");
const filePresentKeys = new Set<string>();
for (const path of Object.keys(sfxFiles)) {
  const base = (path.split("/").pop() ?? "").slice(0, -4);
  const m = base.match(/^(.+?)_(\d+)$/);
  filePresentKeys.add(m?.[1] ?? base);
}

const manifestKeys = new Set(Object.keys(SFX));

describe("sfx manifest ↔ code ↔ files", () => {
  it("every code-required key has a manifest entry", () => {
    const missing = [...requiredKeys].filter((k) => !manifestKeys.has(k));
    expect(
      missing,
      `keys used by code but absent from SFX manifest: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every code-required key has at least one generated file", () => {
    const missing = [...requiredKeys].filter((k) => !filePresentKeys.has(k));
    expect(
      missing,
      `keys used by code but with no mp3 in game/audio/sfx: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("manifest has no orphan keys (every entry is used by code)", () => {
    const orphans = [...manifestKeys].filter((k) => !requiredKeys.has(k));
    expect(orphans, `SFX entries not requested anywhere in code: ${orphans.join(", ")}`).toEqual(
      [],
    );
  });

  it("has no stray mp3 files without a manifest entry", () => {
    const stray = [...filePresentKeys].filter((k) => !manifestKeys.has(k));
    expect(stray, `mp3 files with no SFX entry: ${stray.join(", ")}`).toEqual([]);
  });

  it("loop entries declare a modelId (required by the loop API)", () => {
    const bad = Object.entries(SFX)
      .filter(([, s]) => s.loop && !s.modelId)
      .map(([k]) => k);
    expect(bad, `loop SFX missing modelId: ${bad.join(", ")}`).toEqual([]);
  });
});
