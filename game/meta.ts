/**
 * Persistent meta-progression (survives across runs via localStorage).
 * Kept isolated here so the rest of the game stays pure run-state. SALVAGE is
 * earned per run and spent to permanently unlock weapons.
 */

const KEY = "q_meta";

export interface Meta {
  version: number;
  salvage: number;
  unlocked: Record<string, boolean>;
}

function fresh(): Meta {
  return { version: 1, salvage: 0, unlocked: {} };
}

/** Load meta, tolerating missing/corrupt storage by falling back to defaults. */
export function loadMeta(): Meta {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    const p = JSON.parse(raw) as Partial<Meta>;
    if (!p || typeof p !== "object") return fresh();
    return {
      version: 1,
      salvage: typeof p.salvage === "number" ? p.salvage : 0,
      unlocked: p.unlocked && typeof p.unlocked === "object" ? p.unlocked : {},
    };
  } catch {
    return fresh();
  }
}

function saveMeta(m: Meta): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage may be unavailable */
  }
}

/** Bank salvage at run end; returns the updated meta. */
export function addSalvage(n: number): Meta {
  const m = loadMeta();
  m.salvage += Math.max(0, Math.round(n));
  saveMeta(m);
  return m;
}

/** Spend salvage to permanently unlock a weapon. Returns updated meta, or null if unaffordable/owned. */
export function buyUnlock(id: string, price: number): Meta | null {
  const m = loadMeta();
  if (m.unlocked[id] || m.salvage < price) return null;
  m.salvage -= price;
  m.unlocked[id] = true;
  saveMeta(m);
  return m;
}
