import { describe, expect, it } from "vitest";
import { addPlayer, localPlayer } from "./engine/players";
import { applyBuy } from "./game";
import { newState } from "./state";

describe("applyBuy (Fortify purchase, host-authoritative)", () => {
  const fortId = "deploy:ammostation"; // Supply Station, cost 70 (DEPLOYABLE_TYPES.ammostation)
  it("buys a fortification: deducts SCRAP and queues it", () => {
    const s = newState();
    s.inShop = true;
    const buyer = localPlayer(s);
    buyer.money = 100;
    expect(applyBuy(s, fortId, buyer)).toBe(true);
    expect(buyer.money).toBe(30);
    expect(buyer.deployQueue).toContain("ammostation");
  });
  it("rejects when unaffordable", () => {
    const s = newState();
    s.inShop = true;
    const buyer = localPlayer(s);
    buyer.money = 10;
    expect(applyBuy(s, fortId, buyer)).toBe(false);
  });
  it("rejects when the shop is closed", () => {
    const s = newState();
    s.inShop = false;
    const buyer = localPlayer(s);
    buyer.money = 100;
    expect(applyBuy(s, fortId, buyer)).toBe(false);
  });
  it("rejects with no buyer", () => {
    const s = newState();
    s.inShop = true;
    expect(applyBuy(s, fortId, undefined)).toBe(false);
  });
  it("rejects an unknown item id", () => {
    const s = newState();
    s.inShop = true;
    const buyer = localPlayer(s);
    buyer.money = 100;
    expect(applyBuy(s, "deploy:nope", buyer)).toBe(false);
  });

  it("a fortification buy queues for the buyer only, not a teammate", () => {
    const s = newState();
    s.inShop = true;
    const buyer = localPlayer(s);
    const mate = addPlayer(s, 1, 0, 0);
    const mateMoney = mate.money;
    buyer.money = 100;
    expect(applyBuy(s, fortId, buyer)).toBe(true);
    expect(buyer.deployQueue).toContain("ammostation");
    expect(mate.deployQueue).not.toContain("ammostation");
    expect(mate.money).toBe(mateMoney); // teammate wallet untouched
  });
});
