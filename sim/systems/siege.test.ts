import { describe, expect, it } from "vitest";
import { newState } from "../state";
import { startNight, sysSiege } from "./siege";

describe("heldNight", () => {
  it("never returns dawn while held; the night clock stays positive", () => {
    const s = newState();
    s.running = true;
    s.heldNight = true;
    startNight(s); // phase=night, phaseT=nightDuration(day)
    // drive far past the normal night length
    for (let i = 0; i < 100000; i++) {
      const ev = sysSiege(s, 1 / 60);
      expect(ev).not.toBe("dawn");
    }
    expect(s.phase).toBe("night");
    expect(s.phaseT).toBeGreaterThan(0);
  });

  it("still returns dawn when NOT held", () => {
    const s = newState();
    s.running = true;
    s.heldNight = false;
    startNight(s);
    s.phaseT = 0.0001;
    expect(sysSiege(s, 1 / 60)).toBe("dawn");
  });
});
