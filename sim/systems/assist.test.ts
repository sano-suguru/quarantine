import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { addPlayer } from "../engine/players";
import { newState } from "../state";
import type { State } from "../types";
import { sysAssist } from "./assist";

/** Down a player in place (keep their position). */
function down(p: State["players"][number]): void {
  p.hp = 0;
}

describe("sysAssist (co-op proximity revive)", () => {
  it("single-player: never fires (no teammates) — SP invariant", () => {
    const s = newState();
    const solo = s.players[0] as State["players"][number];
    down(solo);
    sysAssist(s, 3.0);
    expect(solo.assistT).toBe(0);
    expect(solo.hp).toBe(0); // stays downed; nothing revives it
  });

  it("a stationary teammate in range revives a downed ally in place at partial hp", () => {
    const s = newState();
    const helper = s.players[0] as State["players"][number];
    helper.x = 0;
    helper.y = 0;
    const target = addPlayer(s, 1, 30, 0); // within interactRadius
    down(target);
    sysAssist(s, CONFIG.assist.reviveTime + 0.1); // enough to complete
    expect(target.hp).toBe(Math.round(target.maxHp * CONFIG.assist.reviveHpFrac));
    expect(target.assistT).toBe(0);
    expect(target.x).toBe(30); // in place — not teleported to HOME
    expect(target.y).toBe(0);
  });

  it("a MOVING teammate does not revive (standing still is the intent signal)", () => {
    const s = newState();
    const helper = s.players[0] as State["players"][number];
    helper.input = { ...helper.input, moveX: 1 };
    const target = addPlayer(s, 1, 30, 0);
    down(target);
    sysAssist(s, 3.0);
    expect(target.assistT).toBe(0);
    expect(target.hp).toBe(0);
  });

  it("an out-of-range teammate does not revive", () => {
    const s = newState();
    const target = addPlayer(s, 1, CONFIG.siege.interactRadius + 100, 0);
    down(target);
    sysAssist(s, 3.0);
    expect(target.assistT).toBe(0);
  });

  it("progress resets when nobody is tending", () => {
    const s = newState();
    const helper = s.players[0] as State["players"][number];
    const target = addPlayer(s, 1, 30, 0);
    down(target);
    sysAssist(s, 1.0); // partial
    expect(target.assistT).toBeCloseTo(1.0, 5);
    helper.x = 9999; // walk away
    sysAssist(s, 0.1);
    expect(target.assistT).toBe(0);
  });

  it("accumulates once per target even with multiple helpers (no double-add)", () => {
    const s = newState();
    (s.players[0] as State["players"][number]).x = 10;
    addPlayer(s, 1, -10, 0); // second helper, both in range of the target at origin
    const target = addPlayer(s, 2, 0, 0);
    down(target);
    sysAssist(s, 0.1);
    expect(target.assistT).toBeCloseTo(0.1, 5);
  });
});
