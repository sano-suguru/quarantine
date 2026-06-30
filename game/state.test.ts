import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "./config";
import { HOME, POIS } from "./data/map";
import { STARTER_WEAPONS } from "./data/weapons";
import { allocId, newState } from "./state";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newState", () => {
  it("starts a fresh run on day 1 with the lit day phase", () => {
    const s = newState();
    expect(s.day).toBe(1);
    expect(s.phase).toBe("day");
    expect(s.phaseT).toBe(CONFIG.siege.dayDuration);
    expect(s.running).toBe(false);
    expect(s.kills).toBe(0);
    expect(s.nextId).toBe(1);
  });

  it("seeds a single local player at the origin with a fresh individual wallet", () => {
    const s = newState();
    expect(s.players.length).toBe(1);
    const p = s.players[0];
    expect(p?.id).toBe(0);
    expect(p?.x).toBe(0);
    expect(p?.y).toBe(0);
    expect(s.localId).toBe(0);
    // per-player economy (individual wallets) starts neutral
    expect(p?.money).toBe(0);
    expect(p?.dmgMul).toBe(1);
    expect(p?.fireRateMul).toBe(1);
    expect(p?.reserveMul).toBe(1);
    expect(p?.wlevel).toEqual({});
  });

  it("boards every HOME opening at full hp and builds the cache set (one per POI + the HOME-edge cache)", () => {
    const s = newState();
    expect(s.barricades.length).toBe(HOME.openings.length);
    expect(s.barricades.every((b) => b.hp === CONFIG.siege.boardMaxHp)).toBe(true);
    expect(s.caches.length).toBe(POIS.length + 1);
    expect(s.caches.every((c) => !c.looted && c.searchT === 0)).toBe(true);
  });

  it("owns the starter weapons but not the meta-locked ones (no meta unlocked)", () => {
    const s = newState();
    for (const id of STARTER_WEAPONS) expect(s.owned[id]).toBe(true);
    expect(s.owned.rifle).toBeFalsy(); // rifle is unlocked via SALVAGE, not a starter
  });

  it("adds meta-unlocked weapons to owned when localStorage carries them", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ version: 1, salvage: 0, unlocked: { rifle: true } }),
      setItem: () => {},
    });
    const s = newState();
    expect(s.owned.rifle).toBe(true);
    // starters still owned alongside the unlock
    expect(s.owned.pistol).toBe(true);
  });

  it("splits card: unlocks into unlockedCards, weapon unlocks into owned", () => {
    vi.stubGlobal("localStorage", {
      getItem: () =>
        JSON.stringify({
          version: 1,
          salvage: 0,
          unlocked: { rifle: true, "card:scavenger": true },
        }),
      setItem: () => {},
    });
    const s = newState();
    vi.unstubAllGlobals();
    expect(s.owned.rifle).toBe(true);
    expect(s.owned["card:scavenger"]).toBeUndefined(); // not a weapon
    expect(s.unlockedCards["card:scavenger"]).toBe(true);
  });
});

describe("allocId", () => {
  it("hands out strictly increasing ids and advances nextId", () => {
    const s = newState();
    expect(allocId(s)).toBe(1);
    expect(allocId(s)).toBe(2);
    expect(allocId(s)).toBe(3);
    expect(s.nextId).toBe(4);
  });
});
