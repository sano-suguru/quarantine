import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { WEAPONS } from "../data/weapons";
import { addPlayer } from "../engine/players";
import { emptyInput } from "../net/playerInput";
import { newState } from "../state";
import type { State } from "../types";
import { integrateMovement, sysPlayer } from "./player";

/**
 * Regression: in co-op, a non-searching teammate's interact() used to reset every other
 * player's in-progress cache search each tick (the per-player "reset un-searched caches"
 * loop), pinning searchT to ~one frame. The reset now runs once after all players, only
 * for caches nobody is on.
 */
describe("co-op cache search", () => {
  it("accumulates for the searcher and isn't wiped by an idle teammate", () => {
    const s = newState();
    s.phase = "day";
    s.barricades.length = 0; // no nearby barricade so repair doesn't take priority
    const cache = s.caches[0] as State["caches"][number];
    cache.looted = false;

    // host (id 0) idle and far away; client (id 1) standing on the cache, holding E
    const p0 = s.players[0] as State["players"][number];
    p0.x = 9999;
    p0.y = 9999;
    p0.input = { ...p0.input, interactHeld: false, moveX: 0, moveY: 0 };
    const p1 = addPlayer(s, 1, cache.x, cache.y);
    p1.input = { ...p1.input, interactHeld: true, moveX: 0, moveY: 0 };

    for (let i = 0; i < 5; i++) sysPlayer(s, 0.05); // 0.25s of searching, below searchTime

    // with the bug this would be stuck near one frame (~0.05); fixed it accumulates
    expect(cache.searchT).toBeGreaterThan(0.2);
  });
});

/** Phase 3: repairing the shared barricade is near-free support labor (refund < cost,
 *  scaled by hp actually restored) — viable for a support role, never a money fountain. */
describe("repair labor reward", () => {
  function repairSetup(barHp: number): { s: State; p: State["players"][number] } {
    const s = newState();
    s.phase = "day";
    s.caches.length = 0; // no cache nearby so repair is the chosen interaction
    const bar = s.barricades[0] as State["barricades"][number];
    bar.hp = barHp;
    const p = s.players[0] as State["players"][number];
    p.x = (bar.x1 + bar.x2) / 2;
    p.y = (bar.y1 + bar.y2) / 2;
    p.money = 100;
    p.input = { ...p.input, interactHeld: true, moveX: 0, moveY: 0 };
    return { s, p };
  }

  it("refunds most of the cost when the wall takes a full repair's worth of damage", () => {
    const { s, p } = repairSetup(10); // far below max → a full repairAmount is restored
    sysPlayer(s, 0.05);
    // net = -repairCost + repairReward (full effect), always negative (no profit)
    const net = p.money - 100;
    expect(net).toBe(-(CONFIG.siege.repairCost - CONFIG.econ.repairReward));
    expect(net).toBeLessThan(0); // anti-fountain: repairing never profits
  });

  it("scales the refund down with hp actually restored (effect-linked)", () => {
    const bar0 = newState().barricades[0] as State["barricades"][number];
    const max = bar0.maxHp;
    const { s, p } = repairSetup(max - 10); // only 10 hp of room → small restore
    sysPlayer(s, 0.05);
    const reward = Math.round(CONFIG.econ.repairReward * (10 / CONFIG.siege.repairAmount));
    expect(p.money).toBe(100 - CONFIG.siege.repairCost + reward);
  });
});

/** Phase B: E heals the nearest hurt teammate by spending one of YOUR medkits (instant). */
describe("co-op heal teammate (E)", () => {
  it("spends a medkit to heal a nearby hurt teammate", () => {
    const s = newState();
    s.barricades.length = 0; // no wall so the teammate is the only E target
    const healer = s.players[0] as State["players"][number];
    healer.x = 0;
    healer.y = 0;
    healer.medkits = 2;
    healer.input = { ...healer.input, interactHeld: true, moveX: 0, moveY: 0 };
    const mate = addPlayer(s, 1, 30, 0);
    mate.hp = 40;

    sysPlayer(s, 0.05);

    expect(healer.medkits).toBe(1); // spent one
    expect(mate.hp).toBe(Math.min(mate.maxHp, 40 + CONFIG.heal.amount));
  });

  it("does nothing when the healer has no medkit (no heal target)", () => {
    const s = newState();
    s.barricades.length = 0;
    const healer = s.players[0] as State["players"][number];
    healer.medkits = 0;
    healer.input = { ...healer.input, interactHeld: true };
    const mate = addPlayer(s, 1, 30, 0);
    mate.hp = 40;

    sysPlayer(s, 0.05);

    expect(mate.hp).toBe(40); // untouched
    expect(healer.medkits).toBe(0);
  });
});

describe("integrateMovement (weapon-weight move multiplier)", () => {
  const move = (moveMul?: number) => {
    const p = { x: 0, y: 0, r: 16, speed: 200 };
    integrateMovement(p, { ...emptyInput(), moveX: 1 }, [], 0.1, moveMul);
    return p.x;
  };

  it("scales distance by moveMul", () => {
    expect(move(1)).toBeCloseTo(20, 6); // 200 * 1 * 0.1
    expect(move(0.5)).toBeCloseTo(10, 6); // half speed
  });

  it("defaults to 1.0 when moveMul is omitted", () => {
    expect(move(undefined)).toBeCloseTo(20, 6);
  });

  it("moveMul = 0 means no movement (distinct from the omitted default)", () => {
    expect(move(0)).toBe(0);
  });

  it("normalizes diagonal input so speed is constant", () => {
    const p = { x: 0, y: 0, r: 16, speed: 200 };
    integrateMovement(p, { ...emptyInput(), moveX: 1, moveY: 1 }, [], 0.1, 1);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(20, 4);
  });
});

describe("sysPlayer — move-weight ramp & weapon switch", () => {
  it("ramps curMoveMul toward the equipped weapon's moveMul (no instant snap on a big gap)", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    p.curMoveMul = 0.5; // far from pistol's 1.12
    p.input = emptyInput();
    sysPlayer(s, 0.1); // step = moveRampRate(1.5) * 0.1 = 0.15
    expect(p.curMoveMul).toBeCloseTo(0.65, 6); // 0.5 + 0.15, still short of 1.12
  });

  it("ramps fully once within a step of the target", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    const target = WEAPONS.pistol?.moveMul ?? 1;
    p.curMoveMul = target - 0.05;
    p.input = emptyInput();
    sysPlayer(s, 0.1);
    expect(p.curMoveMul).toBeCloseTo(target, 6);
  });

  it("switches to an owned weapon and applies the fire raise (no instant fire)", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    p.input = { ...emptyInput(), weaponSlot: 1 }; // smg (owned starter)
    sysPlayer(s, 0.016);
    expect(p.weapon).toBe("smg");
    // raise sets fireCd to switchRaise, then this tick decrements it once
    expect(p.fireCd).toBeGreaterThan(CONFIG.player.switchRaise - 0.02);
    expect(p.input.weaponSlot).toBeNull(); // edge consumed (no double-switch next sub-step)
  });

  it("ignores a switch to a weapon you don't own", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    p.input = { ...emptyInput(), weaponSlot: 3 }; // rifle — meta-locked, not owned at run start
    sysPlayer(s, 0.016);
    expect(p.weapon).toBe("pistol");
  });

  it("does not move while healing, but the ramp still advances (host/client stay in sync)", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    p.healT = 1; // rooted
    p.curMoveMul = 0.5;
    p.input = { ...emptyInput(), moveX: 1 };
    sysPlayer(s, 0.1);
    expect(p.x).toBe(0); // rooted: no movement
    expect(p.curMoveMul).toBeCloseTo(0.65, 6); // ramp still progressed
  });
});
