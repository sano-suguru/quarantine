import { SHAPE } from "../engine/renderer";
import type { EnemyType } from "../types";

export const ENEMY_TYPES: Record<string, EnemyType> = {
  walker: {
    hp: 60,
    speed: 60,
    radius: 15,
    dmg: 8,
    bounty: 5,
    attackRate: 1.0,
    color: [0.4, 0.56, 0.28],
    shape: SHAPE.circle,
    glow: [0.35, 0.85, 0.3],
    eye: [1.0, 0.92, 0.4],
  },
  runner: {
    hp: 35,
    speed: 140,
    radius: 13,
    dmg: 6,
    bounty: 8,
    attackRate: 1.4,
    color: [0.85, 0.72, 0.22],
    shape: SHAPE.tri,
    glow: [1.0, 0.65, 0.15],
    eye: [1.0, 1.0, 0.6],
  },
  brute: {
    hp: 260,
    speed: 40,
    radius: 27,
    dmg: 22,
    bounty: 25,
    attackRate: 0.6,
    color: [0.62, 0.26, 0.26],
    shape: SHAPE.hex,
    glow: [1.0, 0.18, 0.16],
    eye: [1.0, 0.35, 0.2],
  },
};
