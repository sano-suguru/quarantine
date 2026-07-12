import { describe, expect, it } from "vitest";
import { newState } from "../state";
import type { Player } from "../types";
import {
  addPlayer,
  anyAlive,
  cameraTarget,
  localPlayer,
  makePlayer,
  nearestPlayer,
  removePlayer,
  revivePlayer,
} from "./players";

describe("players helpers (multiplayer)", () => {
  it("makePlayer seeds id/name/position, full hp, and the pistol magazine", () => {
    const p = makePlayer(2, 10, 20);
    expect(p.id).toBe(2);
    expect(p.name).toBe("P3");
    expect(p.x).toBe(10);
    expect(p.y).toBe(20);
    expect(p.hp).toBe(p.maxHp);
    expect(p.weapon).toBe("pistol");
    expect(p.ammo).toBe(p.mags.pistol);
  });

  it("localPlayer returns the entry matching state.localId", () => {
    const s = newState();
    addPlayer(s, 1, 100, 0);
    expect(localPlayer(s).id).toBe(0); // default localId
    s.localId = 1;
    expect(localPlayer(s).id).toBe(1);
  });

  it("nearestPlayer picks the closest alive player, skips the dead, null when wiped", () => {
    const s = newState(); // player 0 at (0,0)
    addPlayer(s, 1, 200, 0); // player 1 at (200,0)
    expect(nearestPlayer(s, 190, 0)?.id).toBe(1);
    expect(nearestPlayer(s, 10, 0)?.id).toBe(0);

    // down player 1 → even points next to it now resolve to the only survivor
    (s.players.find((p) => p.id === 1) as Player).hp = 0;
    expect(nearestPlayer(s, 190, 0)?.id).toBe(0);

    // whole party down → null, and anyAlive reports false
    for (const p of s.players) p.hp = 0;
    expect(nearestPlayer(s, 0, 0)).toBeNull();
    expect(anyAlive(s)).toBe(false);
  });

  it("addPlayer/removePlayer maintain the roster (swap-and-pop)", () => {
    const s = newState();
    addPlayer(s, 1, 0, 0);
    addPlayer(s, 2, 0, 0);
    expect(s.players).toHaveLength(3);
    removePlayer(s, 1);
    expect(s.players.map((p) => p.id).sort()).toEqual([0, 2]);
  });

  it("each player carries independent ammo/reserve (not shared)", () => {
    const s = newState();
    const p1 = addPlayer(s, 1, 0, 0);
    const p0 = localPlayer(s);
    p0.ammo = 3;
    p1.ammo = 99;
    expect(p0.ammo).toBe(3);
    expect(p1.ammo).toBe(99);
    expect(p0.reserve).not.toBe(p1.reserve); // distinct objects
  });

  it("cameraTarget follows yourself while alive, a teammate while down, self when wiped", () => {
    const s = newState();
    addPlayer(s, 1, 300, 0);
    // alive → yourself
    expect(cameraTarget(s).id).toBe(0);
    // down → nearest living teammate
    (localPlayer(s) as Player).hp = 0;
    expect(cameraTarget(s).id).toBe(1);
    // whole party wiped → fall back to yourself (no crash)
    for (const p of s.players) p.hp = 0;
    expect(cameraTarget(s).id).toBe(0);
  });

  it("revivePlayer restores full hp at HOME and keeps gear, clearing input", () => {
    const s = newState();
    const p = localPlayer(s);
    p.maxHp = 130; // a perk raised max integrity
    p.hp = 0;
    p.reserve.pistol = 7;
    p.medkits = 2;
    p.weapon = "shotgun";
    p.reloadT = 0.5;
    p.input.moveX = 1;
    p.input.heal = true;

    revivePlayer(s, p);

    expect(p.hp).toBe(130); // full, respecting the raised maxHp
    expect(Math.abs(p.y - 80)).toBeLessThan(1); // HOME spawn row
    expect(Math.abs(p.x)).toBeLessThan(120); // inside HOME
    expect(p.reserve.pistol).toBe(7); // spare ammo kept
    expect(p.medkits).toBe(2); // medkits kept
    expect(p.weapon).toBe("shotgun"); // weapon kept
    expect(p.reloadT).toBe(0); // timers reset
    expect(p.input.moveX).toBe(0); // input cleared (no respawn-edge fire)
    expect(p.input.heal).toBe(false);
  });
});
