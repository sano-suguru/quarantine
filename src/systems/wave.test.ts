import { describe, expect, it } from "vitest";
import { waveDef } from "../data/waves";
import { newState } from "../state";
import type { State, WaveDefinition } from "../types";
import { startWave, sysWave } from "./wave";

// Guardrail: sysWave calls spawnZombie (RNG positions), but the SCHEDULING — batch size,
// queue drain, and the cleared transition — is fully deterministic. We assert counts and
// flags only, never spawn coordinates, and drive the cleared path by emptying the arrays
// directly rather than running the spawn→kill loop (which would touch feel/RNG via killZombie).

/** Put `s` into an active wave with a controlled queue, batch number, and spawn timer. */
function armWave(s: State, n: number, queue: string[], spawnT: number): void {
  const def: WaveDefinition = { spawn: queue.slice(), hpScale: 1, spdScale: 1, interval: 0.5 };
  s.wave = { n, phase: "active", t: 0, queue: queue.slice(), def, spawnT };
}

describe("startWave", () => {
  it("loads the wave's spawn queue and marks it active", () => {
    const s = newState();
    startWave(s, 3);
    const def = waveDef(3);
    expect(s.wave.n).toBe(3);
    expect(s.wave.phase).toBe("active");
    expect(s.wave.queue.length).toBe(def.spawn.length);
    expect(s.wave.def).not.toBeNull();
  });
});

describe("sysWave scheduling", () => {
  it("does nothing for a wave that is not active", () => {
    const s = newState();
    s.wave.phase = "prep";
    expect(sysWave(s, 1)).toBe(false);
    expect(s.zombies.length).toBe(0);
  });

  it("waits while the spawn timer has not elapsed", () => {
    const s = newState();
    armWave(s, 1, ["walker", "walker", "walker"], 0.5);
    expect(sysWave(s, 0.1)).toBe(false);
    expect(s.zombies.length).toBe(0); // timer only decremented, nothing spawned
    expect(s.wave.queue.length).toBe(3);
  });

  it("spawns batch = 1 + floor(n/3) when the timer elapses, then resets the timer", () => {
    const s = newState();
    // n = 6 → batch = 1 + 2 = 3
    armWave(s, 6, ["walker", "walker", "walker", "walker", "walker"], 0);
    expect(sysWave(s, 0.1)).toBe(false);
    expect(s.zombies.length).toBe(3);
    expect(s.wave.queue.length).toBe(2);
    expect(s.wave.spawnT).toBeCloseTo(0.5); // reset to def.interval
  });

  it("never spawns more than the queue holds", () => {
    const s = newState();
    // n = 9 → batch would be 4, but only 2 remain in the queue
    armWave(s, 9, ["walker", "walker"], 0);
    sysWave(s, 0.1);
    expect(s.zombies.length).toBe(2);
    expect(s.wave.queue.length).toBe(0);
  });

  it("transitions to 'cleared' (returns true) once the queue is empty and all zombies are dead", () => {
    const s = newState();
    armWave(s, 1, [], 0);
    s.zombies = [];
    expect(sysWave(s, 1)).toBe(true);
    expect(s.wave.phase).toBe("cleared");
  });

  it("stays active (returns false) while the queue is empty but zombies remain", () => {
    const s = newState();
    armWave(s, 1, [], 0);
    s.zombies = [{ id: 1 } as (typeof s.zombies)[number]];
    expect(sysWave(s, 1)).toBe(false);
    expect(s.wave.phase).toBe("active");
  });
});
