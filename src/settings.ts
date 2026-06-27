/**
 * Player-facing options that persist across sessions (localStorage), kept separate from
 * run-state and meta-progression. Read every frame by localInput (aim assist), so the value
 * is cached in memory and only re-read from storage on demand.
 */

const KEY = "q_settings";

export interface Settings {
  /** opt-in auto-aim: point the gun (and thus the flashlight) at the nearest zombie. OFF by
   *  default — manual mouse aim is the horror default; this lowers the aiming skill wall. */
  aimAssist: boolean;
}

function fresh(): Settings {
  return { aimAssist: false };
}

let cached: Settings | null = null;

/** Current settings (cached in memory; safe to call per-frame). */
export function getSettings(): Settings {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Settings>) : null;
    cached = { aimAssist: typeof p?.aimAssist === "boolean" ? p.aimAssist : false };
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

/** Toggle/set the aim-assist option; returns the new value. */
export function setAimAssist(on: boolean): boolean {
  save({ ...getSettings(), aimAssist: on });
  return on;
}
