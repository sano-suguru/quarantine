export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const len = (x: number, y: number): number => Math.hypot(x, y);
