import { describe, expect, it } from "vitest";
import { storeItems } from "./data/arsenal";
import { addPlayer } from "./engine/players";
import { applyBuy } from "./game";
import { newState } from "./state";
import type { State } from "./types";

/** A run-state with the shop open and the local buyer flush with credits. */
function shopState(): State {
  const s = newState();
  s.inShop = true;
  (s.players[0] as State["players"][number]).money = 9999;
  return s;
}

describe("applyBuy (host-authoritative purchase)", () => {
  it("applies a personal perk to the BUYER only, and deducts from the buyer's wallet", () => {
    const s = shopState();
    const buyer = s.players[0] as State["players"][number];
    const other = addPlayer(s, 1, 100, 0);
    const beforeMax = buyer.maxHp;
    const otherMax = other.maxHp;
    const before$ = buyer.money;
    const otherBefore$ = other.money;

    const ok = applyBuy(s, "perk:Field Medic", buyer);

    expect(ok).toBe(true);
    expect(buyer.maxHp).toBe(beforeMax + 20); // +20 integrity to the buyer
    expect(other.maxHp).toBe(otherMax); // teammate untouched
    expect(buyer.money).toBe(before$ - 80); // perkCost from the buyer's wallet
    expect(other.money).toBe(otherBefore$); // teammate's wallet untouched
  });

  it("upgrades the BUYER's own weapon level (wlevel) without touching a teammate", () => {
    const s = shopState();
    const buyer = s.players[0] as State["players"][number];
    const other = addPlayer(s, 1, 100, 0);
    const wItem = storeItems(s, buyer).find((i) => i.id.startsWith("lvl:"));
    expect(wItem).toBeTruthy();
    if (!wItem) return;
    const id = wItem.id.slice("lvl:".length);
    const before = buyer.wlevel[id] ?? 0;
    const beforeMax = buyer.maxHp;

    const ok = applyBuy(s, wItem.id, buyer);

    expect(ok).toBe(true);
    expect(buyer.wlevel[id]).toBe(before + 1); // only the buyer's copy is upgraded
    expect(other.wlevel[id] ?? 0).toBe(0); // teammate's weapon level untouched
    expect(buyer.maxHp).toBe(beforeMax); // weapon level doesn't touch personal stats
  });

  it("rejects when funds are short, the shop is closed, or the buyer is gone", () => {
    const buyer = (() => shopState().players[0])() as State["players"][number];

    const broke = shopState();
    const brokeBuyer = broke.players[0] as State["players"][number];
    brokeBuyer.money = 0;
    expect(applyBuy(broke, "perk:Field Medic", brokeBuyer)).toBe(false);
    expect(brokeBuyer.money).toBe(0);

    const closed = shopState();
    closed.inShop = false;
    expect(applyBuy(closed, "perk:Field Medic", closed.players[0])).toBe(false);

    const noBuyer = shopState();
    expect(applyBuy(noBuyer, "perk:Field Medic", undefined)).toBe(false);
    expect((noBuyer.players[0] as State["players"][number]).money).toBe(9999);

    const unknown = shopState();
    expect(applyBuy(unknown, "perk:Does Not Exist", buyer)).toBe(false);
  });
});
