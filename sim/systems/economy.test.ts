import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { addPlayer } from "../engine/players";
import { newState } from "../state";
import type { State } from "../types";
import { awardBounty, scaledBounty } from "./economy";

const R = CONFIG.econ.bountyRadius;

describe("awardBounty", () => {
  it("single-player: the sole player gets the full amount (SP byte-invariant)", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    p.money = 0;
    awardBounty(s, 9999, 9999, 5); // far from the kill — SP must still get it all
    expect(p.money).toBe(5);
  });

  it("splits evenly among living players within the radius of the kill", () => {
    const s = newState();
    const a = s.players[0] as State["players"][number];
    a.x = 0;
    a.y = 0;
    a.money = 0;
    const b = addPlayer(s, 1, 50, 0); // within radius
    b.money = 0;
    awardBounty(s, 0, 0, 8);
    expect(a.money).toBe(4);
    expect(b.money).toBe(4);
  });

  it("excludes players outside the radius", () => {
    const s = newState();
    const a = s.players[0] as State["players"][number];
    a.x = 0;
    a.y = 0;
    a.money = 0;
    const far = addPlayer(s, 1, R + 100, 0); // outside radius
    far.money = 0;
    awardBounty(s, 0, 0, 10);
    expect(a.money).toBe(10);
    expect(far.money).toBe(0);
  });

  it("gives the integer remainder to the poorest player first (catch-up)", () => {
    const s = newState();
    const a = s.players[0] as State["players"][number];
    a.x = 0;
    a.y = 0;
    a.money = 100; // richer
    const b = addPlayer(s, 1, 30, 0);
    b.money = 0; // poorer → gets the remainder
    awardBounty(s, 0, 0, 5); // base 2 each, remainder 1 → poorer b
    expect(a.money).toBe(100 + 2);
    expect(b.money).toBe(0 + 3);
  });

  it("ignores downed/absent players when splitting", () => {
    const s = newState();
    const a = s.players[0] as State["players"][number];
    a.x = 0;
    a.y = 0;
    a.money = 0;
    const down = addPlayer(s, 1, 20, 0);
    down.hp = 0;
    down.money = 0;
    const gone = addPlayer(s, 2, 20, 0);
    gone.absent = true;
    gone.money = 0;
    awardBounty(s, 0, 0, 6);
    expect(a.money).toBe(6); // only the one living, in-range player
    expect(down.money).toBe(0);
    expect(gone.money).toBe(0);
  });

  it("falls back to the whole living squad when nobody is in range (money never lost)", () => {
    const s = newState();
    const a = s.players[0] as State["players"][number];
    a.x = 0;
    a.y = 0;
    a.money = 0;
    const b = addPlayer(s, 1, 100, 0);
    b.money = 0;
    awardBounty(s, 5000, 5000, 4); // kill far from both
    expect(a.money + b.money).toBe(4); // conserved across the squad
  });
});

describe("scaledBounty", () => {
  it("is the base amount for a single player", () => {
    expect(scaledBounty(20, 1)).toBe(20);
  });

  it("scales up with squad size and stays integer", () => {
    const v = scaledBounty(20, 5);
    expect(v).toBe(Math.round(20 * (1 + 4 * CONFIG.econ.bountyPerPlayer)));
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThan(20);
  });
});
