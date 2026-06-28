import type { PlayerInput } from "./net/playerInput";

export interface WeaponDef {
  name: string;
  dmg: number;
  fireRate: number;
  bulletSpeed: number;
  spread: number;
  pellets: number;
  mag: number;
  reload: number;
  range: number;
  auto: boolean;
  knockback: number;
  recoil: number;
  pierce: number;
  color: [number, number, number];
  /** move-speed multiplier while equipped (weapon "weight": light >1 kite, heavy <1 stand-ground).
   *  Required so a new weapon can't silently default to full speed. */
  moveMul: number;
  /** spare rounds (outside the magazine) carried at run start */
  reserveStart: number;
  /** hard cap on spare rounds this weapon can hold */
  reserveMax: number;
  /** melee weapons swing an arc instead of spawning bullets; never consume ammo */
  melee?: boolean;
  /** melee half-angle (radians) of the damage cone */
  meleeArc?: number;
  /** melee reach in world units (added to player radius) */
  meleeRange?: number;
}

export interface EnemyType {
  hp: number;
  speed: number;
  radius: number;
  dmg: number;
  bounty: number;
  attackRate: number;
  color: [number, number, number];
  shape: number;
  glow: [number, number, number];
  eye: [number, number, number];
  /** aggro radius: zombies beyond it wander instead of chasing (daytime gating) */
  sense: number;
  /** heading-drift amount while wandering (0 = beeline) */
  wander?: number;
  /** periodic lunge speed multiplier (e.g. runner dash); omit for none */
  lunge?: number;
  /** seconds between lunges */
  lungePeriod?: number;
  /** how much the steering separation force affects this type (brute ≈ 0) */
  separation?: number;
}

export interface Upgrade {
  name: string;
  desc: string;
  /** mutate run-wide multipliers and/or the buying player `p` */
  apply: (s: State, p: Player) => void;
  /** optional "current → new" preview string for the shop card (p = local buyer) */
  preview?: (s: State, p: Player) => string;
}

export interface Player {
  /** stable per-player id (host-assigned); local player is state.localId */
  id: number;
  /** display name shown above remote players */
  name: string;
  /** per-player input snapshot — the only input source sysPlayer reads */
  input: PlayerInput;
  /** semi-auto edge latch: blocks auto-repeat while the fire button is held */
  firedThisHold: boolean;
  x: number;
  y: number;
  r: number;
  hp: number;
  maxHp: number;
  speed: number;
  /** current ramped move multiplier (host-only sim; lerps toward the equipped weapon's moveMul,
   *  not synced — clients re-derive it from the synced weapon during prediction) */
  curMoveMul: number;
  aim: number;
  weapon: string;
  /** rounds in the active weapon's magazine */
  ammo: number;
  /** spare rounds per weapon, keyed by weapon id */
  reserve: Record<string, number>;
  /** magazine state per weapon, preserved across weapon switches */
  mags: Record<string, number>;
  fireCd: number;
  reloadT: number;
  hitFlash: number;
  recoilX: number;
  recoilY: number;
  iframe: number;
  muzzle: number;
  /** brief flinch timer after a dry-fire (empty magazine) */
  dryT: number;
  /** flashlight charge remaining (0..CONFIG.flashlight.batteryMax) */
  battery: number;
  /** whether the flashlight is switched on (off = no drain, near-blind) */
  lightOn: boolean;
  /** medkits carried */
  medkits: number;
  /** purchase-ordered queue of bought-but-unplaced deployables (defId per entry). Buying a
   *  fortification pushes its id; the place action (Q) pops the front and drops it at the
   *  player's feet. Per-player (individual wallets), synced in snapshots (changes on buy/place). */
  deployQueue: string[];
  /** active heal timer; while > 0 the player is rooted and can't fire */
  healT: number;
  /** cooldown between barricade repair presses */
  repairCd: number;
  /** credits this player has earned/banked this run (co-op individual wallet; in SP this is
   *  the whole economy). Spent on their own weapon upgrades, perks, repairs, deployables. */
  money: number;
  /** run-scoped weapon upgrade level per weapon, per player (resets each run). Buying an
   *  upgrade strengthens only the buyer's copy of that weapon. */
  wlevel: Record<string, number>;
  /** per-player damage multiplier (perks like Hollow Points apply to the buyer only) */
  dmgMul: number;
  /** per-player fire-rate multiplier (Quick Hands) */
  fireRateMul: number;
  /** per-player spare-ammo capacity multiplier (Bandolier) */
  reserveMul: number;
  /** co-op revive progress (seconds) accumulated on THIS player while downed and a teammate
   *  tends them nearby; reaches CONFIG.assist.reviveTime to revive. Always 0 in single-player. */
  assistT: number;
  /** co-op (P4): true while this player's client is disconnected and the host is holding the
   *  body for a possible reconnect. An absent player is inert — not a zombie target, not
   *  counted by anyAlive, no input sim — and rendered as a faded ghost. Always false in SP. */
  absent: boolean;
  /** transient: true the ticks this player is actively searching a cache AT NIGHT (the rummaging
   *  "noise"). sysPlayer sets it each tick, sysAI reads it to surge nearby zombies (the lure).
   *  Host-derived, NOT synced — clients never run sysPlayer/sysAI so it stays false there. */
  searching: boolean;
}

export interface Zombie {
  /** stable id for network snapshot matching (host-authoritative; positive) */
  id: number;
  x: number;
  y: number;
  r: number;
  hp: number;
  maxHp: number;
  speed: number;
  dmg: number;
  bounty: number;
  attackCd: number;
  attackRate: number;
  color: [number, number, number];
  type: string;
  shape: number;
  glow: [number, number, number];
  eye: [number, number, number];
  vx: number;
  vy: number;
  flash: number;
  spawnT: number;
  wob: number;
  /** behaviour fields copied from EnemyType for per-instance steering */
  sense: number;
  wander: number;
  lunge: number;
  lungePeriod: number;
  separation: number;
  /** latched once aggroed (or at night); never reverts → guarantees the night clears */
  chasing: boolean;
  /** countdown to the next lunge */
  lungeCd: number;
  /** remaining duration of the current lunge burst */
  lungeT: number;
  /** current wander heading (radians), drifts over time */
  wanderDir: number;
}

export interface Bullet {
  /** stable id for snapshot matching; host bullets are positive, client-predicted ghosts negative */
  id: number;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  r: number;
  dmg: number;
  life: number;
  pierce: number;
  knockback: number;
  color: [number, number, number];
}

/** Data-driven pickup type: defines how a dropped item looks, sounds, and what it does. */
export interface PickupDef {
  id: string;
  /** short HUD label, e.g. "AMMO" / "MEDKIT" */
  label: string;
  color: [number, number, number];
  glow: [number, number, number];
  /** draw hint: "box" | "cross" */
  shape: string;
  /** mutates the collecting player `p` when picked up (reads their weapon for ammo top-ups) */
  apply: (s: State, p: Player) => void;
}

/** A collectible instance on the ground. Type/behaviour lives in PICKUP_TYPES, referenced by defId. */
export interface Pickup {
  /** stable id for network snapshot matching (host-authoritative; positive) */
  id: number;
  x: number;
  y: number;
  defId: string;
  life: number;
  maxLife: number;
  /** phase offset for the idle bob/blink animation */
  bob: number;
}

export type ParticleKind = "spark" | "shard" | "ring" | "smoke";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  r: number;
  rot: number;
  color: [number, number, number];
  kind: ParticleKind;
  drag: number;
}

interface DamageText {
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  value: number;
  crit: boolean;
}

interface Decal {
  x: number;
  y: number;
  r: number;
  rot: number;
  color: [number, number, number];
  life: number;
  maxLife: number;
}

/** A line segment in world space (shelter wall / opening). */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A boardable opening: blocks zombies (and is attackable) but lets the player and bullets through. */
export interface Barricade extends Segment {
  hp: number;
  maxHp: number;
  /** white hit-flash timer for damage feedback */
  flash: number;
}

/** A searchable loot container out in the world (daytime scavenging). */
export interface Cache {
  x: number;
  y: number;
  /** already searched this day */
  looted: boolean;
  /** search progress (seconds) while the player holds interact nearby */
  searchT: number;
  /** loot tier (higher = richer); set by distance from home */
  tier: number;
}

/** Data-driven deployable type, composed from capability blocks: a def enables a behaviour
 *  by *having* the matching block, and sysDeployables runs whichever blocks are present. This
 *  is the extension seam — a new mix (e.g. a moving emitter, a non-combat support unit) is
 *  pure data; only a genuinely new capability class needs a new handler. Sentry = weapon +
 *  destructible, drone = weapon + movement + destructible, Station = emitter. */
export interface DeployableDef {
  id: string;
  name: string;
  desc: string;
  /** credits the buyer pays (individual wallet); the placed structure benefits everyone */
  cost: number;
  /** how many of this type may exist at once this run */
  cap: number;
  color: [number, number, number];
  /** auto-fire at the nearest zombie. `interval` = seconds between shots; `magSize`/`reloadTime`
   *  add a self-recharging magazine (caps sustained DPS via a reload gap; no ammo purchase). */
  weapon?: {
    range: number;
    dmg: number;
    bulletSpeed: number;
    interval: number;
    magSize?: number;
    reloadTime?: number;
  };
  /** periodically drop a pickup (`emit` = pickup defId) every `interval` seconds */
  emitter?: { emit: string; interval: number };
  /** leash-follow the nearest alive player and approach zombies to engage */
  movement?: { speed: number; leashMax: number; hoverDist: number; switchMargin: number };
  /** takes contact damage from adjacent zombies; removed at hp<=0 */
  destructible?: { maxHp: number; contactRadius: number; contactDps: number };
  /** a physical body: pushes zombies and players out of `radius`, so a placed structure blocks
   *  a lane (chokepoint). Bodyless types (drone hovers, station has none) omit this and are
   *  walked through. `canPlaceAt` also uses it to forbid placing inside walls / on another body. */
  collider?: { radius: number };
  /** draw hint; inferred from capabilities when omitted */
  visual?: "turret" | "drone" | "crate";
}

/** A placed fortification instance. Type/behaviour lives in DEPLOYABLE_TYPES via defId.
 *  The host advances the host-only sim fields and summarises them into the synced display
 *  fields (`hpFrac`/`reloading`) at capture; clients only interpolate + render. */
export interface Deployable {
  /** stable id for network snapshot matching (host-authoritative; positive) */
  id: number;
  defId: string;
  x: number;
  y: number;
  /** current barrel aim (radians), for rendering the tracking barrel */
  aim: number;
  /** synced display state (status byte): current HP fraction 0..1 (1 if not destructible) */
  hpFrac: number;
  /** synced display state: weapon is mid-reload (drives the reload cue) */
  reloading: boolean;
  // ---- host-only sim state (not in snapshot; clients don't simulate it) ----
  /** countdown to the next shot */
  weaponCd?: number;
  /** countdown to the next emit */
  emitCd?: number;
  /** rounds left in the magazine */
  ammoLeft?: number;
  /** reload countdown (>0 = reloading) */
  reloadT?: number;
  /** absolute hp (destructible only) */
  hp?: number;
  /** movement: the player this unit is leashed to */
  anchorId?: number;
  /** weapon: current target zombie (for target hysteresis) */
  targetId?: number;
}

/** Day = lit scavenge/repair window; night = the dark horde siege. */
export type SiegePhase = "day" | "night";

export interface WaveDefinition {
  /** composition weights sampled per spawn pulse */
  weights: { type: string; w: number }[];
  /** zombies spawned per pulse */
  batch: number;
  /** seconds between pulses */
  interval: number;
  hpScale: number;
  spdScale: number;
}

interface Wave {
  n: number;
  def: WaveDefinition | null;
  spawnT: number;
}

interface Cam {
  x: number;
  y: number;
  shake: number;
}

export interface State {
  running: boolean;
  paused: boolean;
  /** between-nights arsenal shop is open (host-authoritative; synced in snapshots so
   *  clients show the same shop overlay). Distinct from `paused` (manual pause). */
  inShop: boolean;
  time: number;
  /** monotonic id allocator for zombies/bullets/pickups (host-authoritative) */
  nextId: number;
  /** all players in the session (1 in single-player); see localId for "me" */
  players: Player[];
  /** id of the player controlled on this client */
  localId: number;
  zombies: Zombie[];
  bullets: Bullet[];
  pickups: Pickup[];
  particles: Particle[];
  texts: DamageText[];
  decals: Decal[];
  /** static shelter walls (block player, zombies and bullets) */
  walls: Segment[];
  /** boardable openings (block zombies only; repairable, destructible) */
  barricades: Barricade[];
  /** searchable loot caches across the map (daytime scavenging) */
  caches: Cache[];
  /** placed fortifications (turrets / supply stations); bought in the shop, persist the run */
  deployables: Deployable[];
  /** day/night siege phase */
  phase: SiegePhase;
  /** current day number (drives night horde intensity) */
  day: number;
  /** seconds left in the current phase (day countdown) */
  phaseT: number;
  cam: Cam;
  wave: Wave;
  /** total kills this run (shared run stat; drives wave count and SALVAGE) */
  kills: number;
  /** which weapons are available this run (starters + meta-unlocked). Shared = account-level
   *  unlock axis; per-player power (wlevel/muls/money) lives on Player. */
  owned: Record<string, boolean>;
  hash: SpatialHashLike;
  hitstopT: number;
  flashT: number;
  flashColor: [number, number, number];
  surrounded: number;
  /** nearby zombies that are outside the flashlight cone (behind / in the dark) */
  lurking: number;
}

/** Structural type so state.ts need not import the engine class directly. */
interface SpatialHashLike {
  clear(): void;
  insert(i: number, x: number, y: number): void;
  query(x: number, y: number, r: number, cb: (i: number) => void): void;
}
