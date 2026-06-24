import { CONFIG } from "../config";
import type { Upgrade } from "../types";
import { WEAPONS, WEAPON_ORDER } from "./weapons";

const pct = (m: number): string => `${Math.round(m * 100)}%`;

export const UPGRADES: Upgrade[] = [
  {
    name: "Field Medic",
    desc: "+20 max integrity, +1 medkit",
    apply: (s) => {
      s.player.maxHp += 20;
      s.player.medkits = Math.min(CONFIG.heal.maxMedkits, s.player.medkits + 1);
    },
    preview: (s) => `integrity ${s.player.maxHp} → ${s.player.maxHp + 20}`,
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
    apply: (s) => {
      s.player.speed *= 1.12;
    },
    preview: (s) => `speed ${Math.round(s.player.speed)} → ${Math.round(s.player.speed * 1.12)}`,
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
    apply: (s) => {
      s.player.medkits = Math.min(CONFIG.heal.maxMedkits, s.player.medkits + 2);
    },
    preview: (s) =>
      `medkits ${s.player.medkits} → ${Math.min(CONFIG.heal.maxMedkits, s.player.medkits + 2)}`,
  },
  {
    name: "Bandolier",
    desc: "+50% spare ammo capacity, top off now",
    apply: (s) => {
      s.reserveMul *= 1.5;
      for (const id of WEAPON_ORDER) {
        const w = WEAPONS[id];
        if (!w || w.melee) continue;
        s.player.reserve[id] = Math.round(w.reserveMax * s.reserveMul);
      }
    },
    preview: (s) => `spare capacity ${pct(s.reserveMul)} → ${pct(s.reserveMul * 1.5)}`,
  },
  {
    name: "Scavenger",
    desc: "Full resupply — all magazines and spare ammo",
    apply: (s) => {
      for (const id of WEAPON_ORDER) {
        const w = WEAPONS[id];
        if (!w || w.melee) continue;
        s.player.reserve[id] = Math.round(w.reserveMax * s.reserveMul);
        s.player.mags[id] = w.mag;
      }
      s.player.ammo = WEAPONS[s.player.weapon]?.mag ?? s.player.ammo;
    },
    preview: () => "all ammo → full",
  },
];
