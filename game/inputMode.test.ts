import { describe, expect, it } from "vitest";
import { resolveInputMode } from "./inputMode";

describe("resolveInputMode", () => {
  const base = { coarsePointer: false, hasTouch: false, override: null, forced: null } as const;
  it("defaults to desktop for mouse-only", () => {
    expect(resolveInputMode(base)).toBe("desktop");
  });
  it("picks mobile for a coarse-pointer touch device", () => {
    expect(resolveInputMode({ ...base, coarsePointer: true, hasTouch: true })).toBe("mobile");
  });
  it("forced flag (?mobile/?desktop) beats detection", () => {
    expect(
      resolveInputMode({ ...base, coarsePointer: true, hasTouch: true, forced: "desktop" }),
    ).toBe("desktop");
    expect(resolveInputMode({ ...base, forced: "mobile" })).toBe("mobile");
  });
  it("user override beats detection but not the forced flag", () => {
    expect(resolveInputMode({ ...base, override: "mobile" })).toBe("mobile");
    expect(
      resolveInputMode({
        ...base,
        coarsePointer: true,
        hasTouch: true,
        override: "desktop",
        forced: "mobile",
      }),
    ).toBe("mobile");
  });
});
