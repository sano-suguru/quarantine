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

/**
 * Keyed list reconcile — the one mechanism behind every dynamic UI list (room
 * browser, squad chips, shop, arsenal), generalizing the ad-hoc `replaceChildren`
 * / `shopSig` patterns. Nodes are matched to items by `keyOf`: a surviving key
 * keeps its node (so hover/focus/listeners persist), a new key calls `create`, a
 * vanished key is removed. Content updates are expressed *through the key* — fold
 * the mutable fields into it (e.g. `${id}:${price}`) and a changed row is rebuilt.
 * Deliberately create-only: there is no separate update callback.
 */
export function renderList<T>(
  container: HTMLElement,
  items: readonly T[],
  keyOf: (item: T, index: number) => string,
  create: (item: T, index: number) => HTMLElement,
): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) {
    if (child instanceof HTMLElement && child.dataset.key !== undefined) {
      existing.set(child.dataset.key, child);
    }
  }
  const seen = new Set<string>();
  const used = new Set<HTMLElement>();
  let cursor: ChildNode | null = container.firstChild;
  items.forEach((item, i) => {
    const key = keyOf(item, i);
    let node = existing.get(key);
    if (!node || seen.has(key)) {
      node = create(item, i);
      node.dataset.key = key;
    }
    seen.add(key);
    used.add(node);
    // Move the node into the correct position if it isn't already there.
    if (cursor === node) {
      cursor = node.nextSibling;
    } else {
      container.insertBefore(node, cursor);
    }
  });
  // Drop every leftover child (keyed or not — e.g. a prior empty-state node).
  for (const child of Array.from(container.children)) {
    if (!(child instanceof HTMLElement) || !used.has(child)) child.remove();
  }
}

/**
 * Show the day/night transition banner. Reflows to restart the CSS animation each call so
 * rapid transitions (e.g. a same-frame re-announce) replay cleanly.
 */
export function announce(label: string, n: number): void {
  const b = el("banner");
  el("banner-label").textContent = label;
  el("banner-n").textContent = String(n);
  b.classList.remove("show");
  void b.offsetWidth; // reflow to restart animation
  b.classList.add("show");
}
