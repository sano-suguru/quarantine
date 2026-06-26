import { CONFIG } from "../config";
import type { Upgrade } from "../types";
import { WEAPONS, WEAPON_ORDER } from "./weapons";

const pct = (m: number): string => `${Math.round(m * 100)}%`;

// Perks split into two kinds: run-wide multipliers (s.* — affect the whole party) and
// personal stats (p.* — apply to the buying player). The buyer is passed in as `p`.
export const UPGRADES: Upgrade[] = [
  {
    name: "Field Medic",
    desc: "+20 max integrity, +1 medkit",
    apply: (_s, p) => {
      p.maxHp += 20;
      p.medkits = Math.min(CONFIG.heal.maxMedkits, p.medkits + 1);
    },
    preview: (_s, p) => `integrity ${p.maxHp} → ${p.maxHp + 20}`,
  },
  {
    name: "Hollow Points",
    desc: "+25% weapon damage",
    apply: (s) => {
      s.dmgMul *= 1.25;
    },
    preview: (s) => `damage ${pct(s.dmgMul)} → ${pct(s.dmgMul * 1.25)}`,
  },
  {
    name: "Adrenaline",
    desc: "+12% movement speed",
    apply: (_s, p) => {
      p.speed *= 1.12;
    },
    preview: (_s, p) => `speed ${Math.round(p.speed)} → ${Math.round(p.speed * 1.12)}`,
  },
  {
    name: "Quick Hands",
    desc: "+30% fire rate",
    apply: (s) => {
      s.fireRateMul *= 1.3;
    },
    preview: (s) => `fire rate ${pct(s.fireRateMul)} → ${pct(s.fireRateMul * 1.3)}`,
  },
  {
    name: "First Aid Cache",
    desc: "+2 medkits",
    apply: (_s, p) => {
      p.medkits = Math.min(CONFIG.heal.maxMedkits, p.medkits + 2);
    },
    preview: (_s, p) => `medkits ${p.medkits} → ${Math.min(CONFIG.heal.maxMedkits, p.medkits + 2)}`,
  },
  {
    name: "Bandolier",
    desc: "+50% spare ammo capacity, top off now",
    apply: (s, p) => {
      s.reserveMul *= 1.5;
      for (const id of WEAPON_ORDER) {
        const w = WEAPONS[id];
        if (!w || w.melee) continue;
        p.reserve[id] = Math.round(w.reserveMax * s.reserveMul);
      }
    },
    preview: (s) => `spare capacity ${pct(s.reserveMul)} → ${pct(s.reserveMul * 1.5)}`,
  },
  {
    name: "Scavenger",
    desc: "Full resupply — all magazines and spare ammo",
    apply: (s, p) => {
      for (const id of WEAPON_ORDER) {
        const w = WEAPONS[id];
        if (!w || w.melee) continue;
        p.reserve[id] = Math.round(w.reserveMax * s.reserveMul);
        p.mags[id] = w.mag;
      }
      p.ammo = WEAPONS[p.weapon]?.mag ?? p.ammo;
    },
    preview: () => "all ammo → full",
  },
];
