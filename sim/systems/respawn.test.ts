import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { HOME_SPAWN } from "../data/map";
import { addPlayer } from "../engine/players";
import { newState } from "../state";
import { sysRespawn } from "./respawn";

// newState() pre-seeds one player (id 0). Reset the roster in each test so addPlayer ids are
// unambiguous and present-counts are exactly what the test sets up.
describe("sysRespawn", () => {
  it("ticks downT for a downed player without reviving before the delay", () => {
    const s = newState();
    s.players = [];
    const p = addPlayer(s, 0, 500, 500);
    p.hp = 0;
    sysRespawn(s, 1);
    expect(p.downT).toBeCloseTo(1, 5);
    expect(p.hp).toBe(0);
  });

  it("respawns at the fortress at full HP once downT reaches respawnDelay", () => {
    const s = newState();
    s.players = [];
    const p = addPlayer(s, 0, 500, 500);
    p.hp = 0;
    sysRespawn(s, CONFIG.siege.respawnDelay + 0.01);
    expect(p.hp).toBe(p.maxHp);
    expect(p.downT).toBe(0);
    expect(p.y).toBe(HOME_SPAWN.y); // teleported home
  });

  it("does not tick an absent (disconnected) held body", () => {
    const s = newState();
    s.players = [];
    const p = addPlayer(s, 0, 500, 500);
    p.hp = 0;
    p.absent = true;
    sysRespawn(s, 5);
    expect(p.downT).toBe(0);
  });

  it("leaves an alive player untouched", () => {
    const s = newState();
    s.players = [];
    const p = addPlayer(s, 0, 500, 500);
    sysRespawn(s, 5);
    expect(p.downT).toBe(0);
    expect(p.hp).toBe(p.maxHp);
  });
});
