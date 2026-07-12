/** Minimal contract shared by the Arena WebSocket adapter and (removed) WebRTC PeerLink. */
export interface PeerLink {
  sendSnap(buf: ArrayBuffer): void;
  sendRel(obj: unknown): void;
  onSnap(cb: (buf: ArrayBuffer) => void): void;
  onRel(cb: (obj: unknown) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: () => void): void;
  close(): void;
}
