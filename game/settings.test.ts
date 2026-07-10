import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOADOUT } from "./settings";

describe("settings loadout", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    // getSettings caches in-module; re-import fresh per test to drop the cache.
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to the starter 3-slot loadout", async () => {
    const { getSettings } = await import("./settings");
    expect(getSettings().loadout).toEqual(DEFAULT_LOADOUT);
  });
  it("clamps a set loadout to at most 3 ids", async () => {
    const { setLoadout } = await import("./settings");
    expect(setLoadout(["pistol", "smg", "shotgun", "rifle"])).toEqual(["pistol", "smg", "shotgun"]);
  });
  it("persists a set loadout", async () => {
    const { getSettings, setLoadout } = await import("./settings");
    setLoadout(["magnum", "knife"]);
    expect(getSettings().loadout).toEqual(["magnum", "knife"]);
  });
});
