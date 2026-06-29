import { describe, expect, it } from "vitest";
import { WEAPONS } from "./weapons";

describe("weapon visual data invariants", () => {
  it("every weapon has drawTime > 0 (the draw pose divides by it)", () => {
    for (const [id, w] of Object.entries(WEAPONS)) {
      expect(w.drawTime, `${id}.drawTime`).toBeGreaterThan(0);
    }
  });

  it("every weapon has a non-empty viz parts array", () => {
    for (const [id, w] of Object.entries(WEAPONS)) {
      expect(w.viz.length, `${id}.viz`).toBeGreaterThan(0);
    }
  });
});
