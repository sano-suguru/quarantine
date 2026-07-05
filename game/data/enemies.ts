import { SHAPE } from "../engine/renderer";
import type { EnemyType } from "../types";

export const ENEMY_TYPES: Record<string, EnemyType> = {
  walker: {
    hp: 85,
    speed: 60,
    radius: 15,
    dmg: 8,
    bounty: 5,
    attackRate: 1.0,
    color: [0.4, 0.56, 0.28],
    shape: SHAPE.circle,
    sprite: "zombie",
    glow: [0.35, 0.85, 0.3],
    eye: [1.0, 0.92, 0.4],
    sense: 520,
    wander: 0.6, // shambles, drifts off course
    separation: 1.0,
    nav: "none",
    perception: "omniscient",
  },
  runner: {
    hp: 50,
    speed: 130, // sits just below heavy-weapon move speed: heavies crawl away but lunge still closes
    radius: 13,
    dmg: 6,
    bounty: 8,
    attackRate: 1.4,
    color: [0.85, 0.72, 0.22],
    shape: SHAPE.tri,
    sprite: "runner",
    glow: [1.0, 0.65, 0.15],
    eye: [1.0, 1.0, 0.6],
    sense: 660,
    wander: 0.3,
    lunge: 2.3, // periodic dash toward the player
    lungePeriod: 2.4,
    separation: 1.0,
    nav: "path",
    perception: "sight",
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
    sprite: "brute",
    glow: [1.0, 0.18, 0.16],
    eye: [1.0, 0.35, 0.2],
    sense: 900,
    wander: 0.08, // relentless, near-straight
    separation: 0.15, // plows through the crowd
    nav: "avoid",
    perception: "omniscient",
  },
};
