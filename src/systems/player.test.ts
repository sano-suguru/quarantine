import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { addPlayer } from "../engine/players";
import { newState } from "../state";
import type { State } from "../types";
import { sysPlayer } from "./player";

/**
 * Regression: in co-op, a non-searching teammate's interact() used to reset every other
 * player's in-progress cache search each tick (the per-player "reset un-searched caches"
 * loop), pinning searchT to ~one frame. The reset now runs once after all players, only
 * for caches nobody is on.
 */
describe("co-op cache search", () => {
  it("accumulates for the searcher and isn't wiped by an idle teammate", () => {
    const s = newState();
    s.phase = "day";
    s.barricades.length = 0; // no nearby barricade so repair doesn't take priority
    const cache = s.caches[0] as State["caches"][number];
    cache.looted = false;

    // host (id 0) idle and far away; client (id 1) standing on the cache, holding E
    const p0 = s.players[0] as State["players"][number];
    p0.x = 9999;
    p0.y = 9999;
    p0.input = { ...p0.input, interactHeld: false, moveX: 0, moveY: 0 };
    const p1 = addPlayer(s, 1, cache.x, cache.y);
    p1.input = { ...p1.input, interactHeld: true, moveX: 0, moveY: 0 };

    for (let i = 0; i < 5; i++) sysPlayer(s, 0.05); // 0.25s of searching, below searchTime

    // with the bug this would be stuck near one frame (~0.05); fixed it accumulates
    expect(cache.searchT).toBeGreaterThan(0.2);
  });
});

/** Phase 3: repairing the shared barricade is near-free support labor (refund < cost,
 *  scaled by hp actually restored) — viable for a support role, never a money fountain. */
describe("repair labor reward", () => {
  function repairSetup(barHp: number): { s: State; p: State["players"][number] } {
    const s = newState();
    s.phase = "day";
    s.caches.length = 0; // no cache nearby so repair is the chosen interaction
    const bar = s.barricades[0] as State["barricades"][number];
    bar.hp = barHp;
    const p = s.players[0] as State["players"][number];
    p.x = (bar.x1 + bar.x2) / 2;
    p.y = (bar.y1 + bar.y2) / 2;
    p.money = 100;
    p.input = { ...p.input, interactHeld: true, moveX: 0, moveY: 0 };
    return { s, p };
  }

  it("refunds most of the cost when the wall takes a full repair's worth of damage", () => {
    const { s, p } = repairSetup(10); // far below max → a full repairAmount is restored
    sysPlayer(s, 0.05);
    // net = -repairCost + repairReward (full effect), always negative (no profit)
    const net = p.money - 100;
    expect(net).toBe(-(CONFIG.siege.repairCost - CONFIG.econ.repairReward));
    expect(net).toBeLessThan(0); // anti-fountain: repairing never profits
  });

  it("scales the refund down with hp actually restored (effect-linked)", () => {
    const bar0 = newState().barricades[0] as State["barricades"][number];
    const max = bar0.maxHp;
    const { s, p } = repairSetup(max - 10); // only 10 hp of room → small restore
    sysPlayer(s, 0.05);
    const reward = Math.round(CONFIG.econ.repairReward * (10 / CONFIG.siege.repairAmount));
    expect(p.money).toBe(100 - CONFIG.siege.repairCost + reward);
  });
});

/** Phase B: E heals the nearest hurt teammate by spending one of YOUR medkits (instant). */
describe("co-op heal teammate (E)", () => {
  it("spends a medkit to heal a nearby hurt teammate", () => {
    const s = newState();
    s.barricades.length = 0; // no wall so the teammate is the only E target
    const healer = s.players[0] as State["players"][number];
    healer.x = 0;
    healer.y = 0;
    healer.medkits = 2;
    healer.input = { ...healer.input, interactHeld: true, moveX: 0, moveY: 0 };
    const mate = addPlayer(s, 1, 30, 0);
    mate.hp = 40;

    sysPlayer(s, 0.05);

    expect(healer.medkits).toBe(1); // spent one
    expect(mate.hp).toBe(Math.min(mate.maxHp, 40 + CONFIG.heal.amount));
  });

  it("does nothing when the healer has no medkit (no heal target)", () => {
    const s = newState();
    s.barricades.length = 0;
    const healer = s.players[0] as State["players"][number];
    healer.medkits = 0;
    healer.input = { ...healer.input, interactHeld: true };
    const mate = addPlayer(s, 1, 30, 0);
    mate.hp = 40;

    sysPlayer(s, 0.05);

    expect(mate.hp).toBe(40); // untouched
    expect(healer.medkits).toBe(0);
  });
});
