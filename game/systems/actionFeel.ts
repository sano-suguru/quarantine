import { CONFIG } from "../config";
import { effWeapon } from "../data/arsenal";
import type { Player, State } from "../types";

export type ActionKind =
  | "none"
  | "reload"
  | "heal"
  | "switch"
  | "search"
  | "repair"
  | "mateHeal"
  | "revive";

export interface ActionChannel {
  kind: ActionKind;
  /** 0 = just started, 1 = complete */
  phase: number;
}

export interface ActionMotion {
  /** world-units to lean toward the action focus (caller supplies the focus direction) */
  lean: number;
  /** world-units of periodic bob perpendicular to the lean */
  bob: number;
}

/** Decay one tick of a swing ramp (pure). */
export function decaySwing(swingT: number, dt: number): number {
  return Math.max(0, swingT - dt);
}

const BOBBING: ReadonlySet<ActionKind> = new Set([
  "search",
  "repair",
  "mateHeal",
  "revive",
  "heal",
]);

/** Body motion for an action: a phase-scaled lean plus a working bob. Pure. */
export function actionMotion(
  kind: ActionKind,
  phase: number,
  time: number,
  cfg: typeof CONFIG.actionFeel,
): ActionMotion {
  if (kind === "none") return { lean: 0, bob: 0 };
  const lean = cfg.lean * Math.max(0, Math.min(1, phase));
  const hz = kind === "search" ? cfg.search.digHz : cfg.bobHz;
  const bob = BOBBING.has(kind) ? Math.sin(time * hz * Math.PI * 2) * cfg.bob : 0;
  return { lean, bob };
}

/**
 * Normalize a player's live state into one action descriptor. Precedence: a rooted action
 * (heal) wins over gear actions (reload/switch), which win over discrete swings, which win
 * over passive search. Revive-as-reviver is NOT derived here (it depends on a *teammate's*
 * downed state) — draw handles it separately. Kept close to pure: reads player timers,
 * state.phase, and the weapon table for reload/switch normalization.
 */
export function deriveActionChannel(p: Player, _state: State): ActionChannel {
  if (p.healT > 0) {
    return { kind: "heal", phase: 1 - p.healT / CONFIG.heal.duration };
  }
  const wd = effWeapon(p, p.weapon);
  if (p.reloadT > 0 && !wd.melee) {
    return { kind: "reload", phase: 1 - p.reloadT / wd.reload };
  }
  if (p.switchT > 0) {
    const draw = wd.drawTime || 0.5;
    return { kind: "switch", phase: 1 - p.switchT / draw };
  }
  if (p.swingT > 0 && p.swingKind) {
    return { kind: p.swingKind, phase: p.swingT / CONFIG.actionFeel.swingDecay };
  }
  if (p.searching) return { kind: "search", phase: 1 };
  return { kind: "none", phase: 0 };
}
