/**
 * Pure ammo math, split out so it can be unit-tested without the full sim.
 * Moves spare rounds into the magazine on reload, never exceeding the mag size
 * or the available reserve.
 */
export function ammoTransfer(
  mag: number,
  ammo: number,
  reserve: number,
): { ammo: number; reserve: number } {
  const need = Math.max(0, mag - ammo);
  const take = Math.max(0, Math.min(need, reserve));
  return { ammo: ammo + take, reserve: reserve - take };
}
