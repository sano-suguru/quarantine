import { describe, expect, it } from "vitest";
import { type LightCandidate, selectLights } from "./lights";

const L = (over: Partial<LightCandidate>): LightCandidate => ({
  x: 0,
  y: 0,
  ax: 1,
  ay: 0,
  intens: 1,
  range: 100,
  cosHalf: 0.5,
  priority: 0,
  ...over,
});

describe("selectLights", () => {
  it("drops a light fully off-screen (cone can't reach the view)", () => {
    const off = L({ x: 5000, y: 0, range: 100 });
    expect(selectLights([off], 0, 0, 400, 300, 8)).toHaveLength(0);
  });
  it("keeps an off-screen origin whose range reaches into the view", () => {
    const near = L({ x: 460, y: 0, range: 100 }); // origin 60 past the right edge (400), range 100
    expect(selectLights([near], 0, 0, 400, 300, 8)).toHaveLength(1);
  });
  it("prioritizes players, then nearest-to-camera, within the budget", () => {
    const player = L({ x: 0, y: 0, priority: 1 });
    const far = L({ x: 200, y: 0, priority: 0 });
    const near = L({ x: 50, y: 0, priority: 0 });
    const kept = selectLights([far, near, player], 0, 0, 400, 300, 2);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe(player); // player first
    expect(kept[1]).toBe(near); // then nearest of the rest
  });
});
