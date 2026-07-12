import { describe, expect, it } from "vitest";
import { siegeEdgeCue } from "./siegeEdge";

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
