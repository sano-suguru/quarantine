// Shared wire-protocol version. Lives in sim/ so the Arena DO can import it without
// pulling in game/ (which requires DOM/WebGL). game/net/net.ts re-exports it.
export const PROTOCOL_VERSION = 19;
