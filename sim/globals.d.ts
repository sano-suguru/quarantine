/**
 * Minimal ambient globals for the sim/ no-DOM boundary.
 *
 * `lib: ["ES2022"]` + `types: []` intentionally omits DOM and @types/node.
 * Only declare the exact members that sim/snapshot.ts actually calls — do NOT
 * add "dom" to lib or pull in @types/node.
 */

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  decode(input?: ArrayBufferView): string;
}

declare const console: {
  warn(...args: unknown[]): void;
};
