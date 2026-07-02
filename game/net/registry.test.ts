import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG } from "../config";
import { PROTOCOL_VERSION } from "./net";
import { isJoinable, listRooms, type RoomInfo, selectQuickMatch, versionMatches } from "./registry";

const room = (over: Partial<RoomInfo>): RoomInfo => ({
  code: "AAAA",
  v: PROTOCOL_VERSION,
  players: 1,
  max: 4,
  phase: "lobby",
  day: 1,
  lastSeen: 0,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("listRooms", () => {
  it("rejects when the room browser request hangs", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    const result = listRooms().then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );

    await vi.advanceTimersByTimeAsync(CONFIG.net.registryFetchTimeoutMs);

    await expect(result).resolves.toBe("rooms unavailable");
  });
});

describe("versionMatches", () => {
  it("matches our version, a null (pre-D) host, but not a different version", () => {
    expect(versionMatches(room({ v: PROTOCOL_VERSION }))).toBe(true);
    expect(versionMatches(room({ v: null }))).toBe(true);
    expect(versionMatches(room({ v: PROTOCOL_VERSION + 1 }))).toBe(false);
  });
});

describe("isJoinable", () => {
  it("needs a compatible build and a free slot", () => {
    expect(isJoinable(room({ players: 3, max: 4 }))).toBe(true);
    expect(isJoinable(room({ players: 4, max: 4 }))).toBe(false); // full
    expect(isJoinable(room({ v: PROTOCOL_VERSION + 1 }))).toBe(false); // incompatible
  });
});

describe("selectQuickMatch", () => {
  it("drops full + incompatible rooms", () => {
    const out = selectQuickMatch([
      room({ code: "FULL", players: 4 }),
      room({ code: "OLD", v: PROTOCOL_VERSION + 1 }),
      room({ code: "OK", players: 2 }),
    ]);
    expect(out.map((r) => r.code)).toEqual(["OK"]);
  });

  it("prefers immediately-playable (lobby/day) over night, then fuller first", () => {
    const out = selectQuickMatch([
      room({ code: "NIGHT3", phase: "night", players: 3 }),
      room({ code: "DAY1", phase: "day", players: 1 }),
      room({ code: "LOBBY3", phase: "lobby", players: 3 }),
    ]);
    // night ranks last despite being fuller; within the playable tier, fuller (LOBBY3) leads
    expect(out.map((r) => r.code)).toEqual(["LOBBY3", "DAY1", "NIGHT3"]);
  });
});
