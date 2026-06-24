import type { WeaponDef } from "../types";

export const WEAPONS: Record<string, WeaponDef> = {
  pistol: {
    name: "PISTOL",
    dmg: 24,
    fireRate: 5,
    bulletSpeed: 900,
    spread: 0.02,
    pellets: 1,
    mag: 12,
    reload: 0.9,
    range: 0.9,
    auto: false,
  },
  smg: {
    name: "SMG",
    dmg: 14,
    fireRate: 14,
    bulletSpeed: 950,
    spread: 0.07,
    pellets: 1,
    mag: 32,
    reload: 1.3,
    range: 0.8,
    auto: true,
  },
  shotgun: {
    name: "SHOTGUN",
    dmg: 13,
    fireRate: 1.6,
    bulletSpeed: 820,
    spread: 0.32,
    pellets: 8,
    mag: 6,
    reload: 1.6,
    range: 0.55,
    auto: false,
  },
};

export const WEAPON_ORDER = ["pistol", "smg", "shotgun"];
