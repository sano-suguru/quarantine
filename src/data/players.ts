type RGB = [number, number, number];

/**
 * Per-player body colors (co-op). The local player is always drawn in TOXIC green
 * (see game.ts); remote players cycle through this palette by id so teammates are
 * told apart at a glance. Data-driven: add a color to support more players.
 */
export const PLAYER_COLORS: RGB[] = [
  [0.49, 1.0, 0.31], // toxic green (also the local default)
  [0.45, 0.7, 1.0], // blue
  [1.0, 0.62, 0.3], // orange
  [0.85, 0.5, 1.0], // violet
];

export function playerColor(id: number): RGB {
  return PLAYER_COLORS[id % PLAYER_COLORS.length] as RGB;
}
