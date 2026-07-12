import { describe, expect, it } from "vitest";
import { makeNonce, pickSlot, rejoinMatches } from "./roster";

describe("pickSlot (0-based, no host reservation)", () => {
  it("assigns the lowest free slot from 0", () => {
    expect(pickSlot([], 12)).toEqual({ kind: "assign", pid: 0 });
    expect(pickSlot([0, 1], 12)).toEqual({ kind: "assign", pid: 2 });
    expect(pickSlot([0, 2], 12)).toEqual({ kind: "assign", pid: 1 }); // fills the gap
  });
  it("returns full when every slot is taken", () => {
    expect(pickSlot([0, 1, 2], 3)).toEqual({ kind: "full" });
  });
});

describe("makeNonce", () => {
  it("produces distinct tokens", () => {
    expect(makeNonce()).not.toBe(makeNonce());
  });
});

describe("rejoinMatches", () => {
  const cand = { pid: 3, nonce: "abc", decided: true };
  it("matches on pid+nonce for a decided peer", () => {
    expect(rejoinMatches(cand, 3, "abc")).toBe(true);
  });
  it("rejects a wrong nonce, wrong pid, or undecided peer", () => {
    expect(rejoinMatches(cand, 3, "xyz")).toBe(false);
    expect(rejoinMatches(cand, 2, "abc")).toBe(false);
    expect(rejoinMatches({ ...cand, decided: false }, 3, "abc")).toBe(false);
  });
});
