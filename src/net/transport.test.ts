import { describe, expect, it } from "vitest";
import { turnStatusOf } from "./transport";

const stun = [{ urls: "stun:example" }];
const relay = [{ urls: "turn:example", username: "u", credential: "c" }];

describe("turnStatusOf (relay status from a /turn response)", () => {
  it("available when the response is ok and carries ICE servers", () => {
    expect(turnStatusOf(true, relay, undefined)).toBe("available");
  });

  it("budget-reached only on the fail-closed monthly-cap reason", () => {
    expect(turnStatusOf(true, [], "budget-reached")).toBe("budget-reached");
  });

  it("stun-only for every other case", () => {
    expect(turnStatusOf(true, [], "budget-guard-unconfigured")).toBe("stun-only"); // analytics token unset
    expect(turnStatusOf(true, [], undefined)).toBe("stun-only"); // TURN key unset → empty, no reason
    expect(turnStatusOf(false, [], undefined)).toBe("stun-only"); // same-origin 403
    expect(turnStatusOf(false, undefined, undefined)).toBe("stun-only"); // fetch error / no body
    expect(turnStatusOf(true, undefined, undefined)).toBe("stun-only");
  });

  it("real ICE servers win regardless of any reason; an empty list never reads as available", () => {
    expect(turnStatusOf(true, [], undefined)).toBe("stun-only"); // empty → not available
    expect(turnStatusOf(true, stun, "budget-reached")).toBe("available"); // got servers → use them
  });
});
