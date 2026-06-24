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
