/**
 * Signaling relay for QUARANTINE co-op (room-code auto-connect).
 *
 * A Worker routes `/room/:CODE` WebSocket upgrades to a per-code Durable Object that
 * relays the WebRTC offer/answer between the host and each joining client (hub & spoke).
 * It holds NO game state and no persistent storage — just the live socket map, which
 * survives because this DO does NOT use WebSocket Hibernation (it stays resident while
 * its sockets are open). Once the P2P DataChannel is up, signaling is out of the loop.
 *
 * Free Workers plan: the DO class is SQLite-backed (see wrangler.toml migrations); we
 * just never touch storage.
 */

export interface Env {
  ROOM: DurableObjectNamespace;
  // Cloudflare Realtime TURN key (set as Worker secrets; absent => /turn returns STUN-only).
  TURN_KEY_ID?: string;
  TURN_TOKEN?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Mint short-lived ICE servers (incl. TURN/TURNS) for clients behind UDP-blocking / symmetric
    // NAT. The TURN key secret never leaves the Worker; clients only ever see ephemeral creds.
    if (url.pathname === "/turn" && req.method === "POST") return turnIceServers(env);
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!match) return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    // room codes are case-insensitive: normalize so "raid" and "RAID" hit one DO
    const code = decodeURIComponent(match[1] as string).toUpperCase();
    const id = env.ROOM.idFromName(code);
    return env.ROOM.get(id).fetch(req);
  },
};

/**
 * Ask Cloudflare Realtime TURN for a set of ephemeral ICE servers and relay them to the client.
 * Returns `{ iceServers: [] }` when the TURN key isn't configured, so the game falls back to
 * STUN-only without erroring. JSON shape matches RTCConfiguration.iceServers.
 */
async function turnIceServers(env: Env): Promise<Response> {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  if (!env.TURN_KEY_ID || !env.TURN_TOKEN) return json({ iceServers: [] });
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.TURN_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 86400 }), // 24h — comfortably outlives a play session
      },
    );
    if (!res.ok) return json({ iceServers: [] }, 200);
    return json(await res.json());
  } catch {
    return json({ iceServers: [] }, 200);
  }
}

type Incoming = { t: "offer"; to: number; code: string } | { t: "answer"; code: string };

/** One room: a single host plus up to 3 clients. Pure offer/answer relay, in memory. */
export class Room {
  private host: WebSocket | null = null;
  private clients = new Map<number, WebSocket>();
  private nextPeerId = 1;

  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get("role");
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    if (role === "host") this.attachHost(server);
    else this.attachClient(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket may be mid-close */
    }
  }

  private attachHost(ws: WebSocket): void {
    if (this.host) {
      // a room has exactly one host; reject a second claim
      this.send(ws, { t: "error", reason: "host-exists" });
      ws.close();
      return;
    }
    this.host = ws;
    // clients who joined before the host arrived get their join notice now (retroactive)
    for (const peerId of this.clients.keys()) this.send(ws, { t: "join", peerId });
    ws.addEventListener("message", (e) => {
      const m = parse(e.data);
      if (m && m.t === "offer" && typeof m.to === "number") {
        const c = this.clients.get(m.to);
        if (c) this.send(c, { t: "offer", code: m.code });
      }
    });
    ws.addEventListener("close", () => {
      this.host = null;
      // host gone = session over (method C): tell every client and reset the room
      for (const c of this.clients.values()) {
        this.send(c, { t: "hostgone" });
        try {
          c.close();
        } catch {
          /* already closing */
        }
      }
      this.clients.clear();
    });
  }

  private attachClient(ws: WebSocket): void {
    if (this.clients.size >= 3) {
      this.send(ws, { t: "full" });
      ws.close();
      return;
    }
    const peerId = this.nextPeerId++;
    this.clients.set(peerId, ws);
    if (this.host) this.send(this.host, { t: "join", peerId });
    ws.addEventListener("message", (e) => {
      const m = parse(e.data);
      if (m && m.t === "answer" && this.host) {
        this.send(this.host, { t: "answer", from: peerId, code: m.code });
      }
    });
    ws.addEventListener("close", () => {
      this.clients.delete(peerId);
      // the host learns of the drop via its RTC PeerLink onClose (removePlayer)
    });
  }
}

function parse(data: unknown): Incoming | null {
  try {
    return JSON.parse(data as string) as Incoming;
  } catch {
    return null;
  }
}
