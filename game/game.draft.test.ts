import { describe, expect, it } from "vitest";
import { localPlayer } from "./engine/players";
import { applyDraftReroll, applyDraftTake, rollDraft } from "./game";
import { newState } from "./state";

describe("draft apply (host-authoritative)", () => {
  it("rollDraft fills an offer of offerSize and resets free/rerolls", () => {
    const s = newState();
    const p = localPlayer(s);
    rollDraft(s, p);
    expect(p.draftOffer.length).toBe(3);
    expect(p.draftFreeUsed).toBe(false);
    expect(p.draftRerolls).toBe(0);
  });

  it("first take is free and sets draftFreeUsed; card leaves the offer", () => {
    const s = newState();
    s.inShop = true;
    const p = localPlayer(s);
    p.money = 0;
    p.draftOffer = ["perk:hollowPoints", "perk:fieldMedic", "lvl:pistol"];
    const before = p.dmgMul;
    expect(applyDraftTake(s, p, "perk:hollowPoints")).toBe(true);
    expect(p.draftFreeUsed).toBe(true);
    expect(p.dmgMul).toBeCloseTo(before * 1.25);
    expect(p.money).toBe(0); // free
    expect(p.draftOffer).not.toContain("perk:hollowPoints");
  });

  it("second take costs SCRAP and is blocked when unaffordable", () => {
    const s = newState();
    s.inShop = true;
    const p = localPlayer(s);
    p.draftFreeUsed = true;
    p.money = 50; // perkCost is 80
    p.draftOffer = ["perk:fieldMedic"];
    expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(false);
    p.money = 80;
    expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(true);
    expect(p.money).toBe(0);
  });

  it("take is rejected for a card not in the offer", () => {
    const s = newState();
    s.inShop = true;
    const p = localPlayer(s);
    p.draftOffer = ["perk:fieldMedic"];
    expect(applyDraftTake(s, p, "lvl:pistol")).toBe(false);
  });

  it("reroll charges escalating SCRAP and redraws same count", () => {
    const s = newState();
    s.inShop = true;
    const p = localPlayer(s);
    p.money = 100;
    p.draftOffer = ["perk:fieldMedic", "perk:adrenaline"];
    expect(applyDraftReroll(s, p)).toBe(true); // first reroll = 30
    expect(p.money).toBe(70);
    expect(p.draftRerolls).toBe(1);
    expect(p.draftOffer.length).toBe(2);
  });

  it("reroll blocked when broke", () => {
    const s = newState();
    s.inShop = true;
    const p = localPlayer(s);
    p.money = 10;
    p.draftOffer = ["perk:fieldMedic"];
    expect(applyDraftReroll(s, p)).toBe(false);
  });
});
