/**
 * Public room registry for quick-match / the room browser (feature D).
 *
 * A SINGLE global Durable Object (addressed by idFromName("global")) holding the live list of
 * public rooms in memory. Entries are written ONLY by Room DOs (server-to-server fetch) — never by
 * a client directly — so a room can only be listed by its actual host's signaling socket (no
 * third-party can publish someone else's private code). Read by the Worker's GET /rooms.
 *
 * Liveness: each register refreshes lastSeen; GET /rooms prunes entries older than TTL_MS. A clean
 * host exit deregisters immediately (Room DO host-close); a crash is caught by the TTL sweep. State
 * is in-memory only — if the DO evicts while idle the list is empty, which is correct (nobody is
 * playing); active rooms keep it warm via their periodic meta + the browser's polling.
 */

const TTL_MS = 45_000; // drop a room not refreshed within this (host crash without clean close)
const MAX_ROOMS = 200; // hard cap so a bug/abuse can't grow the list unbounded

export interface RoomEntry {
  code: string;
  v: number | null; // host wire-protocol version (client greys mismatches)
  players: number;
  max: number;
  phase: string; // "lobby" | "day" | "night"
  day: number;
  lastSeen: number;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export class Registry {
  private rooms = new Map<string, RoomEntry>();

  // biome-ignore lint/complexity/noUselessConstructor: DO classes are constructed with (state, env)
  constructor(_state: DurableObjectState, _env: unknown) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/register") {
      const e = (await req.json()) as RoomEntry;
      if (!e?.code) return json({ ok: false }, 400);
      if (this.rooms.size >= MAX_ROOMS && !this.rooms.has(e.code)) return json({ ok: false }, 429);
      this.rooms.set(e.code, { ...e, lastSeen: Date.now() });
      return json({ ok: true });
    }
    if (req.method === "POST" && url.pathname === "/deregister") {
      const { code } = (await req.json()) as { code?: string };
      if (code) this.rooms.delete(code);
      return json({ ok: true });
    }
    if (url.pathname === "/list") {
      const now = Date.now();
      const rooms: RoomEntry[] = [];
      for (const [code, e] of this.rooms) {
        if (now - e.lastSeen > TTL_MS) {
          this.rooms.delete(code); // prune on read (no free-running timer needed)
          continue;
        }
        rooms.push(e);
      }
      // most-populated first (matches the quick-match "fill rooms" intent); client re-sorts as it likes
      rooms.sort((a, b) => b.players - a.players);
      return json({ rooms });
    }
    return new Response("not found", { status: 404 });
  }
}
