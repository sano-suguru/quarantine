import { describe, expect, it } from "vitest";
import { frameRel, frameSnap, unframe } from "./wire";

describe("wire framing", () => {
  it("round-trips a snapshot buffer behind the snap tag", () => {
    const payload = new Uint8Array([9, 8, 7, 255, 0]).buffer;
    const u = unframe(frameSnap(payload));
    expect(u.kind).toBe("snap");
    if (u.kind === "snap") expect(new Uint8Array(u.buf)).toEqual(new Uint8Array([9, 8, 7, 255, 0]));
  });
  it("round-trips a rel object behind the rel tag", () => {
    const u = unframe(frameRel({ t: "join" }));
    expect(u.kind).toBe("rel");
    if (u.kind === "rel") expect(u.obj).toEqual({ t: "join" });
  });
  it("distinguishes the two by the leading tag byte", () => {
    expect(new Uint8Array(frameSnap(new Uint8Array([1]).buffer))[0]).toBe(1);
    expect(new Uint8Array(frameRel({}))[0]).toBe(2);
  });
});
