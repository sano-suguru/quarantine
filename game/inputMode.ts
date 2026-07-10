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

/**
 * Reads DOM signals (matchMedia, ontouchstart, URL flags, and the settings override supplied
 * by the caller) to determine the active InputMode, then adds/removes `body.mobile`.
 *
 * Also registers a one-shot listener on the first real `pointerdown` / `touchstart` to
 * re-evaluate when the actual input device is known (a touch screen the browser's matchMedia
 * didn't flag as coarse, a mouse on a touch OS, etc.). The class is updated if the resolved
 * mode disagrees with the current state.
 *
 * Keep `resolveInputMode` pure — all DOM reads live here. The settings override is passed
 * in (not imported) to avoid a circular dependency with settings.ts, which imports InputMode.
 */
export function applyInputMode(override: InputMode | null): void {
  const params = new URLSearchParams(location.search);
  const forced: InputMode | null = params.has("mobile")
    ? "mobile"
    : params.has("desktop")
      ? "desktop"
      : null;

  const apply = (coarsePointer: boolean, hasTouch: boolean): void => {
    const mode = resolveInputMode({ coarsePointer, hasTouch, override, forced });
    if (mode === "mobile") {
      document.body.classList.add("mobile");
    } else {
      document.body.classList.remove("mobile");
    }
  };

  // Initial evaluation from static signals.
  apply(matchMedia("(pointer: coarse)").matches, "ontouchstart" in window);

  // Re-evaluate on the first real pointer/touch event to catch mis-detected devices.
  // Only runs once; whichever fires first removes both listeners.
  let refined = false;
  const onPointerDown = (e: PointerEvent): void => {
    if (refined) return;
    refined = true;
    window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    window.removeEventListener("touchstart", onTouchStart, { capture: true });
    // pointerType "touch" → coarse + hasTouch; "mouse"/"pen" → not coarse (unless we just
    // detected touchstart earlier, in which case refined was already true).
    apply(e.pointerType === "touch", e.pointerType === "touch" || "ontouchstart" in window);
  };
  const onTouchStart = (): void => {
    if (refined) return;
    refined = true;
    window.removeEventListener("pointerdown", onPointerDown, { capture: true });
    window.removeEventListener("touchstart", onTouchStart, { capture: true });
    apply(true, true);
  };

  window.addEventListener("pointerdown", onPointerDown, { capture: true });
  window.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
}
