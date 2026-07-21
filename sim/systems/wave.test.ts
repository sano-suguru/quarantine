import { describe, expect, it } from "vitest";
import { addPlayer } from "../engine/players";
import { newState } from "../state";
import type { State, WaveDefinition } from "../types";
import { liveCount, startWave, sysWave } from "./wave";

// Guardrail: sysWave calls spawnZombie (RNG positions), but the SCHEDULING — batch size, spawn
// cadence, and the living-zombie cap — is deterministic. We assert counts only, never coordinates.

/** Arm an active wave with a controlled batch size and spawn timer (single-type composition). */
function armWave(s: State, n: number, batch: number, spawnT: number): void {
  const def: WaveDefinition = {
    weights: [{ type: "walker", w: 1 }],
    batch,
    interval: 0.5,
    hpScale: 1,
    spdScale: 1,
  };
  s.wave = { n, def, spawnT, effCount: 1 };
}

describe("startWave", () => {
  it("arms the wave for the given day with a definition", () => {
    const s = newState();
    startWave(s, 3);
    expect(s.wave.n).toBe(3);
    expect(s.wave.def).not.toBeNull();
  });
});

describe("sysWave scheduling", () => {
  it("does nothing without a wave definition", () => {
    const s = newState();
    s.wave = { n: 0, def: null, spawnT: 0, effCount: 1 };
    sysWave(s, 1, 90);
    expect(s.zombies.length).toBe(0);
  });

  it("waits while the spawn timer has not elapsed", () => {
    const s = newState();
    armWave(s, 1, 3, 0.5);
    sysWave(s, 0.1, 90);
    expect(s.zombies.length).toBe(0); // timer only decremented, nothing spawned
  });

  it("spawns a full batch when the timer elapses, then resets the timer", () => {
    const s = newState();
    armWave(s, 6, 3, 0);
    sysWave(s, 0.1, 90);
    expect(s.zombies.length).toBe(3);
    expect(s.wave.spawnT).toBeCloseTo(0.5); // reset to def.interval
  });

  it("keeps spawning on later pulses (continuous, no finite roster)", () => {
    const s = newState();
    armWave(s, 1, 2, 0);
    sysWave(s, 0.1, 90); // pulse 1
    s.wave.spawnT = 0; // force the next pulse
    sysWave(s, 0.1, 90); // pulse 2
    expect(s.zombies.length).toBe(4);
  });

  it("never exceeds the living-zombie cap, and a full crowd spawns nothing", () => {
    const s = newState();
    armWave(s, 1, 100, 0); // batch far larger than the cap
    sysWave(s, 0.1, 10);
    expect(s.zombies.length).toBe(10); // clamped to the cap
    s.wave.spawnT = 0;
    sysWave(s, 0.1, 10); // already at cap → no spawn
    expect(s.zombies.length).toBe(10);
  });
});

describe("liveCount", () => {
  it("is 1 for a single player", () => {
    const s = newState();
    expect(liveCount(s)).toBe(1);
  });

  it("counts non-absent players and floors at 1", () => {
    const s = newState();
    addPlayer(s, 1, 0, 0);
    addPlayer(s, 2, 0, 0);
    expect(liveCount(s)).toBe(3); // newState seeds player 0 + 2 added
    const p = s.players.find((pl) => pl.id === 2);
    if (p) p.absent = true;
    expect(liveCount(s)).toBe(2); // absent excluded
  });
});
