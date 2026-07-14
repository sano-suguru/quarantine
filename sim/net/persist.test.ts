import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { newState } from "../state";
import { applyCycle, SCHEMA_VERSION, serializeCycle } from "./persist";

describe("serializeCycle", () => {
  it("captures the communal fields and stamps the schema version", () => {
    const s = newState();
    s.day = 5;
    s.phase = "night";
    s.phaseT = 12.5;
    s.salvageBanked = 240;
    s.kills = 88;
    const b0 = s.barricades[0] as (typeof s.barricades)[number];
    b0.hp = 3;
    const c0 = s.caches[0] as (typeof s.caches)[number];
    c0.looted = true;

    const blob = serializeCycle(s);
    expect(blob.schemaVersion).toBe(SCHEMA_VERSION);
    expect(blob.day).toBe(5);
    expect(blob.phase).toBe("night");
    expect(blob.phaseT).toBe(12.5);
    expect(blob.salvageBanked).toBe(240);
    expect(blob.kills).toBe(88);
    expect(blob.barricades.length).toBe(s.barricades.length);
    expect(blob.barricades[0]).toBe(3);
    expect(blob.caches.length).toBe(s.caches.length);
    expect(blob.caches[0]).toBe(true);
  });
});

describe("applyCycle", () => {
  it("round-trips the communal state onto a fresh state", () => {
    const src = newState();
    src.day = 7;
    src.phase = "night";
    src.phaseT = 9;
    src.salvageBanked = 100;
    src.kills = 42;
    (src.barricades[1] as (typeof src.barricades)[number]).hp = 17;
    (src.caches[0] as (typeof src.caches)[number]).looted = true;
    const blob = serializeCycle(src);

    const dst = newState(); // fresh: day 1, full barricades, unlooted caches
    applyCycle(dst, blob);

    expect(dst.day).toBe(7);
    expect(dst.phase).toBe("night");
    expect(dst.phaseT).toBe(9);
    expect(dst.salvageBanked).toBe(100);
    expect(dst.kills).toBe(42);
    expect((dst.barricades[1] as (typeof dst.barricades)[number]).hp).toBe(17);
    expect((dst.caches[0] as (typeof dst.caches)[number]).looted).toBe(true);
    // untouched communal defaults remain
    expect((dst.barricades[0] as (typeof dst.barricades)[number]).hp).toBe(CONFIG.siege.boardMaxHp);
  });
});
