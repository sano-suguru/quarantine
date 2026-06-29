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
    knockback: 140,
    recoil: 4,
    pierce: 0,
    color: [1.0, 0.85, 0.4],
    moveMul: 1.12, // light sidearm — best kiting speed
    reserveStart: 36,
    reserveMax: 96,
    drawTime: 0.35,
    // compact sidearm: wide receiver → thin blunt barrel + a stubby grip
    viz: [
      { dx: 13, dy: 0, rot: 0, len: 11, wid: 7 },
      { dx: 22, dy: 0, rot: 0, len: 12, wid: 4.5 },
      { dx: 8, dy: 5, rot: 0, len: 6, wid: 5 },
    ],
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
    knockback: 70,
    recoil: 2.4,
    pierce: 0,
    color: [0.55, 0.95, 1.0],
    moveMul: 1.05, // light, still mobile
    reserveStart: 64,
    reserveMax: 160,
    drawTime: 0.4,
    // boxy SMG: chunky receiver → thin barrel + a prominent magazine below
    viz: [
      { dx: 14, dy: 0, rot: 0, len: 14, wid: 8 },
      { dx: 26, dy: 0, rot: 0, len: 13, wid: 5 },
      { dx: 12, dy: 7, rot: 0, len: 10, wid: 5 },
    ],
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
    knockback: 95,
    recoil: 10,
    pierce: 0,
    color: [1.0, 0.7, 0.35],
    moveMul: 0.9, // mid-weight
    reserveStart: 18,
    reserveMax: 42,
    drawTime: 0.5,
    // shotgun: big receiver → twin barrels sitting CLOSE (thin seam, not a wide fork) + stock
    viz: [
      { dx: 14, dy: 0, rot: 0, len: 16, wid: 12 },
      { dx: 26, dy: -3.2, rot: 0, len: 13, wid: 5.5 },
      { dx: 26, dy: 3.2, rot: 0, len: 13, wid: 5.5 },
      { dx: 3, dy: 0, rot: 0, len: 10, wid: 8 },
    ],
  },
  // ---- meta-unlocked arsenal (locked until bought with SALVAGE) ----
  // Assault rifle: accurate full-auto that punches through one zombie.
  rifle: {
    name: "RIFLE",
    dmg: 22,
    fireRate: 9,
    bulletSpeed: 1050,
    spread: 0.04,
    pellets: 1,
    mag: 30,
    reload: 1.4,
    range: 1.0,
    auto: true,
    knockback: 90,
    recoil: 3.2,
    pierce: 1,
    color: [0.7, 1.0, 0.6],
    moveMul: 0.92, // mid-weight
    reserveStart: 90,
    reserveMax: 240,
    drawTime: 0.45,
    // rifle = receiver → long thin blunt barrel + magazine + a top sight
    viz: [
      { dx: 14, dy: 0, rot: 0, len: 12, wid: 7 },
      { dx: 29.5, dy: 0, rot: 0, len: 23, wid: 4.5 },
      { dx: 14, dy: 7, rot: 0, len: 9, wid: 5 },
      { dx: 16, dy: -5, rot: 0, len: 5, wid: 3 },
    ],
  },
  // Light machine gun: suppressing fire, huge mag, heavy kick, long reload.
  lmg: {
    name: "LMG",
    dmg: 17,
    fireRate: 17,
    bulletSpeed: 980,
    spread: 0.1,
    pellets: 1,
    mag: 75,
    reload: 2.6,
    range: 0.95,
    auto: true,
    knockback: 80,
    recoil: 4,
    pierce: 1,
    color: [1.0, 0.85, 0.5],
    moveMul: 0.68, // heavy — stand your ground (slower than a runner)
    reserveStart: 150,
    reserveMax: 450,
    drawTime: 0.7,
    // LMG = biggest rig: receiver → longest blunt barrel + fat drum + stock
    viz: [
      { dx: 14, dy: 0, rot: 0, len: 16, wid: 10 },
      { dx: 34, dy: 0, rot: 0, len: 28, wid: 6 },
      { dx: 13, dy: 9, rot: 0, len: 16, wid: 16, shape: "circle" },
      { dx: 1, dy: 0, rot: 0, len: 11, wid: 9 },
    ],
  },
  // Magnum: a slow, devastating hand-cannon that pierces and throws bodies back.
  magnum: {
    name: "MAGNUM",
    dmg: 95,
    fireRate: 1.7,
    bulletSpeed: 1150,
    spread: 0.012,
    pellets: 1,
    mag: 6,
    reload: 1.5,
    range: 1.1,
    auto: false,
    knockback: 320,
    recoil: 13,
    pierce: 2,
    color: [1.0, 0.55, 0.5],
    moveMul: 0.72, // heavy hand-cannon
    reserveStart: 24,
    reserveMax: 60,
    drawTime: 0.55,
    // magnum = hand-cannon: big hex cylinder + short FAT blunt barrel + grip
    viz: [
      { dx: 24, dy: 0, rot: 0, len: 11, wid: 8 },
      { dx: 10, dy: 0, rot: 0, len: 14, wid: 14, shape: "hex" },
      { dx: 5, dy: 5, rot: 0, len: 6, wid: 5 },
    ],
  },
  // Last-resort melee. Always available, consumes no ammo — but deliberately
  // weak and short-ranged: switching to it should feel like desperation.
  knife: {
    name: "KNIFE",
    dmg: 34,
    fireRate: 2.2,
    bulletSpeed: 0,
    spread: 0,
    pellets: 0,
    mag: 0,
    reload: 0,
    range: 0,
    auto: false,
    knockback: 170,
    recoil: 6,
    pierce: 0,
    color: [0.82, 0.88, 0.95],
    // not the fastest: knife is desperation (no ammo), not a free kiting tool
    moveMul: 1.0,
    reserveStart: 0,
    reserveMax: 0,
    drawTime: 0.3,
    // knife = thin blade tapering to a pointed tip + a small crossguard (smallest rig)
    viz: [
      { dx: 13, dy: 0, rot: 0, len: 13, wid: 3 },
      { dx: 21, dy: 0, rot: 0, len: 7, wid: 3.5, shape: "tri" },
      { dx: 6, dy: 0, rot: 0, len: 3, wid: 7 },
    ],
    melee: true,
    meleeArc: 0.95,
    meleeRange: 30,
  },
};

// Order drives the number hotkeys. Starter guns keep 1-3; meta-unlocked guns
// slot in next; knife is always last. Only OWNED weapons are switchable.
export const WEAPON_ORDER = ["pistol", "smg", "shotgun", "rifle", "lmg", "magnum", "knife"];

// Guns the player always starts a run with (the rest are unlocked via SALVAGE).
export const STARTER_WEAPONS = ["pistol", "smg", "shotgun", "knife"];

// Meta-unlockable weapons and their permanent SALVAGE price.
export const UNLOCKABLE: { id: string; price: number }[] = [
  { id: "rifle", price: 120 },
  { id: "lmg", price: 200 },
  { id: "magnum", price: 280 },
];
