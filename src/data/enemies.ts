import type { EnemyType } from "../types";

export const ENEMY_TYPES: Record<string, EnemyType> = {
  walker: {
    hp: 60,
    speed: 60,
    radius: 15,
    dmg: 8,
    bounty: 5,
    attackRate: 1.0,
    color: [0.45, 0.62, 0.3],
  },
  runner: {
    hp: 35,
    speed: 140,
    radius: 12,
    dmg: 6,
    bounty: 8,
    attackRate: 1.4,
    color: [0.85, 0.75, 0.25],
  },
  brute: {
    hp: 260,
    speed: 40,
    radius: 26,
    dmg: 22,
    bounty: 25,
    attackRate: 0.6,
    color: [0.7, 0.3, 0.3],
  },
};
