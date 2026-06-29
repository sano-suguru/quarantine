import { PROTOCOL_VERSION } from "./net";

/**
 * Client side of the public-room registry (feature D). Reads the live room list for the browser /
 * quick-match. Registration is host→relay→registry (over the signaling socket), never a direct
 * client write — so this module is read + selection logic only. The pure helpers are unit-tested.
 */

export interface RoomInfo {
  code: string;
  /** host wire-protocol version; null = a pre-D host (allowed — the rollout didn't change format) */
  v: number | null;
  players: number;
  max: number;
  phase: string; // "lobby" | "day" | "night"
  day: number;
  lastSeen: number;
}

// Always same-origin: the one Worker serves the game + /rooms in production, and `bun run dev:coop`
// proxies /rooms → the signaling Worker (see vite.config.ts). Relative so no CORS is ever needed —
// mirrors how transport.ts fetches "/turn". (WebSocket signaling still uses CONFIG.net.signalUrl.)
const ROOMS_URL = "/rooms";

/** Fetch the public room list. Throws on failure so callers can degrade (disable browser / QM). */
export async function listRooms(): Promise<RoomInfo[]> {
  const res = await fetch(ROOMS_URL);
  if (!res.ok) throw new Error("rooms unavailable");
  const data = (await res.json()) as { rooms?: RoomInfo[] };
  return data.rooms ?? [];
}

/** Can we actually play with this host's build? null version = pre-D host (format unchanged → ok). */
export function versionMatches(r: RoomInfo): boolean {
  return r.v == null || r.v === PROTOCOL_VERSION;
}

/** True if the room can still be joined (compatible build + a free slot). */
export function isJoinable(r: RoomInfo): boolean {
  return versionMatches(r) && r.players < r.max;
}

/**
 * Rank joinable rooms for quick-match: immediately-playable (LOBBY/DAY) before NIGHT (which drops
 * the joiner into spectate until dawn), and within a tier fuller-first (fill rooms over scatter).
 * The caller randomizes among the top few to avoid every quick-matcher piling into one room.
 */
export function selectQuickMatch(rooms: RoomInfo[]): RoomInfo[] {
  const rank = (r: RoomInfo): number => (r.phase === "night" ? 1 : 0);
  return rooms.filter(isJoinable).sort((a, b) => rank(a) - rank(b) || b.players - a.players);
}
