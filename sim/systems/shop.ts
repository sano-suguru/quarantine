import { CONFIG } from "../config";
import { cardItem, draftPool, rerollCost, rollOffer, storeItems } from "../data/arsenal";
import { DEPLOYABLE_TYPES, deployableCount, placeDeployable, placeSpot } from "../data/deployables";
import type { Player, State } from "../types";

/**
 * Authoritative shop logic. Headless (sim/), called by the DO on the buy/place/draft CoopEvents.
 * Purchasing (buy/draftTake/draftReroll) is day-only — the client only opens the shop overlay at
 * the fortress workbench during the day, and the DO enforces `phase === "day"` as the gate.
 * Placement (applyPlace) is night-legal (drop a bought turret mid-siege) and unchanged.
 */

/** Apply a purchase. `buyer` is the player who paid. False (no change) if it's not day, the buyer
 *  is gone, or the item can't be afforded. */
export function applyBuy(s: State, itemId: string, buyer: Player | undefined): boolean {
  if (s.phase !== "day" || !buyer) return false;
  const it = storeItems(s, buyer).find((x) => x.id === itemId);
  if (!it?.canBuy(s, buyer)) return false;
  buyer.money -= it.price;
  it.buy(s, buyer);
  return true;
}

/** Place the front of `player`'s deploy queue in front of them. Night-legal (no phase gate).
 *  False (no change) if down, empty queue, at the type cap, or no valid spot. */
export function applyPlace(s: State, player: Player | undefined): boolean {
  if (!player || player.hp <= 0) return false;
  const defId = player.deployQueue[0];
  if (!defId) return false;
  const def = DEPLOYABLE_TYPES[defId];
  if (!def || deployableCount(s, defId) >= def.cap) return false;
  const spot = placeSpot(s, player, def);
  if (!spot) return false;
  placeDeployable(s, defId, spot.x, spot.y);
  player.deployQueue.shift();
  return true;
}

/** Roll a fresh nightly draft offer for player `p` and reset their free-pick + reroll counters. */
export function rollDraft(state: State, p: Player): void {
  p.draftOffer = rollOffer(draftPool(state, p), CONFIG.arsenal.offerSize).map((it) => it.id);
  p.draftFreePicksUsed = 0;
  p.draftRerolls = 0;
  p.draftTaken = [];
}

/** Apply a draft "take": first CONFIG.arsenal.freePicks takes are free, further ones cost SCRAP. */
export function applyDraftTake(s: State, buyer: Player | undefined, cardId: string): boolean {
  if (s.phase !== "day" || !buyer?.draftOffer.includes(cardId)) return false;
  const it = cardItem(s, buyer, cardId);
  if (!it) return false;
  if (buyer.draftFreePicksUsed < CONFIG.arsenal.freePicks) {
    it.buy(s, buyer);
    buyer.draftFreePicksUsed += 1;
  } else {
    if (!it.canBuy(s, buyer)) return false;
    buyer.money -= it.price;
    it.buy(s, buyer);
  }
  if (cardId.startsWith("perk:")) buyer.draftTaken.push(cardId);
  buyer.draftOffer = buyer.draftOffer.filter((id) => id !== cardId);
  return true;
}

/** Apply a draft reroll: charge escalating SCRAP, bump the counter, redraw the shown cards. */
export function applyDraftReroll(s: State, buyer: Player | undefined): boolean {
  if (s.phase !== "day" || !buyer || buyer.draftOffer.length === 0) return false;
  const cost = rerollCost(buyer.draftRerolls);
  if (buyer.money < cost) return false;
  buyer.money -= cost;
  buyer.draftRerolls += 1;
  buyer.draftOffer = rollOffer(draftPool(s, buyer), buyer.draftOffer.length, buyer.draftTaken).map(
    (it) => it.id,
  );
  return true;
}
