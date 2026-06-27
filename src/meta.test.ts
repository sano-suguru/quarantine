import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addSalvage, buyUnlock, loadMeta } from "./meta";

// meta.ts wraps localStorage, but the DECISIONS it makes (balance arithmetic, affordability,
// owned guard) are pure. We test those through an in-memory localStorage stub — the IO itself
// (real browser storage) stays out of scope per the testing philosophy.
let store: Record<string, string>;

beforeEach(() => {
  store = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadMeta", () => {
  it("returns fresh defaults when storage is empty", () => {
    const m = loadMeta();
    expect(m.salvage).toBe(0);
    expect(m.unlocked).toEqual({});
  });

  it("tolerates corrupt JSON by falling back to defaults", () => {
    store.q_meta = "{not valid json";
    const m = loadMeta();
    expect(m.salvage).toBe(0);
  });
});

describe("addSalvage", () => {
  it("banks rounded, non-negative salvage and persists it", () => {
    addSalvage(10.4);
    expect(loadMeta().salvage).toBe(10);
    addSalvage(5.6);
    expect(loadMeta().salvage).toBe(16); // 10 + round(5.6)
  });

  it("never subtracts on a negative input", () => {
    addSalvage(20);
    addSalvage(-100);
    expect(loadMeta().salvage).toBe(20);
  });
});

describe("buyUnlock", () => {
  it("spends salvage and records the unlock when affordable", () => {
    addSalvage(150);
    const m = buyUnlock("rifle", 120);
    expect(m).not.toBeNull();
    expect(m?.salvage).toBe(30);
    expect(m?.unlocked.rifle).toBe(true);
  });

  it("refuses when funds are short (no balance change)", () => {
    addSalvage(50);
    expect(buyUnlock("rifle", 120)).toBeNull();
    expect(loadMeta().salvage).toBe(50);
    expect(loadMeta().unlocked.rifle).toBeFalsy();
  });

  it("refuses to buy an already-owned unlock", () => {
    addSalvage(500);
    buyUnlock("rifle", 120);
    expect(buyUnlock("rifle", 120)).toBeNull();
    expect(loadMeta().salvage).toBe(380); // charged only once
  });
});
