import { CONFIG } from "./config";
import { CARD_ORDER } from "./data/arsenal";
import { DEPLOYABLE_TYPES } from "./data/deployables";
import { ENEMY_TYPES } from "./data/enemies";
import { PICKUP_TYPES } from "./data/pickups";
import { WEAPON_ORDER } from "./data/weapons";
import { lerp } from "./engine/math";
import { makePlayer } from "./engine/players";
import type {
  Bullet,
  Deployable,
  FxEvent,
  Pickup,
  SiegePhase,
  Stalker,
  State,
  Zombie,
} from "./types";

/**
 * Host-authoritative world snapshot: the host captures one each network tick and
 * broadcasts it; clients apply it (interpolation is layered on top on the client).
 *
 * Wire format is binary + quantized (NOT JSON) — coords are int16 over the arena,
 * angles a byte, and per-type visuals (color/glow/eye/shape/radius) are reconstructed
 * from the enemy/pickup tables via a type index rather than sent. Players are few so
 * they keep float precision; zombies/bullets/pickups are quantized for bandwidth.
 *
 * Entities are matched across snapshots by stable `id`; walls/barricades/caches are
 * fixed-order so they sync by array index (no id needed).
 */

// stable index lists (identical on host & client since they're the same code)
const ENEMY_ORDER = Object.keys(ENEMY_TYPES);
const PICKUP_ORDER = Object.keys(PICKUP_TYPES);
const DEPLOYABLE_ORDER = Object.keys(DEPLOYABLE_TYPES);

/** Stable ordered cue list for FxEvent audio variant. Append-only — reordering desyncs. */
const AUDIO_CUES: string[] = [
  "dawn",
  "dryFire",
  "heal",
  "pickup",
  "reload",
  "reloadDone",
  "repair",
  "switchWeapon",
  "waveStart",
];

/** Stable ordered label list for FxEvent announce variant. Append-only — reordering desyncs. */
const ANNOUNCE_LABELS: string[] = ["DAY", "NIGHT"];

/** Stalker state string → wire int (0=lull, 1=aggro, 2=stagger, 3=retreat). */
const STALKER_STATES: Stalker["state"][] = ["lull", "aggro", "stagger", "retreat"];
const stalkerStateToInt = (s: Stalker["state"]): number => {
  const i = STALKER_STATES.indexOf(s);
  return i < 0 ? 0 : i;
};
const intToStalkerState = (i: number): Stalker["state"] => STALKER_STATES[i] ?? "lull";

const ARENA = CONFIG.arena;
const SPAWN_MAX = 0.35; // zombie emerge time (see spawnZombie)
const FLASH_MAX = 0.12; // zombie/barricade hit-flash duration
const PICKUP_LIFE = CONFIG.ammo.pickupLife;
const SEARCH_MAX = CONFIG.cache.searchTime * CONFIG.cache.nightSearchMul; // covers the longer night search
const TAU = Math.PI * 2;

/* ----------------------------- logical snapshot ----------------------------- */

interface SnapPlayer {
  id: number;
  x: number;
  y: number;
  aim: number;
  hp: number;
  maxHp: number;
  /** movement speed — synced so client prediction matches after speed perks (Adrenaline) */
  speed: number;
  /** per-player credits (individual wallets) — drives this player's HUD/affordability */
  money: number;
  /** per-player weapon upgrade levels, in WEAPON_ORDER order (changes on purchase) */
  wlevel: number[];
  /** per-player perk multipliers — synced so the local HUD/fire-feel prediction matches */
  dmgMul: number;
  fireRateMul: number;
  reserveMul: number;
  weapon: string;
  ammo: number;
  /** spare ammo per weapon, in WEAPON_ORDER order (for the client HUD reserve count) */
  reserve: number[];
  reloadT: number;
  switchT: number;
  healT: number;
  battery: number;
  muzzle: number;
  recoilX: number;
  recoilY: number;
  hitFlash: number;
  iframe: number;
  dryT: number;
  medkits: number;
  /** bought-but-unplaced deployables, as DEPLOYABLE_ORDER indices in purchase order */
  deployQueue: number[];
  /** co-op revive progress on this (downed) player — drives the revive bar on all clients */
  assistT: number;
  /** disconnected, body held for reconnect (P4) — drawn as a faded ghost on other clients */
  absent: boolean;
  /** between-nights draft offer, as CARD_ORDER indices */
  draftOffer: number[];
  /** free picks spent this night (raw u8; clients read it directly for the remaining-free count).
   *  Carried as its own byte so CONFIG.arsenal.freePicks is freely tunable — no single-bit assumption. */
  draftFreePicksUsed: number;
  draftRerolls: number;
  searching: boolean;
  swingT: number;
  swingKind: "" | "repair" | "mateHeal";
}

interface SnapZombie {
  id: number;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  type: string;
  spawnT: number;
  flash: number;
}

interface SnapBullet {
  id: number;
  x: number;
  y: number;
  px: number;
  py: number;
  color: [number, number, number];
}

interface SnapPickup {
  id: number;
  x: number;
  y: number;
  defId: string;
  life: number;
}

/**
 * Wire representation of the Stalker. `present` is always sent (1 byte); when true,
 * x/y/face/state/vis/contactCd follow as a fixed 8-byte payload. The `state` string maps to a
 * small integer: 0=lull, 1=aggro, 2=stagger, 3=retreat. `vis` is quantized as a u8 (vis*255)
 * so co-op clients see the ward-fade rather than a pop; `contactCd` is quantized over its max
 * so the client grab-scare edge-detector (game.ts) fires for a client victim.
 */
interface SnapStalker {
  present: boolean;
  x: number;
  y: number;
  face: number;
  /** 0=lull 1=aggro 2=stagger 3=retreat */
  state: number;
  /** visibility in [0,1] — synced so clients see the ward-fade (not a pop) */
  vis: number;
  /** grab cooldown timer (s) — synced so the client grab scare edge-detector fires (game.ts) */
  contactCd: number;
}

export interface Snapshot {
  tick: number;
  time: number;
  isFull: boolean;
  paused: boolean;
  /** between-nights shop open (host-authoritative; drives the client's shop overlay) */
  inShop: boolean;
  phase: SiegePhase;
  day: number;
  phaseT: number;
  /** shared run stat (kills drive wave count + SALVAGE); money/wlevel/muls are per-player now */
  kills: number;
  waveN: number;
  players: SnapPlayer[];
  zombies: SnapZombie[];
  bullets: SnapBullet[];
  pickups: SnapPickup[];
  barricades: { hp: number; flash: number }[];
  caches: { looted: boolean; searchT: number }[];
  /** placed fortifications (barrel aim + a status byte: hp fraction + reload flag, so clients
   *  render the tracking barrel, an HP bar, and the reload cue) */
  deployables: {
    id: number;
    defId: string;
    x: number;
    y: number;
    aim: number;
    hpFrac: number;
    reloading: boolean;
    ammoFrac: number;
  }[];
  /**
   * The Stalker block — always present in the wire format (presence byte written even when null).
   * When present=false, x/y/face/state carry no meaning and are not transmitted.
   * Kept separate from `zombies` so the client's kill-rederivation (prev→next zombie id diff)
   * never sees the stalker; the stalker is despawned via a separate withdraw cue.
   */
  stalker: SnapStalker;
  /**
   * Per-tick fx/audio events captured from `state.fxEvents`. Non-idempotent one-shot payloads —
   * clients drain them (play SFX, spawn particles) on arrival. `applySnapshot` leaves them on the
   * snapshot; the caller is responsible for draining. Empty array when no events this tick.
   */
  fxEvents: FxEvent[];
}

/** Read the current world into a logical snapshot. */
export function captureSnapshot(state: State, tick: number, isFull = true): Snapshot {
  return {
    tick,
    time: state.time,
    isFull,
    paused: state.paused,
    inShop: state.inShop,
    phase: state.phase,
    day: state.day,
    phaseT: state.phaseT,
    kills: state.kills,
    waveN: state.wave.n,
    players: state.players.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      aim: p.aim,
      hp: p.hp,
      maxHp: p.maxHp,
      speed: p.speed,
      money: p.money,
      wlevel: WEAPON_ORDER.map((id) => p.wlevel[id] ?? 0),
      dmgMul: p.dmgMul,
      fireRateMul: p.fireRateMul,
      reserveMul: p.reserveMul,
      weapon: p.weapon,
      ammo: p.ammo,
      reserve: WEAPON_ORDER.map((id) => p.reserve[id] ?? 0),
      reloadT: p.reloadT,
      switchT: p.switchT,
      healT: p.healT,
      battery: p.battery,
      muzzle: p.muzzle,
      recoilX: p.recoilX,
      recoilY: p.recoilY,
      hitFlash: p.hitFlash,
      iframe: p.iframe,
      dryT: p.dryT,
      medkits: p.medkits,
      deployQueue: p.deployQueue.map((id) => DEPLOYABLE_ORDER.indexOf(id)).filter((i) => i >= 0),
      assistT: p.assistT,
      absent: p.absent,
      draftOffer: p.draftOffer.map((id) => CARD_ORDER.indexOf(id)).filter((i) => i >= 0),
      draftFreePicksUsed: p.draftFreePicksUsed,
      draftRerolls: p.draftRerolls,
      searching: p.searching,
      swingT: p.swingT,
      swingKind: p.swingKind,
    })),
    zombies: state.zombies.map((z) => ({
      id: z.id,
      x: z.x,
      y: z.y,
      hp: z.hp,
      maxHp: z.maxHp,
      type: z.type,
      spawnT: z.spawnT,
      flash: z.flash,
    })),
    bullets: state.bullets.map((b) => ({
      id: b.id,
      x: b.x,
      y: b.y,
      px: b.px,
      py: b.py,
      color: b.color,
    })),
    pickups: state.pickups.map((pk) => ({
      id: pk.id,
      x: pk.x,
      y: pk.y,
      defId: pk.defId,
      life: pk.life,
    })),
    barricades: state.barricades.map((b) => ({ hp: b.hp, flash: b.flash })),
    caches: state.caches.map((c) => ({ looted: c.looted, searchT: c.searchT })),
    deployables: state.deployables.map((d) => ({
      id: d.id,
      defId: d.defId,
      x: d.x,
      y: d.y,
      aim: d.aim,
      hpFrac: d.hpFrac,
      reloading: d.reloading,
      ammoFrac: d.ammoFrac ?? 1,
    })),
    stalker:
      state.stalker && state.stalker.vis > 0.004
        ? {
            present: true,
            x: state.stalker.x,
            y: state.stalker.y,
            face: state.stalker.face,
            state: stalkerStateToInt(state.stalker.state),
            vis: state.stalker.vis,
            contactCd: state.stalker.contactCd,
          }
        : { present: false, x: 0, y: 0, face: 0, state: 0, vis: 0, contactCd: 0 },
    fxEvents: state.fxEvents.slice(),
  };
}

/* ------------------------------ apply to state ------------------------------ */

/** Build a full (render-capable) Zombie from a snapshot entry + the enemy table. */
function zombieFromSnap(z: SnapZombie): Zombie {
  const t =
    ENEMY_TYPES[z.type] ?? (ENEMY_TYPES[ENEMY_ORDER[0] as string] as (typeof ENEMY_TYPES)[string]);
  return {
    id: z.id,
    x: z.x,
    y: z.y,
    r: t.radius,
    hp: z.hp,
    maxHp: z.maxHp,
    speed: t.speed,
    dmg: t.dmg,
    bounty: t.bounty,
    attackCd: 0,
    attackRate: t.attackRate,
    color: t.color,
    type: z.type,
    shape: t.shape,
    glow: t.glow,
    eye: t.eye,
    vx: 0,
    vy: 0,
    flash: z.flash,
    spawnT: z.spawnT,
    // deterministic per-id wobble phase so clients don't all bob in sync
    wob: (z.id * 1.6180339887) % TAU,
    sense: t.sense,
    wander: t.wander ?? 0,
    lunge: t.lunge ?? 0,
    lungePeriod: t.lungePeriod ?? 0,
    separation: t.separation ?? 1,
    nav: "none",
    chasing: true,
    lungeCd: 0,
    lungeT: 0,
    wanderDir: 0,
    perception: "omniscient",
    percept: "idle",
    lastSeenX: 0,
    lastSeenY: 0,
    searchT: 0,
  };
}

/**
 * Apply a snapshot to a (client) state. Entities are matched by id so unchanged
 * objects keep identity; missing ids are dropped, new ids are created. Players are
 * matched by id too; `skipLocalId` leaves the predicted local player untouched.
 */
export function applySnapshot(
  state: State,
  snap: Snapshot,
  opts: { skipLocalId?: number } = {},
): void {
  state.time = snap.time;
  state.paused = snap.paused;
  state.inShop = snap.inShop;
  state.phase = snap.phase;
  state.day = snap.day;
  state.phaseT = snap.phaseT;
  state.kills = snap.kills;
  state.wave.n = snap.waveN;

  // players: match by id, preserve the predicted local player if requested
  const byId = new Map(state.players.map((p) => [p.id, p]));
  const next = [];
  for (const sp of snap.players) {
    if (sp.id === opts.skipLocalId) {
      const keep = byId.get(sp.id);
      if (keep) {
        next.push(keep);
        continue;
      }
    }
    const p = byId.get(sp.id) ?? makePlayer(sp.id, sp.x, sp.y);
    p.x = sp.x;
    p.y = sp.y;
    p.aim = sp.aim;
    p.hp = sp.hp;
    p.maxHp = sp.maxHp;
    p.speed = sp.speed;
    p.money = sp.money;
    p.dmgMul = sp.dmgMul;
    p.fireRateMul = sp.fireRateMul;
    p.reserveMul = sp.reserveMul;
    p.weapon = sp.weapon;
    p.ammo = sp.ammo;
    WEAPON_ORDER.forEach((id, i) => {
      p.reserve[id] = sp.reserve[i] ?? 0;
      p.wlevel[id] = sp.wlevel[i] ?? 0;
    });
    p.reloadT = sp.reloadT;
    p.switchT = sp.switchT;
    p.healT = sp.healT;
    p.battery = sp.battery;
    p.muzzle = sp.muzzle;
    p.recoilX = sp.recoilX;
    p.recoilY = sp.recoilY;
    p.hitFlash = sp.hitFlash;
    p.iframe = sp.iframe;
    p.dryT = sp.dryT;
    p.medkits = sp.medkits;
    p.deployQueue = sp.deployQueue
      .map((i) => DEPLOYABLE_ORDER[i])
      .filter((id): id is string => id !== undefined);
    p.assistT = sp.assistT;
    p.absent = sp.absent;
    p.searching = sp.searching;
    p.swingT = sp.swingT;
    p.swingKind = sp.swingKind;
    p.draftOffer = sp.draftOffer
      .map((i) => CARD_ORDER[i])
      .filter((id): id is string => id !== undefined);
    p.draftFreePicksUsed = sp.draftFreePicksUsed;
    p.draftRerolls = sp.draftRerolls;
    next.push(p);
  }
  state.players = next;

  // zombies: match by id, reconstruct visuals from the enemy table for new ones
  const zById = new Map(state.zombies.map((z) => [z.id, z]));
  state.zombies = snap.zombies.map((sz) => {
    const z = zById.get(sz.id);
    if (z) {
      z.x = sz.x;
      z.y = sz.y;
      z.hp = sz.hp;
      z.maxHp = sz.maxHp;
      z.spawnT = sz.spawnT;
      z.flash = sz.flash;
      return z;
    }
    return zombieFromSnap(sz);
  });

  // bullets: rebuild (short-lived; r is constant)
  state.bullets = snap.bullets.map(
    (sb): Bullet => ({
      id: sb.id,
      x: sb.x,
      y: sb.y,
      px: sb.px,
      py: sb.py,
      vx: 0,
      vy: 0,
      r: 4,
      dmg: 0,
      life: 1,
      pierce: 0,
      knockback: 0,
      color: sb.color,
    }),
  );

  // pickups: match by id to keep the bob phase stable
  const pkById = new Map(state.pickups.map((pk) => [pk.id, pk]));
  state.pickups = snap.pickups.map((sp): Pickup => {
    const ex = pkById.get(sp.id);
    return {
      id: sp.id,
      x: sp.x,
      y: sp.y,
      defId: sp.defId,
      life: sp.life,
      maxLife: PICKUP_LIFE,
      bob: ex?.bob ?? (sp.id * 2.399963) % TAU,
    };
  });

  // barricades / caches: fixed order → sync by index
  for (let i = 0; i < state.barricades.length && i < snap.barricades.length; i++) {
    const b = state.barricades[i] as (typeof state.barricades)[number];
    const s = snap.barricades[i] as (typeof snap.barricades)[number];
    b.hp = s.hp;
    b.flash = s.flash;
  }
  for (let i = 0; i < state.caches.length && i < snap.caches.length; i++) {
    const c = state.caches[i] as (typeof state.caches)[number];
    const s = snap.caches[i] as (typeof snap.caches)[number];
    c.looted = s.looted;
    c.searchT = s.searchT;
  }

  // deployables: match by id to keep object identity (sim fields are host-only; clients only
  // render position/aim + the synced hpFrac/reloading display state)
  const dById = new Map(state.deployables.map((d) => [d.id, d]));
  state.deployables = snap.deployables.map((sd): Deployable => {
    const ex = dById.get(sd.id);
    if (ex) {
      ex.x = sd.x;
      ex.y = sd.y;
      ex.aim = sd.aim;
      ex.hpFrac = sd.hpFrac;
      ex.reloading = sd.reloading;
      ex.ammoFrac = sd.ammoFrac;
      return ex;
    }
    return {
      id: sd.id,
      defId: sd.defId,
      x: sd.x,
      y: sd.y,
      aim: sd.aim,
      hpFrac: sd.hpFrac,
      reloading: sd.reloading,
      ammoFrac: sd.ammoFrac,
    };
  });

  // stalker: set/clear from the dedicated block (separate from zombies so kill-rederive is unaffected)
  if (snap.stalker.present) {
    // Reuse existing object to keep identity stable (avoids churn when only position updates)
    const sk = state.stalker;
    if (sk) {
      sk.x = snap.stalker.x;
      sk.y = snap.stalker.y;
      sk.face = snap.stalker.face;
      sk.state = intToStalkerState(snap.stalker.state);
      sk.vis = snap.stalker.vis;
      sk.contactCd = snap.stalker.contactCd;
    } else {
      state.stalker = {
        x: snap.stalker.x,
        y: snap.stalker.y,
        face: snap.stalker.face,
        state: intToStalkerState(snap.stalker.state),
        staggerT: 0,
        contactCd: snap.stalker.contactCd,
        vis: snap.stalker.vis,
      };
    }
  } else {
    state.stalker = null;
  }
}

/* -------------------------------- binary codec ------------------------------ */

const qpos = (v: number): number =>
  Math.max(-32768, Math.min(32767, Math.round((v / ARENA) * 32767)));
const dqpos = (q: number): number => (q / 32767) * ARENA;
const q01 = (v: number, max: number): number =>
  Math.max(0, Math.min(255, Math.round((v / max) * 255)));
const dq01 = (b: number, max: number): number => (b / 255) * max;
/** quantization ceiling for Player.switchT (≥ the largest WeaponDef.drawTime, with headroom) */
const MAX_DRAWTIME = 0.8;
const MAX_SWING = CONFIG.actionFeel.swingDecay;

class Writer {
  private buf: ArrayBuffer;
  private view: DataView;
  off = 0;
  constructor(bytes = 1 << 16) {
    this.buf = new ArrayBuffer(bytes);
    this.view = new DataView(this.buf);
  }
  u8(v: number): void {
    this.view.setUint8(this.off, v & 255);
    this.off += 1;
  }
  i16(v: number): void {
    this.view.setInt16(this.off, v, true);
    this.off += 2;
  }
  u16(v: number): void {
    this.view.setUint16(this.off, v, true);
    this.off += 2;
  }
  u32(v: number): void {
    this.view.setUint32(this.off, v >>> 0, true);
    this.off += 4;
  }
  f32(v: number): void {
    this.view.setFloat32(this.off, v, true);
    this.off += 4;
  }
  done(): ArrayBuffer {
    return this.buf.slice(0, this.off);
  }
}

class Reader {
  private view: DataView;
  off = 0;
  constructor(buf: ArrayBuffer) {
    this.view = new DataView(buf);
  }
  u8(): number {
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.off, true);
    this.off += 2;
    return v;
  }
  u16(): number {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  f32(): number {
    const v = this.view.getFloat32(this.off, true);
    this.off += 4;
    return v;
  }
}

/** Serialize a logical snapshot to a compact binary buffer. */
export function encode(snap: Snapshot): ArrayBuffer {
  const w = new Writer();
  w.u32(snap.tick);
  w.f32(snap.time);
  // flags: bit0 isFull, bit1 paused, bit2 phase(night), bit3 inShop
  w.u8(
    (snap.isFull ? 1 : 0) |
      (snap.paused ? 2 : 0) |
      (snap.phase === "night" ? 4 : 0) |
      (snap.inShop ? 8 : 0),
  );
  w.u16(snap.day);
  w.f32(snap.phaseT);
  w.u32(snap.kills);
  w.u16(snap.waveN);

  // players (few → keep float precision; pack per-player flags into a flag byte). Per-player
  // economy (money/wlevel/muls) rides here too — individual wallets.
  w.u8(snap.players.length);
  for (const p of snap.players) {
    w.u8(p.id);
    w.f32(p.x);
    w.f32(p.y);
    w.f32(p.aim);
    w.f32(p.hp);
    w.f32(p.maxHp);
    w.f32(p.speed);
    w.u32(p.money);
    w.f32(p.dmgMul);
    w.f32(p.fireRateMul);
    w.f32(p.reserveMul);
    w.u8(p.wlevel.length);
    for (const lvl of p.wlevel) w.u8(lvl);
    const wi = WEAPON_ORDER.indexOf(p.weapon);
    w.u8(wi < 0 ? 255 : wi);
    w.i16(p.ammo);
    w.u8(p.reserve.length);
    for (const r of p.reserve) w.u16(Math.max(0, Math.min(65535, Math.round(r))));
    w.f32(p.reloadT);
    w.u8(q01(p.switchT, MAX_DRAWTIME));
    w.f32(p.healT);
    w.f32(p.battery);
    w.f32(p.muzzle);
    w.f32(p.recoilX);
    w.f32(p.recoilY);
    w.f32(p.hitFlash);
    w.f32(p.iframe);
    w.f32(p.dryT);
    w.f32(p.assistT);
    w.u8(p.medkits);
    w.u8(p.deployQueue.length);
    for (const di of p.deployQueue) w.u8(di);
    w.u8(p.draftOffer.length);
    for (const ci of p.draftOffer) w.u8(ci);
    w.u8(Math.min(255, p.draftRerolls));
    w.u8(Math.min(255, p.draftFreePicksUsed));
    const swingKindBits = p.swingKind === "repair" ? 4 : p.swingKind === "mateHeal" ? 8 : 0;
    // bit 0 is unused (was lightOn, retired when the flashlight became always-on).
    w.u8((p.absent ? 2 : 0) | (p.searching ? 16 : 0) | swingKindBits);
    w.u8(q01(p.swingT, MAX_SWING));
  }

  // zombies (quantized)
  w.u16(snap.zombies.length);
  for (const z of snap.zombies) {
    w.u32(z.id);
    w.i16(qpos(z.x));
    w.i16(qpos(z.y));
    w.u16(Math.max(0, Math.min(65535, Math.round(z.hp))));
    w.u16(Math.max(0, Math.min(65535, Math.round(z.maxHp))));
    const ti = ENEMY_ORDER.indexOf(z.type);
    w.u8(ti < 0 ? 0 : ti);
    w.u8(q01(z.spawnT, SPAWN_MAX));
    w.u8(q01(z.flash, FLASH_MAX));
  }

  // bullets (quantized pos + endpoints + rgb byte color)
  w.u16(snap.bullets.length);
  for (const b of snap.bullets) {
    w.u32(b.id);
    w.i16(qpos(b.x));
    w.i16(qpos(b.y));
    w.i16(qpos(b.px));
    w.i16(qpos(b.py));
    w.u8(Math.round(b.color[0] * 255));
    w.u8(Math.round(b.color[1] * 255));
    w.u8(Math.round(b.color[2] * 255));
  }

  // pickups
  w.u16(snap.pickups.length);
  for (const pk of snap.pickups) {
    w.u32(pk.id);
    w.i16(qpos(pk.x));
    w.i16(qpos(pk.y));
    const di = PICKUP_ORDER.indexOf(pk.defId);
    w.u8(di < 0 ? 0 : di);
    w.u8(q01(pk.life, PICKUP_LIFE));
  }

  // barricades / caches (index-synced)
  w.u8(snap.barricades.length);
  for (const b of snap.barricades) {
    w.f32(b.hp);
    w.u8(q01(b.flash, FLASH_MAX));
  }
  w.u8(snap.caches.length);
  for (const c of snap.caches) {
    w.u8(c.looted ? 1 : 0);
    w.u8(q01(c.searchT, SEARCH_MAX));
  }

  // deployables (few; id-matched). aim quantized to a byte over TAU for the barrel; a status
  // byte packs the reload flag (bit0) + hp fraction (bits 1-7) for the client HP bar / cue.
  w.u8(snap.deployables.length);
  for (const d of snap.deployables) {
    w.u32(d.id);
    const di = DEPLOYABLE_ORDER.indexOf(d.defId);
    w.u8(di < 0 ? 0 : di);
    w.i16(qpos(d.x));
    w.i16(qpos(d.y));
    w.u8(q01(((d.aim % TAU) + TAU) % TAU, TAU));
    const hp7 = Math.round(Math.max(0, Math.min(1, d.hpFrac)) * 127);
    w.u8((d.reloading ? 1 : 0) | (hp7 << 1));
    w.u8(Math.round(Math.max(0, Math.min(1, d.ammoFrac)) * 255));
  }

  // stalker block — fixed-size, always written (single-player: presence=0, no payload).
  // Layout: [u8 present] [i16 x] [i16 y] [u8 face-quant-TAU] [u8 state-int] [u8 vis*255] [u8 contactCd-quant]
  // Total: 1 byte when absent; 9 bytes when present. Always writes ≥1 byte.
  w.u8(snap.stalker.present ? 1 : 0);
  if (snap.stalker.present) {
    w.i16(qpos(snap.stalker.x));
    w.i16(qpos(snap.stalker.y));
    w.u8(q01(((snap.stalker.face % TAU) + TAU) % TAU, TAU));
    w.u8(snap.stalker.state & 3); // only 4 states, 2 bits; mask for safety
    w.u8(Math.max(0, Math.min(255, Math.round(snap.stalker.vis * 255)))); // vis as u8
    w.u8(q01(snap.stalker.contactCd, CONFIG.stalker.contactCd)); // grab timer, quantized over its max
  }

  // fxEvents section — non-idempotent one-shot cues; clients drain on arrival.
  // Layout: [u16 count] then per event: [u8 tag] [fields...]
  // Tags: 0=kill 1=impact 2=hit 3=hurt 4=muzzle 5=audio 6=announce 7=dust 8=mote 9=burst 10=pickup 11=deployDestroy
  w.u16(snap.fxEvents.length);
  for (const ev of snap.fxEvents) {
    switch (ev.t) {
      case "kill": {
        // [u8 0] [i16 x] [i16 y] [u8 typeIdx] [u8 flags: bit0=big] [u8 dir/TAU] [u8 radius/255] [u8 hitDir/TAU]
        w.u8(0);
        w.i16(qpos(ev.x));
        w.i16(qpos(ev.y));
        const ki = ENEMY_ORDER.indexOf(ev.type);
        w.u8(ki < 0 ? 0 : ki);
        w.u8(ev.big ? 1 : 0);
        w.u8(q01(((ev.dir % TAU) + TAU) % TAU, TAU));
        w.u8(Math.max(0, Math.min(255, Math.round(ev.radius))));
        w.u8(q01(((ev.hitDir % TAU) + TAU) % TAU, TAU));
        break;
      }
      case "impact": {
        // [u8 1] [i16 x] [i16 y] [u8 ang/TAU] [u8 r] [u8 g] [u8 b] [u8 intensity*255]
        w.u8(1);
        w.i16(qpos(ev.x));
        w.i16(qpos(ev.y));
        w.u8(q01(((ev.ang % TAU) + TAU) % TAU, TAU));
        w.u8(Math.round(ev.color[0] * 255));
        w.u8(Math.round(ev.color[1] * 255));
        w.u8(Math.round(ev.color[2] * 255));
        w.u8(Math.max(0, Math.min(255, Math.round(ev.intensity * 255))));
        break;
      }
      case "hit": {
        // [u8 2] [i16 x] [i16 y]
        w.u8(2);
        w.i16(qpos(ev.x));
        w.i16(qpos(ev.y));
        break;
      }
      case "hurt": {
        // [u8 3] [i16 x] [i16 y] [u8 flags: bit0=local]
        w.u8(3);
        w.i16(qpos(ev.x));
        w.i16(qpos(ev.y));
        w.u8(ev.local ? 1 : 0);
        break;
      }
      case "muzzle": {
        // [u8 4] [i16 x] [i16 y] [u8 ang/TAU] [u8 r] [u8 g] [u8 b] [u8 weaponIdx] [u8 flags: bit0=melee]
        w.u8(4);
        w.i16(qpos(ev.x));
        w.i16(qpos(ev.y));
        w.u8(q01(((ev.ang % TAU) + TAU) % TAU, TAU));
        w.u8(Math.round(ev.color[0] * 255));
        w.u8(Math.round(ev.color[1] * 255));
        w.u8(Math.round(ev.color[2] * 255));
        const wxi = WEAPON_ORDER.indexOf(ev.weapon);
        w.u8(wxi < 0 ? 0 : wxi);
        w.u8(ev.melee ? 1 : 0);
        break;
      }
      case "audio": {
        // [u8 5] [u8 cueIdx] [u8 argKind: 0=none 1=number 2=string] ([f32] | [u8 len][utf8 bytes])
        w.u8(5);
        const ci = AUDIO_CUES.indexOf(ev.cue);
        w.u8(ci < 0 ? 0 : ci);
        if (ev.arg === undefined || ev.arg === null) {
          w.u8(0);
        } else if (typeof ev.arg === "number") {
          w.u8(1);
          w.f32(ev.arg);
        } else {
          // string arg: length-prefixed utf8 (capped at 255 bytes)
          const encoded = new TextEncoder().encode(ev.arg);
          const len = Math.min(255, encoded.length);
          w.u8(2);
          w.u8(len);
          for (let i = 0; i < len; i++) w.u8(encoded[i] ?? 0);
        }
        break;
      }
      case "announce": {
        // [u8 6] [u8 labelIdx] [u16 day]
        w.u8(6);
        const li = ANNOUNCE_LABELS.indexOf(ev.label);
        w.u8(li < 0 ? 0 : li);
        w.u16(Math.max(0, Math.min(65535, ev.day)));
        break;
      }
      case "dust": {
        // [u8 7] [i16 x] [i16 y] [u8 n]
        w.u8(7);
        w.i16(qpos(ev.x));
        w.i16(qpos(ev.y));
        w.u8(Math.max(0, Math.min(255, ev.n)));
        break;
      }
      case "mote": {
        // [u8 8] [i16 x] [i16 y] [u8 r] [u8 g] [u8 b]
        w.u8(8);
        w.i16(qpos(ev.x));
        w.i16(qpos(ev.y));
        w.u8(Math.round(ev.color[0] * 255));
        w.u8(Math.round(ev.color[1] * 255));
        w.u8(Math.round(ev.color[2] * 255));
        break;
      }
      case "burst": {
        // [u8 9] [i16 x] [i16 y] [u8 r] [u8 g] [u8 b] [u8 flags: bit0=ring]
        w.u8(9);
        w.i16(qpos(ev.x));
        w.i16(qpos(ev.y));
        w.u8(Math.round(ev.color[0] * 255));
        w.u8(Math.round(ev.color[1] * 255));
        w.u8(Math.round(ev.color[2] * 255));
        w.u8(ev.ring ? 1 : 0);
        break;
      }
      case "pickup": {
        // [u8 10] [i16 x] [i16 y] [u8 r] [u8 g] [u8 b]
        w.u8(10);
        w.i16(qpos(ev.x));
        w.i16(qpos(ev.y));
        w.u8(Math.round(ev.glow[0] * 255));
        w.u8(Math.round(ev.glow[1] * 255));
        w.u8(Math.round(ev.glow[2] * 255));
        break;
      }
      case "deployDestroy": {
        // [u8 11] [i16 x] [i16 y] [u8 r] [u8 g] [u8 b] [u8 flags: bit0=rtb]
        w.u8(11);
        w.i16(qpos(ev.x));
        w.i16(qpos(ev.y));
        w.u8(Math.round(ev.color[0] * 255));
        w.u8(Math.round(ev.color[1] * 255));
        w.u8(Math.round(ev.color[2] * 255));
        w.u8(ev.rtb ? 1 : 0);
        break;
      }
    }
  }

  return w.done();
}

/** Deserialize a binary buffer back into a logical snapshot. */
export function decode(buf: ArrayBuffer): Snapshot {
  const r = new Reader(buf);
  const tick = r.u32();
  const time = r.f32();
  const flags = r.u8();
  const day = r.u16();
  const phaseT = r.f32();
  const kills = r.u32();
  const waveN = r.u16();

  const players: SnapPlayer[] = [];
  const pc = r.u8();
  for (let i = 0; i < pc; i++) {
    const id = r.u8();
    const x = r.f32();
    const y = r.f32();
    const aim = r.f32();
    const hp = r.f32();
    const maxHp = r.f32();
    const speed = r.f32();
    const money = r.u32();
    const dmgMul = r.f32();
    const fireRateMul = r.f32();
    const reserveMul = r.f32();
    const wlevel: number[] = [];
    const wlc = r.u8();
    for (let j = 0; j < wlc; j++) wlevel.push(r.u8());
    const wi = r.u8();
    const ammo = r.i16();
    const reserve: number[] = [];
    const rc = r.u8();
    for (let j = 0; j < rc; j++) reserve.push(r.u16());
    const reloadT = r.f32();
    const switchT = dq01(r.u8(), MAX_DRAWTIME);
    const healT = r.f32();
    const battery = r.f32();
    const muzzle = r.f32();
    const recoilX = r.f32();
    const recoilY = r.f32();
    const hitFlash = r.f32();
    const iframe = r.f32();
    const dryT = r.f32();
    const assistT = r.f32();
    const medkits = r.u8();
    const deployQueue: number[] = [];
    const dqc = r.u8();
    for (let j = 0; j < dqc; j++) deployQueue.push(r.u8());
    const draftOffer: number[] = [];
    const doc = r.u8();
    for (let j = 0; j < doc; j++) draftOffer.push(r.u8());
    const draftRerolls = r.u8();
    const draftFreePicksUsed = r.u8();
    const pflags = r.u8();
    const swingT = dq01(r.u8(), MAX_SWING);
    // bit 0 (pflags & 1) is unused — was lightOn, retired when the flashlight became always-on.
    const absent = (pflags & 2) !== 0;
    const searching = (pflags & 16) !== 0;
    const swingKind: "" | "repair" | "mateHeal" =
      (pflags & 4) !== 0 ? "repair" : (pflags & 8) !== 0 ? "mateHeal" : "";
    players.push({
      id,
      x,
      y,
      aim,
      hp,
      maxHp,
      speed,
      money,
      wlevel,
      dmgMul,
      fireRateMul,
      reserveMul,
      weapon: WEAPON_ORDER[wi] ?? "pistol",
      ammo,
      reserve,
      reloadT,
      switchT,
      healT,
      battery,
      muzzle,
      recoilX,
      recoilY,
      hitFlash,
      iframe,
      dryT,
      assistT,
      medkits,
      deployQueue,
      absent,
      draftOffer,
      draftFreePicksUsed,
      draftRerolls,
      searching,
      swingT,
      swingKind,
    });
  }

  const zombies: SnapZombie[] = [];
  const zc = r.u16();
  for (let i = 0; i < zc; i++) {
    const id = r.u32();
    const x = dqpos(r.i16());
    const y = dqpos(r.i16());
    const hp = r.u16();
    const maxHp = r.u16();
    const type = ENEMY_ORDER[r.u8()] ?? (ENEMY_ORDER[0] as string);
    const spawnT = dq01(r.u8(), SPAWN_MAX);
    const flash = dq01(r.u8(), FLASH_MAX);
    zombies.push({ id, x, y, hp, maxHp, type, spawnT, flash });
  }

  const bullets: SnapBullet[] = [];
  const bc = r.u16();
  for (let i = 0; i < bc; i++) {
    const id = r.u32();
    const x = dqpos(r.i16());
    const y = dqpos(r.i16());
    const px = dqpos(r.i16());
    const py = dqpos(r.i16());
    const color: [number, number, number] = [r.u8() / 255, r.u8() / 255, r.u8() / 255];
    bullets.push({ id, x, y, px, py, color });
  }

  const pickups: SnapPickup[] = [];
  const kc = r.u16();
  for (let i = 0; i < kc; i++) {
    const id = r.u32();
    const x = dqpos(r.i16());
    const y = dqpos(r.i16());
    const defId = PICKUP_ORDER[r.u8()] ?? (PICKUP_ORDER[0] as string);
    const life = dq01(r.u8(), PICKUP_LIFE);
    pickups.push({ id, x, y, defId, life });
  }

  const barricades: { hp: number; flash: number }[] = [];
  const barc = r.u8();
  for (let i = 0; i < barc; i++) {
    barricades.push({ hp: r.f32(), flash: dq01(r.u8(), FLASH_MAX) });
  }

  const caches: { looted: boolean; searchT: number }[] = [];
  const cc = r.u8();
  for (let i = 0; i < cc; i++) {
    const looted = (r.u8() & 1) === 1;
    const searchT = dq01(r.u8(), SEARCH_MAX);
    caches.push({ looted, searchT });
  }

  const deployables: Snapshot["deployables"] = [];
  const dc = r.u8();
  for (let i = 0; i < dc; i++) {
    const id = r.u32();
    const defId = DEPLOYABLE_ORDER[r.u8()] ?? (DEPLOYABLE_ORDER[0] as string);
    const x = dqpos(r.i16());
    const y = dqpos(r.i16());
    const aim = dq01(r.u8(), TAU);
    const status = r.u8();
    const ammoFrac = r.u8() / 255;
    deployables.push({
      id,
      defId,
      x,
      y,
      aim,
      reloading: (status & 1) === 1,
      hpFrac: (status >> 1) / 127,
      ammoFrac,
    });
  }

  // stalker block — mirror of encode: [u8 present] (+ [i16 x][i16 y][u8 face][u8 state][u8 vis][u8 contactCd] when present)
  const stalkerPresent = r.u8() !== 0;
  let stalker: SnapStalker;
  if (stalkerPresent) {
    const sx = dqpos(r.i16());
    const sy = dqpos(r.i16());
    const sface = dq01(r.u8(), TAU);
    const sstate = r.u8() & 3;
    const svis = r.u8() / 255;
    const scontactCd = dq01(r.u8(), CONFIG.stalker.contactCd);
    stalker = {
      present: true,
      x: sx,
      y: sy,
      face: sface,
      state: sstate,
      vis: svis,
      contactCd: scontactCd,
    };
  } else {
    stalker = { present: false, x: 0, y: 0, face: 0, state: 0, vis: 0, contactCd: 0 };
  }

  // fxEvents — decode parallel to encode (same tag/field layout)
  const fxEvents: FxEvent[] = [];
  const evCount = r.u16();
  for (let i = 0; i < evCount; i++) {
    const tag = r.u8();
    switch (tag) {
      case 0: {
        // kill: [i16 x] [i16 y] [u8 typeIdx] [u8 flags] [u8 dir] [u8 radius] [u8 hitDir]
        const x = dqpos(r.i16());
        const y = dqpos(r.i16());
        const type = ENEMY_ORDER[r.u8()] ?? (ENEMY_ORDER[0] as string);
        const kflags = r.u8();
        const dir = dq01(r.u8(), TAU);
        const radius = r.u8();
        const hitDir = dq01(r.u8(), TAU);
        fxEvents.push({ t: "kill", x, y, type, big: (kflags & 1) !== 0, dir, radius, hitDir });
        break;
      }
      case 1: {
        // impact: [i16 x] [i16 y] [u8 ang] [u8 r] [u8 g] [u8 b] [u8 intensity]
        const x = dqpos(r.i16());
        const y = dqpos(r.i16());
        const ang = dq01(r.u8(), TAU);
        const color: [number, number, number] = [r.u8() / 255, r.u8() / 255, r.u8() / 255];
        const intensity = r.u8() / 255;
        fxEvents.push({ t: "impact", x, y, ang, color, intensity });
        break;
      }
      case 2: {
        // hit: [i16 x] [i16 y]
        const x = dqpos(r.i16());
        const y = dqpos(r.i16());
        fxEvents.push({ t: "hit", x, y });
        break;
      }
      case 3: {
        // hurt: [i16 x] [i16 y] [u8 flags]
        const x = dqpos(r.i16());
        const y = dqpos(r.i16());
        const hflags = r.u8();
        fxEvents.push({ t: "hurt", x, y, local: (hflags & 1) !== 0 });
        break;
      }
      case 4: {
        // muzzle: [i16 x] [i16 y] [u8 ang] [u8 r] [u8 g] [u8 b] [u8 weaponIdx] [u8 flags]
        const x = dqpos(r.i16());
        const y = dqpos(r.i16());
        const ang = dq01(r.u8(), TAU);
        const color: [number, number, number] = [r.u8() / 255, r.u8() / 255, r.u8() / 255];
        const weapon = WEAPON_ORDER[r.u8()] ?? (WEAPON_ORDER[0] as string);
        const mflags = r.u8();
        fxEvents.push({ t: "muzzle", x, y, ang, color, weapon, melee: (mflags & 1) !== 0 });
        break;
      }
      case 5: {
        // audio: [u8 cueIdx] [u8 argKind] ([f32] | [u8 len][bytes])
        const cue = AUDIO_CUES[r.u8()] ?? (AUDIO_CUES[0] as string);
        const argKind = r.u8();
        let arg: number | string | undefined;
        if (argKind === 1) {
          arg = r.f32();
        } else if (argKind === 2) {
          const len = r.u8();
          const bytes = new Uint8Array(len);
          for (let j = 0; j < len; j++) bytes[j] = r.u8();
          arg = new TextDecoder().decode(bytes);
        }
        // argKind === 0: no arg (leave undefined)
        fxEvents.push(arg !== undefined ? { t: "audio", cue, arg } : { t: "audio", cue });
        break;
      }
      case 6: {
        // announce: [u8 labelIdx] [u16 day]
        const label = ANNOUNCE_LABELS[r.u8()] ?? (ANNOUNCE_LABELS[0] as string);
        const day = r.u16();
        fxEvents.push({ t: "announce", label, day });
        break;
      }
      case 7: {
        // dust: [i16 x] [i16 y] [u8 n]
        const x = dqpos(r.i16());
        const y = dqpos(r.i16());
        const n = r.u8();
        fxEvents.push({ t: "dust", x, y, n });
        break;
      }
      case 8: {
        // mote: [i16 x] [i16 y] [u8 r] [u8 g] [u8 b]
        const x = dqpos(r.i16());
        const y = dqpos(r.i16());
        const color: [number, number, number] = [r.u8() / 255, r.u8() / 255, r.u8() / 255];
        fxEvents.push({ t: "mote", x, y, color });
        break;
      }
      case 9: {
        // burst: [i16 x] [i16 y] [u8 r] [u8 g] [u8 b] [u8 flags]
        const x = dqpos(r.i16());
        const y = dqpos(r.i16());
        const color: [number, number, number] = [r.u8() / 255, r.u8() / 255, r.u8() / 255];
        const bflags = r.u8();
        fxEvents.push({ t: "burst", x, y, color, ring: (bflags & 1) !== 0 });
        break;
      }
      case 10: {
        // pickup: [i16 x] [i16 y] [u8 r] [u8 g] [u8 b]
        const x = dqpos(r.i16());
        const y = dqpos(r.i16());
        const glow: [number, number, number] = [r.u8() / 255, r.u8() / 255, r.u8() / 255];
        fxEvents.push({ t: "pickup", x, y, glow });
        break;
      }
      case 11: {
        // deployDestroy: [i16 x] [i16 y] [u8 r] [u8 g] [u8 b] [u8 flags]
        const x = dqpos(r.i16());
        const y = dqpos(r.i16());
        const color: [number, number, number] = [r.u8() / 255, r.u8() / 255, r.u8() / 255];
        const dflags = r.u8();
        fxEvents.push({ t: "deployDestroy", x, y, color, rtb: (dflags & 1) !== 0 });
        break;
      }
      default:
        // Unknown tag — format version skew. Cannot skip safely without knowing field sizes.
        // Log a warning and stop decoding further events (remaining events are lost, not corrupt).
        console.warn(
          `[snapshot] unknown fxEvent tag ${tag} at offset ${r.off - 1}; truncating event list`,
        );
        i = evCount; // exit loop
        break;
    }
  }

  return {
    tick,
    time,
    isFull: (flags & 1) !== 0,
    paused: (flags & 2) !== 0,
    phase: (flags & 4) !== 0 ? "night" : "day",
    inShop: (flags & 8) !== 0,
    day,
    phaseT,
    kills,
    waveN,
    players,
    zombies,
    bullets,
    pickups,
    barricades,
    caches,
    deployables,
    stalker,
    fxEvents,
  };
}

/** Capture + encode in one call (host send path). */
export function encodeSnapshot(state: State, tick: number, isFull = true): ArrayBuffer {
  return encode(captureSnapshot(state, tick, isFull));
}

/* ------------------------------ interpolation ------------------------------- */

function lerpAngle(a: number, b: number, t: number): number {
  let d = ((b - a + Math.PI) % TAU) - Math.PI;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
}

/**
 * Interpolate between two snapshots (a = older, b = newer) at fraction t∈[0,1].
 * Scalars come from `b` (latest authoritative); entity positions are lerped by id.
 * Entities only in `b` snap to their `b` value; entities only in `a` are dropped
 * (their disappearance is what drives client-side kill fx in 5c). Used by the client
 * render loop to show remote entities ~interpDelay in the past, smoothly.
 */
export function lerpSnapshots(a: Snapshot, b: Snapshot, t: number): Snapshot {
  const ap = new Map(a.players.map((p) => [p.id, p]));
  const players = b.players.map((pb) => {
    const pa = ap.get(pb.id);
    if (!pa) return pb;
    return {
      ...pb,
      x: lerp(pa.x, pb.x, t),
      y: lerp(pa.y, pb.y, t),
      aim: lerpAngle(pa.aim, pb.aim, t),
      recoilX: lerp(pa.recoilX, pb.recoilX, t),
      recoilY: lerp(pa.recoilY, pb.recoilY, t),
    };
  });
  const az = new Map(a.zombies.map((z) => [z.id, z]));
  const zombies = b.zombies.map((zb) => {
    const za = az.get(zb.id);
    return za ? { ...zb, x: lerp(za.x, zb.x, t), y: lerp(za.y, zb.y, t) } : zb;
  });
  const ab = new Map(a.bullets.map((x) => [x.id, x]));
  const bullets = b.bullets.map((bb) => {
    const ba = ab.get(bb.id);
    return ba
      ? {
          ...bb,
          x: lerp(ba.x, bb.x, t),
          y: lerp(ba.y, bb.y, t),
          px: lerp(ba.px, bb.px, t),
          py: lerp(ba.py, bb.py, t),
        }
      : bb;
  });
  const apk = new Map(a.pickups.map((x) => [x.id, x]));
  const pickups = b.pickups.map((pp) => {
    const pa = apk.get(pp.id);
    return pa ? { ...pp, x: lerp(pa.x, pp.x, t), y: lerp(pa.y, pp.y, t) } : pp;
  });
  // deployables: interpolate position + aim for moving units (drones); static fortifications
  // have a==b so it's a no-op. hpFrac/reloading take the latest (b) value.
  const ad = new Map(a.deployables.map((x) => [x.id, x]));
  const deployables = b.deployables.map((db) => {
    const da = ad.get(db.id);
    return da
      ? { ...db, x: lerp(da.x, db.x, t), y: lerp(da.y, db.y, t), aim: lerpAngle(da.aim, db.aim, t) }
      : db;
  });

  // stalker: interpolate x/y/face/vis when present in both frames; else snap to b (appear/disappear)
  let stalker: SnapStalker;
  if (b.stalker.present && a.stalker.present) {
    stalker = {
      present: true,
      x: lerp(a.stalker.x, b.stalker.x, t),
      y: lerp(a.stalker.y, b.stalker.y, t),
      face: lerpAngle(a.stalker.face, b.stalker.face, t),
      state: b.stalker.state, // state takes latest (b)
      vis: lerp(a.stalker.vis, b.stalker.vis, t),
      contactCd: b.stalker.contactCd, // grab timer: take latest (b) — an event edge, not a spatial value
    };
  } else {
    stalker = b.stalker; // snap: appear or disappear — no partial lerp across a spawn/despawn edge
  }

  // fxEvents: take from b (latest) — they are non-idempotent one-shots, not spatial values.
  // The interpolated snapshot carries b's events so the client drain fires them once.
  return { ...b, players, zombies, bullets, pickups, deployables, stalker, fxEvents: b.fxEvents };
}
