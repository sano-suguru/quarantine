import type { FlowField } from "./engine/navfield";
import type { PlayerInput } from "./playerInput";

export interface GunPart {
  /** forward offset along aim, world units (+ = toward muzzle) */
  dx: number;
  /** lateral offset perpendicular to aim, world units (a mag hangs / a sight sits) */
  dy: number;
  /** rotation relative to the rig, radians (0 = aligned with the barrel) */
  rot: number;
  /** for rect: length along the barrel axis. For radial shapes: the diameter (rad = len/2). World units. */
  len: number;
  /** rect width across the axis (world units). Ignored by radial shapes. */
  wid: number;
  /** primitive; defaults to "rect". radial shapes (circle/ring/tri/hex) use rad = len/2 */
  shape?: "rect" | "circle" | "ring" | "tri" | "hex";
  /** rgb; defaults to the weapon's `color` */
  color?: [number, number, number];
  /** 0..1; defaults to 1 (multiplied by the draw-pose dim) */
  alpha?: number;
}

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
  /** held-weapon silhouette: primitives in gun-local space (x = forward along aim, y = lateral).
   *  drawPlayer applies the player transform + draw-anim pose and renders each part. No per-weapon
   *  branching — drawWeaponRig dispatches per shape only. */
  viz: GunPart[];
  /** seconds to "draw" (lower→raise) after a switch; also the post-switch fire-lockout. Heavier guns
   *  are slower. MUST be > 0 (the draw pose divides by it). */
  drawTime: number;
  /** melee weapons swing an arc instead of spawning bullets; never consume ammo */
  melee?: boolean;
  /** melee half-angle (radians) of the damage cone */
  meleeArc?: number;
  /** melee reach in world units (added to player radius) */
  meleeRange?: number;
}

export type NavMode = "none" | "avoid" | "path";

export type Perception = "omniscient" | "sight";
export type Percept = "hunt" | "search" | "idle";

export interface EnemyType {
  hp: number;
  speed: number;
  radius: number;
  dmg: number;
  bounty: number;
  attackRate: number;
  color: [number, number, number];
  shape: number;
  /** sprite-atlas key (a game/assets/sprites/<key>.png); the renderer draws this illustration
   *  instead of the SDF `shape`. Draw-time only, never synced. */
  sprite: string;
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
  /** navigation intelligence: none=beeline, avoid=steer around walls, path=flow-field route */
  nav?: NavMode;
  /** perception model for this enemy type; defaults to "omniscient" (always knows player position) */
  perception?: Perception;
}

export interface Upgrade {
  /** stable id for the draft card (`perk:<id>`) and meta unlock flag (`card:<id>`) */
  id: string;
  /** in the starter draft pool from a fresh save (false = unlocked via SALVAGE) */
  starter: boolean;
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
  /** weapon-draw timer: set to the new weapon's drawTime on switch, counts down to 0. Drives the
   *  lower→raise held-weapon animation. Cosmetic — the fire-lockout is fireCd. Synced (u8). */
  switchT: number;
  hitFlash: number;
  recoilX: number;
  recoilY: number;
  iframe: number;
  muzzle: number;
  /** brief flinch timer after a dry-fire (empty magazine) */
  dryT: number;
  /** flashlight charge remaining (0..CONFIG.flashlight.batteryMax) */
  battery: number;
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
  /** decaying "swing" ramp (seconds) for discrete held-E actions (repair/mate-heal): set to
   *  CONFIG.actionFeel.swingDecay on each press, decays to 0. Drives continuous motion + net
   *  re-derivation of an otherwise 1-tick event. Synced (u8). */
  swingT: number;
  /** which discrete action the current swing is (drives prop/particle choice). Synced (2 bits). */
  swingKind: "" | "repair" | "mateHeal";
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
  /** seconds spent downed (hp<=0). Ticks in sysRespawn; at CONFIG.siege.respawnDelay the player
   *  auto-respawns at the fortress. Reset to 0 by revivePlayer (peer/timer/dawn). */
  downT: number;
  /** co-op (P4): true while this player's client is disconnected and the host is holding the
   *  body for a possible reconnect. An absent player is inert — not a zombie target, not
   *  counted by anyAlive, no input sim — and rendered as a faded ghost. Always false in SP. */
  absent: boolean;
  /** transient: true the ticks this player is actively searching a cache AT NIGHT (the rummaging
   *  "noise"). sysPlayer sets it each tick, sysAI reads it to surge nearby zombies (the lure).
   *  Host-derived, NOT synced — clients never run sysPlayer/sysAI so it stays false there. */
  searching: boolean;
  /** host-only transient hearing loudness (fire/run/rummage); NOT synced. Rises on noise-producing
   *  actions and decays each tick. Consumed by the perception system (Task 4) as the hearing
   *  input radius for sight-model zombies. Zero until Task 4 reads it — no behavior change yet. */
  noise: number;
  /** between-nights draft: card ids currently offered to this player (host-rolled, snapshot-synced) */
  draftOffer: string[];
  /** how many free picks this player has spent this night (free while < CONFIG.arsenal.freePicks,
   *  then cards cost SCRAP). Reset each night by rollDraft. */
  draftFreePicksUsed: number;
  /** rerolls this player has done this night — drives escalating rerollCost; reset at openShop */
  draftRerolls: number;
  /** card ids this player has TAKEN this night (PERK ids only). Host-only roll state, NOT
   *  snapshot-synced: only the host rolls/rerolls so clients never read it (makePlayer inits it to
   *  []). Reset each night by rollDraft; passed as `exclude` to rollOffer on reroll so a taken perk
   *  cannot resurface and stack within one night. Weapon (`lvl:`) cards are intentionally excluded
   *  from this list — they are maxLevel-capped by canBuy and may be re-upgraded the same night. */
  draftTaken: string[];
  /** the state.day a fresh draft offer was last rolled for this player — guards a mid-day joiner
   *  (rolled on spawn) against a second roll by the same day's dawn pass (which would re-grant free picks). */
  draftRolledForDay: number;
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
  nav: NavMode;
  /** latched once aggroed (or at night); never reverts for omniscient types → guarantees the night clears.
   *  For sight types, chasing is derived each frame from percept (hunt/search) and does revert. */
  chasing: boolean;
  /** countdown to the next lunge */
  lungeCd: number;
  /** remaining duration of the current lunge burst */
  lungeT: number;
  /** current wander heading (radians), drifts over time */
  wanderDir: number;
  /** perception model for this zombie (host-only; not synced) */
  perception: Perception;
  /** current perception state: actively hunting, searching last-seen pos, or idle (host-only) */
  percept: Percept;
  /** world-space X of the last known player position (host-only) */
  lastSeenX: number;
  /** world-space Y of the last known player position (host-only) */
  lastSeenY: number;
  /** countdown for search-mode duration (host-only) */
  searchT: number;
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

export type ParticleKind = "spark" | "shard" | "ring" | "smoke" | "frag";

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
  /** real-image fragment (gore shatter): the sprite KEY + sub-cell it draws (game.ts resolves key→layer) */
  spriteKey?: string;
  cellX?: number;
  cellY?: number;
  /** fragment settles into a decal on expiry (set by fxKill for the first fragDecalMax fragments) */
  settle?: boolean;
}

interface Decal {
  x: number;
  y: number;
  r: number;
  rot: number;
  color: [number, number, number];
  life: number;
  maxLife: number;
  /** real-image fragment decal (gore): sprite KEY + sub-cell + on-screen size (game.ts resolves key→layer); plain blood leaves undefined */
  spriteKey?: string;
  cellX?: number;
  cellY?: number;
  size?: number;
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
  /** auto-fire at the nearest zombie. `interval` = seconds between shots. An optional `mag`
   *  adds a magazine (caps sustained DPS via a reload gap; no ammo purchase); omit it for a
   *  no-reload continuous weapon. */
  weapon?: {
    range: number;
    dmg: number;
    bulletSpeed: number;
    interval: number;
    /** magazine: `size` rounds fire before a `reloadTime`-second reload. `ammoBudget` (nested
     *  here so it can't exist without a magazine) is the total rounds the unit will ever fire
     *  before retiring (RTB); omitted = infinite reserve (self-recharging, e.g. the sentry). */
    mag?: { size: number; reloadTime: number; ammoBudget?: number };
  };
  /** periodically drop a pickup (`emit` = pickup defId) every `interval` seconds */
  emitter?: { emit: string; interval: number };
  /** leash-follow the nearest alive player and approach zombies to engage */
  movement?: {
    speed: number;
    leashMax: number;
    hoverDist: number;
    /** radius of the strafing ring the unit orbits around a target while engaging */
    engageDist: number;
    switchMargin: number;
    orbitSpeed: number;
    /** idle barrel scan: a slow sinusoidal aim wobble — `scanFreq` rad/s, `scanAmp` radians */
    scanFreq: number;
    scanAmp: number;
  };
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
  /** absolute sim time of the next scheduled emit, snapped to the interval grid — so drops land
   *  exactly where the `state.time`-driven beacon resets (host & client read the same phase) */
  emitAt?: number;
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
  /** host-only: rounds left before RTB (ammoBudget types) */
  reserveLeft?: number;
  // ---- synced display state ----
  /** synced 0..1: remaining ammo for the ring (1 if infinite-reserve) */
  ammoFrac?: number;
}

/** The unkillable pursuer — a single-instance horror that runs on a separate subsystem. */
export interface Stalker {
  x: number;
  y: number;
  face: number;
  state: "lull" | "aggro" | "stagger" | "retreat";
  staggerT: number;
  contactCd: number;
  vis: number;
}

// carried data mirrors what today's call sites pass; visuals the client can
// reconstruct from tables (enemy type → color/glow/sprite) are referenced by
// index/id, not duplicated — keeps the event wire-friendly for Phase 2.
export type FxEvent =
  | {
      t: "kill";
      x: number;
      y: number;
      type: string;
      big: boolean;
      dir: number;
      radius: number;
      hitDir: number;
    }
  | {
      t: "impact";
      x: number;
      y: number;
      ang: number;
      color: [number, number, number];
      intensity: number;
    }
  | { t: "hit"; x: number; y: number }
  | { t: "hurt"; x: number; y: number; local: boolean }
  | {
      t: "muzzle";
      x: number;
      y: number;
      ang: number;
      color: [number, number, number];
      weapon: string;
      melee: boolean;
    }
  | { t: "audio"; cue: string; arg?: number | string }
  | { t: "announce"; label: string; day: number }
  | { t: "dust"; x: number; y: number; n: number }
  | { t: "mote"; x: number; y: number; color: [number, number, number] }
  | { t: "burst"; x: number; y: number; color: [number, number, number]; ring: boolean }
  | { t: "pickup"; x: number; y: number; glow: [number, number, number] }
  | { t: "deployDestroy"; x: number; y: number; color: [number, number, number]; rtb: boolean };

/** Day = lit scavenge window; night = the horde siege; breached = the frozen "fortress fell"
 *  beat; resetting = the brief Day-1 rebuild window. */
export type SiegePhase = "day" | "night" | "breached" | "resetting";

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
  /** breach-detection sustain accumulator (counts up while the interior is overrun, decays below
   *  threshold). Server-only + transient — NOT snapshotted, NOT persisted (like flow/navTick). */
  breachT: number;
  cam: Cam;
  wave: Wave;
  /** total kills this run (shared run stat; drives wave count and SALVAGE) */
  kills: number;
  /** cumulative SALVAGE already banked to clients this arena life; baseline for the per-dawn
   *  delta (dawn banks salvageEarned(day,kills) - salvageBanked, split among present players). */
  salvageBanked: number;
  /** which weapons are available this run (starters + meta-unlocked). Shared = account-level
   *  unlock axis; per-player power (wlevel/muls/money) lives on Player. */
  owned: Record<string, boolean>;
  /** which perk cards are unlocked this run (id = `card:<perkId>`); from meta, host-authoritative.
   *  Read by draftPool. Separate from `owned` (weapons) so the two namespaces don't collide. */
  unlockedCards: Record<string, boolean>;
  /** The Stalker instance; null until first spawn (Phase 2+). */
  stalker: Stalker | null;
  hash: SpatialHashLike;
  hitstopT: number;
  surrounded: number;
  /** nearby zombies that are outside the flashlight cone (behind / in the dark) */
  lurking: number;
  // ---- host-only transient navigation state (NOT in captureSnapshot/encode) ----
  /** current flow field for path-nav zombies; null until first build or when no living players */
  flow: FlowField | null;
  /** monotonic sim-tick counter used to schedule flow-field rebuilds (one per sysAI call).
   *  There is no general state.tick — this is the only tick counter in state. */
  navTick: number;
  /** discrete per-tick cue buffer: systems push, the client drains to audio/fx (see sim/events.ts) */
  fxEvents: FxEvent[];
}

/** Structural type so state.ts need not import the engine class directly. */
interface SpatialHashLike {
  clear(): void;
  insert(i: number, x: number, y: number): void;
  query(x: number, y: number, r: number, cb: (i: number) => void): void;
}
