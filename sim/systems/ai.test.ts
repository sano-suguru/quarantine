import { describe, expect, it } from "vitest";
import { localPlayer } from "../engine/players";
import { newState } from "../state";
import { sysAI } from "./ai";
import { spawnZombie } from "./wave";

describe("ai fx events", () => {
  it("a zombie melee on the local player pushes a hurt event", () => {
    const s = newState();
    const p = localPlayer(s);
    spawnZombie(s, "walker", 1, 1);
    const z = s.zombies[s.zombies.length - 1];
    if (!z) throw new Error("spawnZombie did not add a zombie");
    z.x = p.x;
    z.y = p.y; // overlap → melee in range
    z.attackCd = 0; // remove attack cooldown windup
    z.spawnT = 0; // remove spawn protection
    // step until the melee lands (bounded); asserts the cue is emitted, not the exact tick
    for (let i = 0; i < 120 && !s.fxEvents.some((e) => e.t === "hurt"); i++) sysAI(s, 1 / 60);
    const hurts = s.fxEvents.filter((e) => e.t === "hurt");
    expect(hurts.length).toBeGreaterThanOrEqual(1);
    expect(hurts.some((e) => e.t === "hurt" && e.local)).toBe(true);
  });
});
