import { beforeEach, describe, expect, it } from "vitest";
import { bumpCoopEpoch, coopEpoch, isCoopEpochCurrent } from "./session";

// Each test starts from whatever the module's counter is; we only assert relative behaviour,
// so no reset hook is needed (the counter is monotonic and never read as an absolute value).
describe("coop session epoch", () => {
  let base: number;
  beforeEach(() => {
    base = coopEpoch();
  });

  it("reports a freshly captured epoch as current", () => {
    const e = coopEpoch();
    expect(isCoopEpochCurrent(e)).toBe(true);
  });

  it("invalidates a captured epoch after a bump", () => {
    const e = coopEpoch();
    bumpCoopEpoch();
    expect(isCoopEpochCurrent(e)).toBe(false);
  });

  it("treats the post-bump epoch as the new current one", () => {
    bumpCoopEpoch();
    const e = coopEpoch();
    expect(isCoopEpochCurrent(e)).toBe(true);
  });

  it("advances monotonically on each bump", () => {
    bumpCoopEpoch();
    const first = coopEpoch();
    bumpCoopEpoch();
    const second = coopEpoch();
    expect(second).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(base);
  });
});
