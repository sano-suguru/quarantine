/** Pure precedence for the control HUD mode. Detection only chooses layout/widgets — the
 *  control SCHEME never branches on this. Precedence: forced query flag > user override >
 *  (coarse pointer AND touch) ⇒ mobile, else desktop. */
export type InputMode = "mobile" | "desktop";

export function resolveInputMode(env: {
  coarsePointer: boolean;
  hasTouch: boolean;
  override: InputMode | null;
  forced: InputMode | null;
}): InputMode {
  if (env.forced) return env.forced;
  if (env.override) return env.override;
  return env.coarsePointer && env.hasTouch ? "mobile" : "desktop";
}
