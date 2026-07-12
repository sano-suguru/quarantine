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
    // pistol — angled grip + frame, a bright slide along the top, barrel + front sight
    viz: [
      { dx: 7, dy: 5, rot: 0.18, len: 7, wid: 5, color: [0.6, 0.5, 0.24] }, // grip
      { dx: 13, dy: 0, rot: 0, len: 12, wid: 7, color: [0.6, 0.5, 0.24] }, // frame
      { dx: 15, dy: -1.6, rot: 0, len: 15, wid: 3.2, color: [1.0, 0.95, 0.7], alpha: 0.85 }, // slide
      { dx: 24, dy: 0, rot: 0, len: 9, wid: 4 }, // barrel
      { dx: 27.5, dy: -3.2, rot: 0, len: 2, wid: 2.2, color: [1.0, 0.95, 0.7] }, // front sight
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
    // SMG — stubby brace + boxy receiver, a bright top rail, barrel + muzzle, long angled mag
    viz: [
      { dx: 2, dy: 0, rot: 0, len: 7, wid: 6, color: [0.33, 0.57, 0.6] }, // brace
      { dx: 14, dy: 0, rot: 0, len: 15, wid: 8, color: [0.33, 0.57, 0.6] }, // receiver
      { dx: 15, dy: -3.5, rot: 0, len: 13, wid: 1.6, color: [0.8, 1.0, 1.0], alpha: 0.8 }, // top rail
      { dx: 27, dy: 0, rot: 0, len: 12, wid: 4.5 }, // barrel
      { dx: 33, dy: 0, rot: 0, len: 3, wid: 5, color: [0.33, 0.57, 0.6] }, // muzzle
      { dx: 12, dy: 7, rot: 0.12, len: 12, wid: 5, color: [0.33, 0.57, 0.6] }, // angled magazine
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
    // shotgun: stock + receiver, a bright pump/forend band wrapping the close twin barrels,
    // and a front bead sight
    viz: [
      { dx: 3, dy: 0, rot: 0, len: 10, wid: 7, color: [0.6, 0.42, 0.21] }, // stock
      { dx: 14, dy: 0, rot: 0, len: 16, wid: 10, color: [0.6, 0.42, 0.21] }, // receiver
      { dx: 23, dy: 0, rot: 0, len: 6, wid: 10.5, color: [1.0, 0.86, 0.6], alpha: 0.8 }, // forend band
      { dx: 28, dy: -2.9, rot: 0, len: 12, wid: 4.5 }, // barrel top
      { dx: 28, dy: 2.9, rot: 0, len: 12, wid: 4.5 }, // barrel bottom
      { dx: 34.5, dy: 0, rot: 0, len: 2, wid: 2, color: [1.0, 0.86, 0.6] }, // bead sight
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
    // rifle — DETAIL DEMO: color-broken parts (dark body / mid barrel / bright optic),
    // a ring+dot optic, an angled magazine, and a muzzle device. Shows how far the parts
    // system goes with no engine change. (Same technique can roll out to the other guns.)
    viz: [
      { dx: 2, dy: 0, rot: 0, len: 9, wid: 6, color: [0.45, 0.62, 0.4] }, // stock
      { dx: 13, dy: 0, rot: 0, len: 14, wid: 7, color: [0.45, 0.62, 0.4] }, // receiver
      { dx: 23, dy: 0, rot: 0, len: 8, wid: 5.5 }, // handguard (base color)
      { dx: 32, dy: 0, rot: 0, len: 16, wid: 4 }, // barrel (base color)
      { dx: 40, dy: 0, rot: 0, len: 4, wid: 5, color: [0.45, 0.62, 0.4] }, // muzzle device
      { dx: 14, dy: 7, rot: 0.22, len: 10, wid: 5, color: [0.45, 0.62, 0.4] }, // angled magazine
      { dx: 14, dy: -4.2, rot: 0, len: 6.5, wid: 6.5, shape: "ring", color: [0.88, 1.0, 0.82] }, // optic ring
      { dx: 14, dy: -4.2, rot: 0, len: 2.2, wid: 2.2, shape: "circle", color: [0.88, 1.0, 0.82] }, // optic lens
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
    // LMG = biggest rig: stock + receiver, bright carry handle on top, longest barrel + muzzle,
    // fat drum with a bright hub, and a little front bipod
    viz: [
      { dx: 1, dy: 0, rot: 0, len: 11, wid: 9, color: [0.6, 0.5, 0.3] }, // stock
      { dx: 16, dy: 0, rot: 0, len: 18, wid: 10, color: [0.6, 0.5, 0.3] }, // receiver
      { dx: 16, dy: -5, rot: 0, len: 9, wid: 2.2, color: [1.0, 0.95, 0.75], alpha: 0.85 }, // carry handle
      { dx: 36, dy: 0, rot: 0, len: 26, wid: 6 }, // barrel
      { dx: 49, dy: 0, rot: 0, len: 5, wid: 7, color: [0.6, 0.5, 0.3] }, // muzzle
      { dx: 13, dy: 9, rot: 0, len: 16, wid: 16, shape: "circle", color: [0.6, 0.5, 0.3] }, // drum
      {
        dx: 13,
        dy: 9,
        rot: 0,
        len: 5,
        wid: 5,
        shape: "circle",
        color: [1.0, 0.95, 0.75],
        alpha: 0.9,
      }, // drum hub
      { dx: 42, dy: -4.5, rot: 0.5, len: 7, wid: 2, color: [0.6, 0.5, 0.3] }, // bipod leg
      { dx: 42, dy: 4.5, rot: -0.5, len: 7, wid: 2, color: [0.6, 0.5, 0.3] }, // bipod leg
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
    // magnum = revolver: angled grip + frame, big hex cylinder with a bright hub, short fat
    // barrel with a bright top rib + front sight
    viz: [
      { dx: 5, dy: 5, rot: 0.25, len: 7, wid: 5, color: [0.6, 0.33, 0.3] }, // grip
      { dx: 14, dy: 0, rot: 0, len: 12, wid: 8, color: [0.6, 0.33, 0.3] }, // frame
      { dx: 10, dy: 0, rot: 0, len: 14, wid: 14, shape: "hex", color: [0.6, 0.33, 0.3] }, // cylinder
      {
        dx: 10,
        dy: 0,
        rot: 0,
        len: 4,
        wid: 4,
        shape: "circle",
        color: [1.0, 0.78, 0.72],
        alpha: 0.9,
      }, // cylinder hub
      { dx: 24, dy: 0, rot: 0, len: 12, wid: 8 }, // fat barrel
      { dx: 24, dy: -2.5, rot: 0, len: 12, wid: 1.6, color: [1.0, 0.78, 0.72], alpha: 0.8 }, // top rib
      { dx: 30, dy: -2.8, rot: 0, len: 2, wid: 2, color: [1.0, 0.78, 0.72] }, // front sight
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
    // knife = dark grip (pommel + handle) → bright steel crossguard + blade tapering to a
    // point (tip base matches blade width so it tapers like a blade, not an arrowhead)
    viz: [
      { dx: 3, dy: 0, rot: 0, len: 3, wid: 5, color: [0.5, 0.54, 0.6] }, // pommel
      { dx: 8, dy: 0, rot: 0, len: 8, wid: 4.5, color: [0.5, 0.54, 0.6] }, // handle
      { dx: 13, dy: 0, rot: 0, len: 2, wid: 8, color: [0.95, 0.98, 1.0] }, // crossguard
      { dx: 17, dy: 0, rot: 0, len: 7, wid: 4, color: [0.95, 0.98, 1.0] }, // blade
      { dx: 22, dy: 0, rot: 0, len: 4.5, wid: 4, shape: "tri", color: [0.95, 0.98, 1.0] }, // point
    ],
    melee: true,
    meleeArc: 0.95,
    meleeRange: 30,
  },
};

// Order drives the number hotkeys. Starter guns keep 1-3; meta-unlocked guns
// slot in next; knife is always last. Only OWNED weapons are switchable.
export const WEAPON_ORDER = ["pistol", "smg", "shotgun", "rifle", "lmg", "magnum", "knife"];

/** A weapon id that can receive upgrade (`lvl:`) draft cards: exists in WEAPONS and is not melee.
 *  Shared by CARD_ORDER (the snapshot wire index) and draftPool so the two never diverge on the
 *  membership test — a WEAPON_ORDER id missing from WEAPONS is excluded from both, not silently
 *  injected into CARD_ORDER. */
export const isUpgradeableWeapon = (id: string): boolean => {
  const w = WEAPONS[id];
  return w != null && !w.melee;
};

// Guns the player always starts a run with (the rest are unlocked via SALVAGE).
export const STARTER_WEAPONS = ["pistol", "smg", "shotgun", "knife"];

// Meta-unlockable weapons and their permanent SALVAGE price.
export const UNLOCKABLE: { id: string; price: number }[] = [
  { id: "rifle", price: 120 },
  { id: "lmg", price: 200 },
  { id: "magnum", price: 280 },
];
