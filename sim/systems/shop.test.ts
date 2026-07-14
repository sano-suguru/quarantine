import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { addPlayer, localPlayer } from "../engine/players";
import { newState } from "../state";
import { applyBuy, applyDraftReroll, applyDraftTake, rollDraft } from "./shop";

describe("applyBuy (Fortify purchase, DO-authoritative)", () => {
  const fortId = "deploy:ammostation"; // Supply Station, cost 70 (DEPLOYABLE_TYPES.ammostation)
  it("buys a fortification: deducts SCRAP and queues it", () => {
    const s = newState();
    s.phase = "day";
    const buyer = localPlayer(s);
    buyer.money = 100;
    expect(applyBuy(s, fortId, buyer)).toBe(true);
    expect(buyer.money).toBe(30);
    expect(buyer.deployQueue).toContain("ammostation");
  });
  it("rejects when unaffordable", () => {
    const s = newState();
    s.phase = "day";
    const buyer = localPlayer(s);
    buyer.money = 10;
    expect(applyBuy(s, fortId, buyer)).toBe(false);
  });
  it("rejects when the shop is closed", () => {
    const s = newState();
    s.phase = "night";
    const buyer = localPlayer(s);
    buyer.money = 100;
    expect(applyBuy(s, fortId, buyer)).toBe(false);
  });
  it("rejects with no buyer", () => {
    const s = newState();
    s.phase = "day";
    expect(applyBuy(s, fortId, undefined)).toBe(false);
  });
  it("rejects an unknown item id", () => {
    const s = newState();
    s.phase = "day";
    const buyer = localPlayer(s);
    buyer.money = 100;
    expect(applyBuy(s, "deploy:nope", buyer)).toBe(false);
  });

  it("a fortification buy queues for the buyer only, not a teammate", () => {
    const s = newState();
    s.phase = "day";
    const buyer = localPlayer(s);
    const mate = addPlayer(s, 1, 0, 0);
    const mateMoney = mate.money;
    buyer.money = 100;
    expect(applyBuy(s, fortId, buyer)).toBe(true);
    expect(buyer.deployQueue).toContain("ammostation");
    expect(buyer.money).toBe(30); // buyer's own wallet charged (100 - 70)
    expect(mate.deployQueue).not.toContain("ammostation");
    expect(mate.money).toBe(mateMoney); // teammate wallet untouched
  });
});

describe("draft apply (DO-authoritative)", () => {
  it("rollDraft fills an offer of offerSize and resets free/rerolls", () => {
    const s = newState();
    const p = localPlayer(s);
    rollDraft(s, p);
    expect(p.draftOffer.length).toBe(3);
    expect(p.draftFreePicksUsed).toBe(0);
    expect(p.draftRerolls).toBe(0);
  });

  it("first take is free (increments draftFreePicksUsed); card leaves the offer", () => {
    const s = newState();
    s.phase = "day";
    const p = localPlayer(s);
    p.money = 0;
    p.draftOffer = ["perk:hollowPoints", "perk:fieldMedic", "lvl:pistol"];
    const before = p.dmgMul;
    expect(applyDraftTake(s, p, "perk:hollowPoints")).toBe(true);
    expect(p.draftFreePicksUsed).toBe(1);
    expect(p.dmgMul).toBeCloseTo(before * 1.25);
    expect(p.money).toBe(0); // free
    expect(p.draftOffer).not.toContain("perk:hollowPoints");
  });

  it("second take costs SCRAP and is blocked when unaffordable", () => {
    const s = newState();
    s.phase = "day";
    const p = localPlayer(s);
    p.draftFreePicksUsed = CONFIG.arsenal.freePicks;
    p.money = 50; // perkCost is 80
    p.draftOffer = ["perk:fieldMedic"];
    expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(false);
    p.money = 80;
    expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(true);
    expect(p.money).toBe(0);
  });

  it("a paid take removes the card from the offer", () => {
    const s = newState();
    s.phase = "day";
    const p = localPlayer(s);
    p.draftOffer = ["perk:fieldMedic", "perk:hollowPoints"];
    p.draftFreePicksUsed = CONFIG.arsenal.freePicks; // free picks spent → next take is paid
    p.money = 1000;
    expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(true);
    expect(p.draftOffer).not.toContain("perk:fieldMedic");
  });

  it("take is rejected for a card not in the offer", () => {
    const s = newState();
    s.phase = "day";
    const p = localPlayer(s);
    p.draftOffer = ["perk:fieldMedic"];
    expect(applyDraftTake(s, p, "lvl:pistol")).toBe(false);
  });

  it("reroll charges escalating SCRAP and redraws same count", () => {
    const s = newState();
    s.phase = "day";
    const p = localPlayer(s);
    p.money = 100;
    p.draftOffer = ["perk:fieldMedic", "perk:adrenaline"];
    expect(applyDraftReroll(s, p)).toBe(true); // first reroll = 30
    expect(p.money).toBe(70);
    expect(p.draftRerolls).toBe(1);
    expect(p.draftOffer.length).toBe(2);
  });

  it("reroll cost escalates across consecutive rerolls (counter drives the price)", () => {
    const s = newState();
    s.phase = "day";
    const p = localPlayer(s);
    rollDraft(s, p);
    p.money = 200;
    expect(applyDraftReroll(s, p)).toBe(true); // 1st reroll: rerollBase (30)
    expect(applyDraftReroll(s, p)).toBe(true); // 2nd reroll: rerollBase + rerollStep (55)
    expect(p.draftRerolls).toBe(2);
    expect(p.money).toBe(200 - 30 - 55); // 115 — proves the 2nd read the incremented counter
  });

  it("reroll blocked when broke", () => {
    const s = newState();
    s.phase = "day";
    const p = localPlayer(s);
    p.money = 10;
    p.draftOffer = ["perk:fieldMedic"];
    expect(applyDraftReroll(s, p)).toBe(false);
  });

  it("honors CONFIG.arsenal.freePicks for the number of free picks", () => {
    const orig = CONFIG.arsenal.freePicks;
    CONFIG.arsenal.freePicks = 2;
    try {
      const s = newState();
      s.phase = "day";
      const p = localPlayer(s);
      p.money = 0;
      p.draftOffer = ["perk:hollowPoints", "perk:fieldMedic", "perk:adrenaline"];
      expect(applyDraftTake(s, p, "perk:hollowPoints")).toBe(true); // free 1
      expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(true); // free 2
      expect(p.money).toBe(0);
      expect(applyDraftTake(s, p, "perk:adrenaline")).toBe(false); // 3rd costs SCRAP, broke
      p.money = 80;
      expect(applyDraftTake(s, p, "perk:adrenaline")).toBe(true); // paid
      expect(p.money).toBe(0);
    } finally {
      CONFIG.arsenal.freePicks = orig; // assertion throw でも必ず復元（同ファイル後続の汚染防止）
    }
  });

  it("rollDraft clears draftTaken from the prior night", () => {
    const s = newState();
    const p = localPlayer(s);
    p.draftTaken = ["perk:hollowPoints"];
    rollDraft(s, p);
    expect(p.draftTaken).toEqual([]);
  });

  it("reroll never re-offers a perk taken this night (free path)", () => {
    const s = newState();
    s.phase = "day";
    const p = localPlayer(s);
    p.money = 1000;
    rollDraft(s, p); // resets draftTaken + free counter
    p.draftOffer = ["perk:hollowPoints", "perk:fieldMedic", "perk:adrenaline"];
    expect(applyDraftTake(s, p, "perk:hollowPoints")).toBe(true); // free
    expect(applyDraftReroll(s, p)).toBe(true);
    expect(p.draftOffer).not.toContain("perk:hollowPoints");
  });

  it("reroll never re-offers a perk taken this night (paid path)", () => {
    const s = newState();
    s.phase = "day";
    const p = localPlayer(s);
    p.draftFreePicksUsed = CONFIG.arsenal.freePicks; // force the paid branch
    p.money = 1000;
    p.draftOffer = ["perk:hollowPoints", "perk:fieldMedic", "perk:adrenaline"];
    expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(true); // paid
    expect(applyDraftReroll(s, p)).toBe(true);
    expect(p.draftOffer).not.toContain("perk:fieldMedic");
  });

  it("a perk take applies to the buyer only, not a teammate", () => {
    const s = newState();
    s.phase = "day";
    const buyer = localPlayer(s);
    const mate = addPlayer(s, 1, 0, 0);
    const mateDmg = mate.dmgMul;
    const mateHp = mate.maxHp;
    const mateMoney = mate.money;
    buyer.money = 0;
    buyer.draftOffer = ["perk:hollowPoints"]; // +25% dmg, free
    expect(applyDraftTake(s, buyer, "perk:hollowPoints")).toBe(true);
    expect(buyer.dmgMul).toBeCloseTo(1.25);
    expect(mate.dmgMul).toBe(mateDmg); // teammate untouched
    expect(mate.maxHp).toBe(mateHp);
    expect(mate.money).toBe(mateMoney);
  });

  it("a free pick cannot push a weapon past maxLevel (cardItem gates it)", () => {
    const s = newState();
    s.phase = "day";
    const p = localPlayer(s);
    p.wlevel.pistol = CONFIG.arsenal.maxLevel; // already maxed
    p.draftOffer = ["lvl:pistol"];
    p.draftFreePicksUsed = 0; // a free pick is available
    expect(applyDraftTake(s, p, "lvl:pistol")).toBe(false); // rejected before the free branch
    expect(p.wlevel.pistol).toBe(CONFIG.arsenal.maxLevel); // unchanged
  });

  it("a taken weapon card is NOT recorded in draftTaken (may resurface on reroll)", () => {
    const s = newState();
    s.phase = "day";
    const p = localPlayer(s);
    s.owned.pistol = true;
    rollDraft(s, p);
    p.draftOffer = ["lvl:pistol"];
    p.draftFreePicksUsed = 0; // take it free
    expect(applyDraftTake(s, p, "lvl:pistol")).toBe(true);
    expect(p.draftTaken).not.toContain("lvl:pistol"); // weapon cards are intentionally not excluded
    expect(p.wlevel.pistol).toBe(1); // the upgrade applied
  });
});
