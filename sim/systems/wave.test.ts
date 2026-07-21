import { describe, expect, it } from "vitest";
import { waveDef } from "../data/waves";
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
  // NOTE: sysWave now re-derives state.wave.def from the real waveDef(n, effCount) EVERY tick
  // (real-time density re-eval), so a def can no longer be pinned to an arbitrary custom value
  // (or nulled to "disable" the spawner) and survive into the spawn logic below it in the same
  // call. These tests drive `n` (with a fixed single-player effCount of 1, since no players are
  // added) and assert against the actual waveDef(n, 1) output instead of hand-picked numbers.

  it("re-arms a real definition even starting from null (nulling def no longer disables it)", () => {
    const s = newState();
    s.wave = { n: 0, def: null, spawnT: 0, effCount: 1 };
    sysWave(s, 0.1, 90);
    expect(s.wave.def).not.toBeNull();
    expect(s.zombies.length).toBe(waveDef(0, 1).batch); // spawnT started at 0 → an immediate pulse
  });

  it("waits while the spawn timer has not elapsed", () => {
    const s = newState();
    armWave(s, 1, 3, 0.5);
    sysWave(s, 0.1, 90);
    expect(s.zombies.length).toBe(0); // timer only decremented, nothing spawned
  });

  it("spawns a full batch when the timer elapses, then resets the timer", () => {
    const s = newState();
    s.wave = { n: 6, def: null, spawnT: 0, effCount: 1 };
    sysWave(s, 0.1, 90);
    const expected = waveDef(6, 1);
    expect(s.zombies.length).toBe(expected.batch);
    expect(s.wave.spawnT).toBeCloseTo(expected.interval); // reset to the re-derived def.interval
  });

  it("keeps spawning on later pulses (continuous, no finite roster)", () => {
    const s = newState();
    s.wave = { n: 3, def: null, spawnT: 0, effCount: 1 };
    const batch = waveDef(3, 1).batch;
    sysWave(s, 0.1, 90); // pulse 1
    s.wave.spawnT = 0; // force the next pulse
    sysWave(s, 0.1, 90); // pulse 2
    expect(s.zombies.length).toBe(batch * 2);
  });

  it("never exceeds the living-zombie cap, and a full crowd spawns nothing", () => {
    const s = newState();
    // n=30 → waveDef(30, 1).batch comfortably exceeds the cap (no custom def can force this anymore)
    s.wave = { n: 30, def: null, spawnT: 0, effCount: 1 };
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

describe("sysWave real-time density", () => {
  it("eases effCount toward live occupancy and re-derives the def", () => {
    const s = newState();
    startWave(s, 5);
    const batch0 = s.wave.def?.batch ?? 0;
    // three more players join mid-night
    addPlayer(s, 1, 0, 0);
    addPlayer(s, 2, 0, 0);
    addPlayer(s, 3, 0, 0);
    // advance several ticks; effCount should ease up (not jump) toward 4
    for (let i = 0; i < 120; i++) sysWave(s, 1 / 60, 999);
    expect(s.wave.effCount).toBeGreaterThan(1);
    expect(s.wave.effCount).toBeLessThanOrEqual(4);
    expect(s.wave.def?.batch ?? 0).toBeGreaterThan(batch0); // denser budget as the party grew
  });
});
