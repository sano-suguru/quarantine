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
}

export interface EnemyType {
  hp: number;
  speed: number;
  radius: number;
  dmg: number;
  bounty: number;
  attackRate: number;
  color: [number, number, number];
}

export interface Upgrade {
  name: string;
  desc: string;
  apply: (s: State) => void;
}

export interface Player {
  x: number;
  y: number;
  r: number;
  hp: number;
  maxHp: number;
  speed: number;
  aim: number;
  weapon: string;
  ammo: number;
  fireCd: number;
  reloadT: number;
}

export interface Zombie {
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
}

export interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  dmg: number;
  life: number;
  pierce: number;
}

export type WavePhase = "prep" | "active" | "cleared";

export interface WaveDefinition {
  spawn: string[];
  hpScale: number;
  spdScale: number;
  interval: number;
}

export interface Wave {
  n: number;
  phase: WavePhase;
  t: number;
  queue: string[];
  def: WaveDefinition | null;
  spawnT: number;
}

export interface Cam {
  x: number;
  y: number;
  shake: number;
}

export interface State {
  running: boolean;
  paused: boolean;
  time: number;
  player: Player;
  zombies: Zombie[];
  bullets: Bullet[];
  cam: Cam;
  wave: Wave;
  money: number;
  kills: number;
  dmgMul: number;
  fireRateMul: number;
  hash: SpatialHashLike;
  _firedThisHold: boolean;
}

/** Structural type so state.ts need not import the engine class directly. */
export interface SpatialHashLike {
  clear(): void;
  insert(i: number, x: number, y: number): void;
  query(x: number, y: number, r: number, cb: (i: number) => void): void;
}
