import { describe, expect, it } from "vitest";
import { newState } from "./state";
import { stepSim } from "./step";

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
  it("returns null on a normal tick and does NOT set paused/inShop (no openShop)", () => {
    const s = newState();
    s.running = true;
    expect(stepSim(s, 1 / 60)).toBe(null);
    expect(s.paused).toBe(false);
    expect(s.inShop).toBe(false);
  });
  it("keeps running (returns null, not a wipe) when every player is down", () => {
    const s = newState();
    s.running = true;
    for (const p of s.players) p.hp = 0;
    expect(stepSim(s, 1 / 60)).toBe(null); // no game-over: the night clock keeps advancing
  });
});
