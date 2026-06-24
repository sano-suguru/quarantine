import type { Upgrade } from "../types";

const pct = (m: number): string => `${Math.round(m * 100)}%`;

export const UPGRADES: Upgrade[] = [
  {
    name: "Field Medic",
    desc: "+20 max integrity, heal full",
    apply: (s) => {
      s.player.maxHp += 20;
      s.player.hp = s.player.maxHp;
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
    name: "Field Kit",
    desc: "Heal to full now",
    apply: (s) => {
      s.player.hp = s.player.maxHp;
    },
    preview: (s) => `integrity ${Math.ceil(s.player.hp)} → ${s.player.maxHp}`,
  },
];
