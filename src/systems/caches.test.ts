import { describe, expect, it } from "vitest";
import { newState } from "../state";
import { lootCache, restockCaches } from "./caches";

describe("restockCaches", () => {
  it("resets every cache to unsearched (looted=false, searchT=0)", () => {
    const s = newState();
    for (const c of s.caches) {
      c.looted = true;
      c.searchT = 1.5;
    }
    restockCaches(s);
    expect(s.caches.length).toBeGreaterThan(0);
    expect(s.caches.every((c) => c.looted === false && c.searchT === 0)).toBe(true);
  });
});

describe("lootCache", () => {
  it("awards 10 * tier credits and emits (1 + tier) pickups", () => {
    const s = newState();
    s.money = 0;
    s.pickups = [];
    lootCache(s, 0, 0, 2);
    expect(s.money).toBe(20); // 10 * tier
    expect(s.pickups.length).toBe(3); // 1 + tier items
  });

  it("scales loot count and credits with the tier", () => {
    const s = newState();
    s.money = 0;
    s.pickups = [];
    lootCache(s, 0, 0, 1);
    expect(s.money).toBe(10);
    expect(s.pickups.length).toBe(2);
  });
});
