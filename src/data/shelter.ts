import type { Segment } from "../types";

/**
 * The fixed shelter (the "mansion") the player holes up in. Data-driven so new
 * layouts are just another entry. `walls` are solid (block everything);
 * `openings` are window/door gaps that get a boardable barricade at run start.
 *
 * Rectangle centred on the origin: 360 × 300, with a window on each of three
 * sides and a wider door on the bottom.
 */
const HW = 180;
const HH = 150;

export const SHELTER: { walls: Segment[]; openings: Segment[] } = {
  walls: [
    // top (y = -HH), window gap x ∈ [-50, 50]
    { x1: -HW, y1: -HH, x2: -50, y2: -HH },
    { x1: 50, y1: -HH, x2: HW, y2: -HH },
    // bottom (y = HH), door gap x ∈ [-60, 60]
    { x1: -HW, y1: HH, x2: -60, y2: HH },
    { x1: 60, y1: HH, x2: HW, y2: HH },
    // left (x = -HW), window gap y ∈ [-40, 40]
    { x1: -HW, y1: -HH, x2: -HW, y2: -40 },
    { x1: -HW, y1: 40, x2: -HW, y2: HH },
    // right (x = HW), window gap y ∈ [-40, 40]
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
