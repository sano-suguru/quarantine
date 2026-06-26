import { describe, expect, it } from "vitest";
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
