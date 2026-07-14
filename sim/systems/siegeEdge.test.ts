import { describe, expect, it } from "vitest";
import { isArenaResetEdge, siegeEdgeCue } from "./siegeEdge";

describe("siegeEdgeCue", () => {
  it("day→night yields NIGHT banner + waveStart sting", () => {
    expect(siegeEdgeCue("day", "night", 4)).toEqual([
      { t: "announce", label: "NIGHT", day: 4 },
      { t: "audio", cue: "waveStart" },
    ]);
  });
  it("night→day yields DAY banner + dawn sting", () => {
    expect(siegeEdgeCue("night", "day", 5)).toEqual([
      { t: "announce", label: "DAY", day: 5 },
      { t: "audio", cue: "dawn" },
    ]);
  });
  it("no edge (same phase, or first snapshot prev=null) yields nothing", () => {
    expect(siegeEdgeCue("night", "night", 4)).toEqual([]);
    expect(siegeEdgeCue(null, "night", 4)).toEqual([]); // drop-in mid-night: no banner
  });
});

describe("siegeEdgeCue reset phases", () => {
  it("fires the fallen cue on night→breached", () => {
    expect(siegeEdgeCue("night", "breached", 3)).toEqual([
      { t: "announce", label: "FORTRESS FALLEN", day: 3 },
      { t: "audio", cue: "breach" },
    ]);
  });
  it("is silent on breached→resetting", () => {
    expect(siegeEdgeCue("breached", "resetting", 3)).toEqual([]);
  });
  it("still fires DAY on the normal night→day dawn", () => {
    const cues = siegeEdgeCue("night", "day", 4);
    expect(cues.some((c) => c.t === "announce" && (c as { label: string }).label === "DAY")).toBe(
      true,
    );
  });
});

describe("isArenaResetEdge", () => {
  it("is true only on resetting→day", () => {
    expect(isArenaResetEdge("resetting", "day")).toBe(true);
    expect(isArenaResetEdge("breached", "resetting")).toBe(false);
    expect(isArenaResetEdge("night", "day")).toBe(false);
    expect(isArenaResetEdge(null, "day")).toBe(false);
  });
});
