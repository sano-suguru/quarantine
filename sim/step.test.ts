import { describe, expect, it } from "vitest";
import { CONFIG } from "./config";
import { newState } from "./state";
import { stepSim } from "./step";

describe("stepSim freeze during reset phases", () => {
  it("does not advance gameplay while phase is 'breached', but the reset clock ticks", () => {
    const s = newState();
    s.running = true;
    s.phase = "breached";
    s.phaseT = CONFIG.siege.breachedDuration;
    // a zombie that would move if sysAI ran
    s.zombies.push({
      ...(s.zombies[0] ?? {}),
      id: 999,
      x: 500,
      y: 0,
    } as (typeof s.zombies)[number]);
    const last0 = s.zombies[s.zombies.length - 1] as (typeof s.zombies)[number];
    const zx = last0.x;
    const t0 = s.phaseT;
    stepSim(s, 1 / 60);
    const last1 = s.zombies[s.zombies.length - 1] as (typeof s.zombies)[number];
    expect(last1.x).toBe(zx); // sysAI skipped
    expect(s.phaseT).toBeLessThan(t0); // sysSiege ran
  });
});

describe("stepSim", () => {
  it("returns 'night' and pushes the NIGHT/waveStart cues on the day→night edge", () => {
    const s = newState();
    s.running = true;
    s.phase = "day";
    s.phaseT = 0.0001; // one step tips it to night
    expect(stepSim(s, 1 / 60)).toBe("night");
    expect(s.fxEvents.some((e) => e.t === "announce" && e.label === "NIGHT")).toBe(true);
    expect(s.fxEvents.some((e) => e.t === "audio" && e.cue === "waveStart")).toBe(true);
  });
  it("returns null on a normal tick and does NOT set paused (no openShop)", () => {
    const s = newState();
    s.running = true;
    expect(stepSim(s, 1 / 60)).toBe(null);
    expect(s.paused).toBe(false);
  });
  it("keeps running (returns null, not a wipe) when every player is down", () => {
    const s = newState();
    s.running = true;
    for (const p of s.players) p.hp = 0;
    expect(stepSim(s, 1 / 60)).toBe(null); // no game-over: the night clock keeps advancing
  });
});
