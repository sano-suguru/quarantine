export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function show(id: string): void {
  el(id).classList.remove("hidden");
}

export function hide(id: string): void {
  el(id).classList.add("hidden");
}

/**
 * True when a keystroke is destined for a text field (room-code input, manual-SDP
 * textareas, etc.), so the global game-hotkey listeners can bail out instead of
 * hijacking/preventDefault-ing characters the player is trying to type.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
