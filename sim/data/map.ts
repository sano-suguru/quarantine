import type { Segment } from "../types";

/**
 * The world map: the boardable HOME mansion (defended at night) plus scattered
 * POI buildings to scavenge by day. Data-driven — add a POI by adding an entry.
 *
 * HOME walls are solid; HOME openings get boardable barricades at run start.
 * POI walls are solid; each POI holds one loot cache.
 */

/** HOME half-extents (the fortress interior is |x| < HW && |y| < HH). Exported for breach detection. */
export const HW = 180;
export const HH = 150;

/** Default spawn / respawn point, inside HOME and clear of the walls. */
export const HOME_SPAWN = { x: 0, y: 80 };

/** Fortress shop workbench: interact here during the day to open the per-player shop overlay. */
export const WORKBENCH = { x: 0, y: 0 };

export const HOME: { walls: Segment[]; openings: Segment[] } = {
  walls: [
    { x1: -HW, y1: -HH, x2: -50, y2: -HH },
    { x1: 50, y1: -HH, x2: HW, y2: -HH },
    { x1: -HW, y1: HH, x2: -60, y2: HH },
    { x1: 60, y1: HH, x2: HW, y2: HH },
    { x1: -HW, y1: -HH, x2: -HW, y2: -40 },
    { x1: -HW, y1: 40, x2: -HW, y2: HH },
    { x1: HW, y1: -HH, x2: HW, y2: -40 },
    { x1: HW, y1: 40, x2: HW, y2: HH },
  ],
  openings: [
    { x1: -50, y1: -HH, x2: 50, y2: -HH }, // top window
    { x1: -60, y1: HH, x2: 60, y2: HH }, // bottom door
    { x1: -HW, y1: -40, x2: -HW, y2: 40 }, // left window
    { x1: HW, y1: -40, x2: HW, y2: 40 }, // right window
  ],
};

export interface Poi {
  walls: Segment[];
  cache: { x: number; y: number };
}

/** Build a rectangular room centred at (cx,cy) with a door gap on the bottom edge. */
function room(cx: number, cy: number, hw: number, hh: number, door = 30): Poi {
  return {
    walls: [
      { x1: cx - hw, y1: cy - hh, x2: cx + hw, y2: cy - hh }, // top
      { x1: cx - hw, y1: cy - hh, x2: cx - hw, y2: cy + hh }, // left
      { x1: cx + hw, y1: cy - hh, x2: cx + hw, y2: cy + hh }, // right
      { x1: cx - hw, y1: cy + hh, x2: cx - door, y2: cy + hh }, // bottom-left
      { x1: cx + door, y1: cy + hh, x2: cx + hw, y2: cy + hh }, // bottom-right
    ],
    cache: { x: cx, y: cy },
  };
}

// Spread across the arena (±1600) at varied distances from HOME → varied loot tiers.
export const POIS: Poi[] = [
  room(-620, -520, 110, 95),
  room(680, -560, 120, 100),
  room(-700, 600, 100, 90),
  room(720, 640, 130, 110),
];
