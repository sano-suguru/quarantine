import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { localPlayer } from "../engine/players";
import { newState } from "../state";
import type { Pickup, Player, State } from "../types";
import { spawnPickup, sysPickups } from "./pickups";

/** Drop a pickup at an exact spot (bypassing spawnPickup's RNG scatter, so collection is deterministic). */
function placePickup(s: State, x: number, y: number, defId: string): Pickup {
  const pk: Pickup = {
    id: 1,
    x,
    y,
    defId,
    life: CONFIG.ammo.pickupLife,
    maxLife: CONFIG.ammo.pickupLife,
    bob: 0,
  };
  s.pickups.push(pk);
  return pk;
}

describe("sysPickups", () => {
  it("decays a pickup and removes it once its life runs out", () => {
    const s = newState();
    s.players = [];
    const pk = placePickup(s, 9999, 9999, "ammo"); // far from any player
    pk.life = 0.01;
    sysPickups(s, 1);
    expect(s.pickups.length).toBe(0);
  });

  it("leaves a still-living pickup that no player is standing on", () => {
    const s = newState();
    const p = s.players[0] as Player;
    placePickup(s, p.x + 1000, p.y + 1000, "ammo");
    sysPickups(s, 1);
    expect(s.pickups.length).toBe(1);
  });

  it("auto-collects a pickup within grab range of an alive player and applies its effect", () => {
    const s = newState();
    const p = s.players[0] as Player;
    p.weapon = "pistol";
    p.reserve.pistol = 0;
    placePickup(s, p.x, p.y, "ammo"); // right on top of the player
    sysPickups(s, 0.1);
    expect(s.pickups.length).toBe(0); // collected & removed
    expect(p.reserve.pistol).toBeGreaterThan(0); // ammo applied
  });

  it("does not let a downed player collect", () => {
    const s = newState();
    const p = s.players[0] as Player;
    p.hp = 0;
    placePickup(s, p.x, p.y, "ammo");
    sysPickups(s, 0.1);
    expect(s.pickups.length).toBe(1); // still on the ground
  });

  it("auto-collecting a pickup pushes a pickup event", () => {
    const s = newState();
    const p = localPlayer(s);
    spawnPickup(s, p.x, p.y, "ammo"); // within grab radius
    sysPickups(s, 1 / 60);
    expect(s.fxEvents.some((e) => e.t === "pickup")).toBe(true);
  });
});
