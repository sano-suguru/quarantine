/** Minimal contract the Arena WebSocket adapter implements (the client talks to the DO through it). */
export interface PeerLink {
  sendSnap(buf: ArrayBuffer): void;
  sendRel(obj: unknown): void;
  onSnap(cb: (buf: ArrayBuffer) => void): void;
  onRel(cb: (obj: unknown) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: () => void): void;
  close(): void;
}
