import { describe, expect, it } from "vitest";
import { reconnectDelay } from "./reconnect";

describe("reconnectDelay", () => {
  const backoff = [1000, 2000, 4000, 8000] as const;

  it("returns the per-attempt delay for in-range attempts", () => {
    expect(reconnectDelay(0, backoff)).toBe(1000);
    expect(reconnectDelay(1, backoff)).toBe(2000);
    expect(reconnectDelay(3, backoff)).toBe(8000);
  });

  it("returns null once attempts are exhausted (→ give up)", () => {
    expect(reconnectDelay(4, backoff)).toBeNull();
    expect(reconnectDelay(99, backoff)).toBeNull();
  });

  it("returns null for an empty backoff array", () => {
    expect(reconnectDelay(0, [])).toBeNull();
  });
});
