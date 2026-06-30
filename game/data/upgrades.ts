import { CONFIG } from "../config";
import type { Upgrade } from "../types";
import { WEAPON_ORDER, WEAPONS } from "./weapons";

const pct = (m: number): string => `${Math.round(m * 100)}%`;

// Every perk is personal now (co-op individual wallets): it applies to the buying player
// `p` only. The `s` arg is kept for signature symmetry and any future run-wide table lookups.
export const UPGRADES: Upgrade[] = [
  {
    id: "fieldMedic",
    starter: true,
    name: "Field Medic",
    desc: "+20 max integrity, +1 medkit",
    apply: (_s, p) => {
      p.maxHp += 20;
      p.medkits = Math.min(CONFIG.heal.maxMedkits, p.medkits + 1);
    },
    preview: (_s, p) => `integrity ${p.maxHp} → ${p.maxHp + 20}`,
  },
  {
    id: "hollowPoints",
    starter: true,
    name: "Hollow Points",
    desc: "+25% weapon damage",
    apply: (_s, p) => {
      p.dmgMul *= 1.25;
    },
    preview: (_s, p) => `damage ${pct(p.dmgMul)} → ${pct(p.dmgMul * 1.25)}`,
  },
  {
    id: "adrenaline",
    starter: true,
    name: "Adrenaline",
    desc: "+12% movement speed",
    apply: (_s, p) => {
      p.speed *= 1.12;
    },
    preview: (_s, p) => `speed ${Math.round(p.speed)} → ${Math.round(p.speed * 1.12)}`,
  },
  {
    id: "quickHands",
    starter: false,
    name: "Quick Hands",
    desc: "+30% fire rate",
    apply: (_s, p) => {
      p.fireRateMul *= 1.3;
    },
    preview: (_s, p) => `fire rate ${pct(p.fireRateMul)} → ${pct(p.fireRateMul * 1.3)}`,
  },
  {
    id: "firstAid",
    starter: false,
    name: "First Aid Cache",
    desc: "+2 medkits",
    apply: (_s, p) => {
      p.medkits = Math.min(CONFIG.heal.maxMedkits, p.medkits + 2);
    },
    preview: (_s, p) => `medkits ${p.medkits} → ${Math.min(CONFIG.heal.maxMedkits, p.medkits + 2)}`,
  },
  {
    id: "bandolier",
    starter: false,
    name: "Bandolier",
    desc: "+50% spare ammo capacity, top off now",
    apply: (_s, p) => {
      p.reserveMul *= 1.5;
      for (const id of WEAPON_ORDER) {
        const w = WEAPONS[id];
        if (!w || w.melee) continue;
        p.reserve[id] = Math.round(w.reserveMax * p.reserveMul);
      }
    },
    preview: (_s, p) => `spare capacity ${pct(p.reserveMul)} → ${pct(p.reserveMul * 1.5)}`,
  },
  {
    id: "scavenger",
    starter: false,
    name: "Scavenger",
    desc: "Full resupply — all magazines and spare ammo",
    apply: (_s, p) => {
      for (const id of WEAPON_ORDER) {
        const w = WEAPONS[id];
        if (!w || w.melee) continue;
        p.reserve[id] = Math.round(w.reserveMax * p.reserveMul);
        p.mags[id] = w.mag;
      }
      p.ammo = WEAPONS[p.weapon]?.mag ?? p.ammo;
    },
    preview: () => "all ammo → full",
  },
];

/** Perk cards unlocked via SALVAGE (id = `card:<perkId>`). Append-only for save compatibility. */
export const UNLOCKABLE_CARDS: { id: string; price: number }[] = [
  { id: "card:quickHands", price: 60 },
  { id: "card:firstAid", price: 60 },
  { id: "card:bandolier", price: 80 },
  { id: "card:scavenger", price: 100 },
];
