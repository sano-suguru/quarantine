import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { makePlayer } from "../engine/players";
import { newState } from "../state";
import { actionMotion, decaySwing, deriveActionChannel } from "./actionFeel";

describe("decaySwing", () => {
  it("counts down and clamps at 0", () => {
    expect(decaySwing(0.3, 0.1)).toBeCloseTo(0.2, 5);
    expect(decaySwing(0.05, 0.1)).toBe(0);
    expect(decaySwing(0, 0.1)).toBe(0);
  });
});

describe("actionMotion", () => {
  it("is zero when idle", () => {
    const m = actionMotion("none", 0, 0, CONFIG.actionFeel);
    expect(m.lean).toBe(0);
    expect(m.bob).toBe(0);
  });
  it("leans proportional to phase and bobs within amplitude", () => {
    const m = actionMotion("search", 1, 0.123, CONFIG.actionFeel);
    expect(m.lean).toBeGreaterThan(0);
    expect(Math.abs(m.bob)).toBeLessThanOrEqual(CONFIG.actionFeel.bob + 1e-6);
  });
});

describe("deriveActionChannel", () => {
  it("returns none for an idle player", () => {
    const p = makePlayer(0, 0, 0);
    const s = newState();
    expect(deriveActionChannel(p, s).kind).toBe("none");
  });
  it("reports heal with rising phase as healT drains", () => {
    const p = makePlayer(0, 0, 0);
    const s = newState();
    p.healT = CONFIG.heal.duration; // just started
    expect(deriveActionChannel(p, s).kind).toBe("heal");
    expect(deriveActionChannel(p, s).phase).toBeCloseTo(0, 2);
    p.healT = CONFIG.heal.duration * 0.25; // near done
    expect(deriveActionChannel(p, s).phase).toBeGreaterThan(0.5);
  });
  it("prioritizes heal over a concurrent swing", () => {
    const p = makePlayer(0, 0, 0);
    const s = newState();
    p.healT = 1;
    p.swingT = 0.2;
    p.swingKind = "repair";
    expect(deriveActionChannel(p, s).kind).toBe("heal");
  });
  it("reports the swing kind when only a swing is active", () => {
    const p = makePlayer(0, 0, 0);
    const s = newState();
    p.swingT = CONFIG.actionFeel.swingDecay;
    p.swingKind = "mateHeal";
    const c = deriveActionChannel(p, s);
    expect(c.kind).toBe("mateHeal");
    expect(c.phase).toBeCloseTo(1, 2);
  });
  it("reports search when the searching flag is set", () => {
    const p = makePlayer(0, 0, 0);
    const s = newState();
    p.searching = true;
    expect(deriveActionChannel(p, s).kind).toBe("search");
  });
});
