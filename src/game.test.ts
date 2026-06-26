import { describe, expect, it } from "vitest";
import { storeItems } from "./data/arsenal";
import { addPlayer } from "./engine/players";
import { applyBuy } from "./game";
import { newState } from "./state";
import type { State } from "./types";

/** A run-state with the shop open and plenty of credits. */
function shopState(): State {
  const s = newState();
  s.inShop = true;
  s.money = 9999;
  return s;
}

describe("applyBuy (host-authoritative purchase)", () => {
  it("applies a personal perk to the BUYER only, and deducts credits", () => {
    const s = shopState();
    const buyer = s.players[0] as State["players"][number];
    const other = addPlayer(s, 1, 100, 0);
    const beforeMax = buyer.maxHp;
    const otherMax = other.maxHp;
    const before$ = s.money;

    const ok = applyBuy(s, "perk:Field Medic", buyer);

    expect(ok).toBe(true);
    expect(buyer.maxHp).toBe(beforeMax + 20); // +20 integrity to the buyer
    expect(other.maxHp).toBe(otherMax); // teammate untouched
    expect(s.money).toBe(before$ - 80); // perkCost
  });

  it("upgrades the shared weapon level (wlevel) without touching the buyer's stats", () => {
    const s = shopState();
    const buyer = s.players[0] as State["players"][number];
    const wItem = storeItems(s).find((i) => i.id.startsWith("lvl:"));
    expect(wItem).toBeTruthy();
    if (!wItem) return;
    const id = wItem.id.slice("lvl:".length);
    const before = s.wlevel[id] ?? 0;
    const beforeMax = buyer.maxHp;

    const ok = applyBuy(s, wItem.id, buyer);

    expect(ok).toBe(true);
    expect(s.wlevel[id]).toBe(before + 1);
    expect(buyer.maxHp).toBe(beforeMax); // weapon level is shared, not personal
  });

  it("rejects when funds are short, the shop is closed, or the buyer is gone", () => {
    const buyer = (() => shopState().players[0])() as State["players"][number];

    const broke = shopState();
    broke.money = 0;
    expect(applyBuy(broke, "perk:Field Medic", broke.players[0])).toBe(false);
    expect(broke.money).toBe(0);

    const closed = shopState();
    closed.inShop = false;
    expect(applyBuy(closed, "perk:Field Medic", closed.players[0])).toBe(false);

    const noBuyer = shopState();
    expect(applyBuy(noBuyer, "perk:Field Medic", undefined)).toBe(false);
    expect(noBuyer.money).toBe(9999);

    const unknown = shopState();
    expect(applyBuy(unknown, "perk:Does Not Exist", buyer)).toBe(false);
  });
});
