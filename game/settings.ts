/**
 * Player-facing options persisted across sessions (localStorage), separate from run-state and
 * meta. `loadout` = the ≤3 weapon ids shown on the (all-platform) hotbar. `inputModeOverride`
 * lets a mis-detected device switch HUD mode. Cached in memory; safe to read per-frame.
 */
import { STARTER_WEAPONS } from "./data/weapons";
import type { InputMode } from "./inputMode";

const KEY = "q_settings";
export const MAX_LOADOUT = 3;
export const DEFAULT_LOADOUT = STARTER_WEAPONS.filter((id) => id !== "knife").slice(0, MAX_LOADOUT);

export interface Settings {
  loadout: string[];
  inputModeOverride: InputMode | null;
}

function fresh(): Settings {
  return { loadout: [...DEFAULT_LOADOUT], inputModeOverride: null };
}

let cached: Settings | null = null;

export function getSettings(): Settings {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Settings>) : null;
    const loadout =
      Array.isArray(p?.loadout) && p.loadout.length
        ? p.loadout.filter((x): x is string => typeof x === "string").slice(0, MAX_LOADOUT)
        : [...DEFAULT_LOADOUT];
    const ov = p?.inputModeOverride;
    cached = {
      loadout: loadout.length ? loadout : [...DEFAULT_LOADOUT],
      inputModeOverride: ov === "mobile" || ov === "desktop" ? ov : null,
    };
  } catch {
    cached = fresh();
  }
  return cached;
}

function save(s: Settings): void {
  cached = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage may be unavailable */
  }
}

export function setLoadout(ids: string[]): string[] {
  const loadout = ids.slice(0, MAX_LOADOUT);
  save({ ...getSettings(), loadout });
  return loadout;
}

export function setInputModeOverride(m: InputMode | null): void {
  save({ ...getSettings(), inputModeOverride: m });
}
