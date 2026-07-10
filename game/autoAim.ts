/** Pure helpers for the unified auto control scheme. No DOM, no state. */

/** Aim precedence: nearest-target angle → movement heading → held last heading. */
export function resolveAim(
  target: number | null,
  moveX: number,
  moveY: number,
  lastHeading: number,
): number {
  if (target !== null) return target;
  if (moveX !== 0 || moveY !== 0) return Math.atan2(moveY, moveX);
  return lastHeading;
}

/** Is a world point inside the on-screen rect centred on the camera, expanded by `margin`? */
export function inViewport(
  zx: number,
  zy: number,
  camX: number,
  camY: number,
  halfX: number,
  halfY: number,
  margin: number,
): boolean {
  return Math.abs(zx - camX) <= halfX + margin && Math.abs(zy - camY) <= halfY + margin;
}

/** Hotbar slot (0..n) → absolute index into `order`; null if the slot is empty or unmapped. */
export function resolveHotbarSlot(
  loadout: readonly string[],
  order: readonly string[],
  hotbarIndex: number,
): number | null {
  const id = loadout[hotbarIndex];
  if (id === undefined) return null;
  const slot = order.indexOf(id);
  return slot === -1 ? null : slot;
}
