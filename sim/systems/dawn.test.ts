import { describe, expect, it } from "vitest";
import { salvageEarned, salvageShare } from "../data/arsenal";
import { addPlayer } from "../engine/players";
import { newState } from "../state";
import { sysDawn } from "./dawn";

describe("sysDawn", () => {
  it("increments the day and re-enters the day phase", () => {
    const s = newState();
    s.day = 2;
    s.phase = "night";
    sysDawn(s);
    expect(s.day).toBe(3);
    expect(s.phase).toBe("day");
  });

  it("banks the incremental SALVAGE split among present players", () => {
    const s = newState();
    s.players = []; // drop the pre-seeded id0 so present-count is exactly 2
    addPlayer(s, 0, 0, 0);
    addPlayer(s, 1, 0, 0);
    s.day = 1;
    s.kills = 20;
    s.salvageBanked = 0;
    const out = sysDawn(s); // day→2
    const total = salvageEarned(2, 20);
    const share = salvageShare(total, 2);
    expect(out).toEqual([
      { pid: 0, salvage: share },
      { pid: 1, salvage: share },
    ]);
    expect(s.salvageBanked).toBe(total); // baseline advanced so the next dawn banks only the delta
  });

  it("excludes absent (disconnected) players from banking", () => {
    const s = newState();
    s.players = [];
    const a = addPlayer(s, 0, 0, 0);
    addPlayer(s, 1, 0, 0);
    a.absent = true;
    const out = sysDawn(s);
    expect(out.map((b) => b.pid)).toEqual([1]);
  });

  it("revives stragglers still down at dawn (safety net)", () => {
    const s = newState();
    s.players = [];
    const p = addPlayer(s, 0, 500, 500);
    p.hp = 0;
    p.downT = 3; // below respawnDelay — timer hadn't fired
    sysDawn(s);
    expect(p.hp).toBe(p.maxHp);
    expect(p.downT).toBe(0);
  });
});
