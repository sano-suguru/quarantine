import { describe, expect, it } from "vitest";
import { clearFx, pushFx } from "./events";
import { newState } from "./state";

describe("fxEvents buffer", () => {
  it("starts empty", () => {
    expect(newState().fxEvents).toEqual([]);
  });
  it("pushFx appends; clearFx empties", () => {
    const s = newState();
    pushFx(s, { t: "hit", x: 1, y: 2 });
    pushFx(s, { t: "hurt", x: 3, y: 4, local: true });
    expect(s.fxEvents).toHaveLength(2);
    clearFx(s);
    expect(s.fxEvents).toEqual([]);
  });
});
