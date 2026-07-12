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

export { Arena } from "./arena";
// Re-export the registry DO so wrangler can bind it from this main module (see wrangler.toml).
export { Registry } from "./registry";

export interface Env {
  ROOM: DurableObjectNamespace;
  // Global public-room registry (quick-match / browser). Written only by Room DOs, read by GET /rooms.
  REGISTRY: DurableObjectNamespace;
  // Authoritative game-arena DO (sub-project 2a).
  ARENA: DurableObjectNamespace;
  // Cloudflare Realtime TURN key (set as Worker secrets; absent => /turn returns STUN-only).
  TURN_KEY_ID?: string;
  TURN_TOKEN?: string;
  // Hard budget cap. /turn refuses to mint creds once this month's TURN egress crosses the
  // threshold (default 800 GB, under the 1000 GB free tier) — so usage can't reach a charge.
  // Requires an "Account Analytics" API token; without it the cap can't be verified and /turn
  // fails CLOSED (no creds), which also forces the safety config to exist before TURN works.
  CF_ACCOUNT_ID?: string;
  CF_ANALYTICS_TOKEN?: string;
  TURN_BUDGET_GB?: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Mint short-lived ICE servers (incl. TURN/TURNS) for clients behind UDP-blocking / symmetric
    // NAT. The TURN key secret never leaves the Worker; clients only ever see ephemeral creds.
    if (url.pathname === "/turn" && req.method === "POST") return turnIceServers(req, env);
    // Public room list for the browser / quick-match. Read-only (the data is joinable-by-design),
    // so we only soft-guard against cross-site embedding; writes happen Room-DO→Registry, never here.
    if (url.pathname === "/rooms" && req.method === "GET") {
      if (req.headers.get("Sec-Fetch-Site") === "cross-site") return json({ rooms: [] }, 403);
      const reg = env.REGISTRY.get(env.REGISTRY.idFromName("global"));
      return reg.fetch("https://reg/list");
    }
    const arenaMatch = url.pathname.match(/^\/arena\/([^/]+)$/);
    if (arenaMatch) {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const code = decodeURIComponent(arenaMatch[1] as string).toUpperCase();
      return env.ARENA.get(env.ARENA.idFromName(code)).fetch(req);
    }
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

const DEFAULT_BUDGET_GB = 800; // stop well under the 1000 GB free tier

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

/**
 * Mint ephemeral ICE servers (incl. TURN/TURNS) from Cloudflare Realtime TURN. The TURN key
 * secret never leaves the Worker; clients only see short-lived creds. Returns `{ iceServers: [] }`
 * (graceful STUN-only fallback) when:
 *   - the request isn't same-origin (cheap anti-abuse on this public endpoint),
 *   - the TURN key isn't configured, or
 *   - the monthly budget guard says we're over (or CAN'T be verified — fail closed so usage can
 *     never reach a charge).
 */
async function turnIceServers(req: Request, env: Env): Promise<Response> {
  // Only our own page may mint creds. Same-origin POSTs always carry Origin; a missing/foreign
  // Origin (e.g. a scripted abuser) is refused. Not bulletproof, but raises the bar cheaply.
  if (req.headers.get("Origin") !== new URL(req.url).origin) return json({ iceServers: [] }, 403);
  if (!env.TURN_KEY_ID || !env.TURN_TOKEN) return json({ iceServers: [] });

  // Hard cap: only mint when usage is VERIFIED under budget. over===true (over budget) or
  // null (can't verify / guard unconfigured) both deny → no path to a charge.
  const over = await turnOverBudget(env);
  if (over !== false) {
    return json({ iceServers: [], reason: over ? "budget-reached" : "budget-guard-unconfigured" });
  }

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.TURN_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }), // 24h — comfortably outlives a play session
      },
    );
    if (!res.ok) return json({ iceServers: [] }, 200);
    return json(await res.json());
  } catch {
    return json({ iceServers: [] }, 200);
  }
}

/**
 * Is this month's TURN egress at/over the budget? Returns true/false, or null when it can't be
 * determined (no analytics token, or the query failed) — callers treat null as "deny" (fail
 * closed). The decision is cached per-colo for 15 min via the Cache API, so /turn stays fast and
 * we don't hammer the analytics API. NOTE: TURN analytics lag slightly and the cache adds ≤15 min,
 * so the cap reacts with up to ~an hour of lag — which the 200 GB buffer below the free tier
 * absorbs.
 */
async function turnOverBudget(env: Env): Promise<boolean | null> {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return null;
  const cacheKey = new Request("https://turn-budget.internal/decision");
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return ((await hit.json()) as { over: boolean }).over;

  const over = await queryTurnOverBudget(env);
  if (over !== null) {
    await cache.put(
      cacheKey,
      new Response(JSON.stringify({ over }), {
        headers: { "Cache-Control": "max-age=900", "Content-Type": "application/json" },
      }),
    );
  }
  return over;
}

/** Sum this calendar month's TURN egress via the GraphQL Analytics API; compare to the budget. */
async function queryTurnOverBudget(env: Env): Promise<boolean | null> {
  try {
    const now = new Date();
    const from = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const to = now.toISOString().slice(0, 10);
    const query =
      "query($a:String!,$f:Date!,$t:Date!){viewer{accounts(filter:{accountTag:$a})" +
      "{callsTurnUsageAdaptiveGroups(filter:{date_geq:$f,date_leq:$t},limit:1){sum{egressBytes}}}}}";
    const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, f: from, t: to } }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      errors?: unknown[];
      data?: {
        viewer?: {
          accounts?: { callsTurnUsageAdaptiveGroups?: { sum?: { egressBytes?: number } }[] }[];
        };
      };
    };
    // Fail CLOSED on a query we can't trust: GraphQL errors, or the expected shape missing (e.g.
    // schema drift / node rename). Returning a number here would silently disable the cap. An
    // empty `accounts[0].callsTurnUsageAdaptiveGroups` is a VALID zero-usage result, not drift.
    const accounts = data.data?.viewer?.accounts;
    if ((data.errors && data.errors.length > 0) || !accounts) return null;
    const bytes = accounts[0]?.callsTurnUsageAdaptiveGroups?.[0]?.sum?.egressBytes ?? 0;
    const limitGb = env.TURN_BUDGET_GB ? Number(env.TURN_BUDGET_GB) : DEFAULT_BUDGET_GB;
    return bytes >= limitGb * 1e9;
  } catch {
    return null;
  }
}

type Incoming =
  | { t: "offer"; to: number; code: string }
  | { t: "answer"; code: string }
  // host → relay: publish/refresh this room in the public registry (public=false unlists it).
  // Sent on the host's signaling socket, driven by the host's Worker-clock tick (not throttled
  // when backgrounded), so it doubles as the liveness heartbeat for the registry TTL.
  | { t: "meta"; public: boolean; phase: string; day: number; players?: number };

/** One room: a single host plus up to 3 clients. Pure offer/answer relay, in memory. */
export class Room {
  private host: WebSocket | null = null;
  private clients = new Map<number, { ws: WebSocket; v: number | null }>();
  private nextPeerId = 1;
  // a host has connected at some point this DO's lifetime. Lets a reconnecting client tell
  // "host left, session over" (hadHost && !host → nohost) from the legitimate startup race
  // where a client joins before the host arrives (!hadHost → wait for the retroactive join).
  private hadHost = false;
  // host's wire-protocol version (?v=). null = a pre-D host that doesn't advertise one.
  private hostV: number | null = null;
  // public-registry state (feature D), driven by host `meta` messages
  private code = "";
  private isPublic = false;
  private metaPhase = "lobby";
  private metaDay = 1;
  // authoritative player count from the host's meta (host + established clients). The DO can't
  // count established peers itself (clients close their signaling socket once P2P is up), so it
  // trusts the host. null until the first meta arrives → fall back to the socket count.
  private metaPlayers: number | null = null;

  constructor(
    _state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const role = url.searchParams.get("role");
    const vRaw = url.searchParams.get("v");
    const v = vRaw !== null && Number.isFinite(Number(vRaw)) ? Number(vRaw) : null;
    // remember our own room code (for the registry key); the Worker routes /room/CODE here
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (m) this.code = decodeURIComponent(m[1] as string).toUpperCase();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    if (role === "host") this.attachHost(server, v);
    else this.attachClient(server, v);
    return new Response(null, { status: 101, webSocket: client });
  }

  private send(ws: WebSocket, obj: unknown): void {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket may be mid-close */
    }
  }

  /** Incompatible only when BOTH sides advertise a version and they differ. A missing version
   *  (pre-D build) is allowed through — the D rollout doesn't change the wire format, and real
   *  future format changes gate v=N vs v=M once both peers advertise. */
  private versionConflict(clientV: number | null): boolean {
    return this.hostV !== null && clientV !== null && this.hostV !== clientV;
  }

  private attachHost(ws: WebSocket, v: number | null): void {
    if (this.host) {
      // a room has exactly one host; reject a second claim
      this.send(ws, { t: "error", reason: "host-exists" });
      ws.close();
      return;
    }
    this.host = ws;
    this.hostV = v;
    this.hadHost = true;
    // clients who joined before the host arrived: notify (or reject a version-mismatched one)
    for (const [peerId, c] of this.clients) {
      if (this.versionConflict(c.v)) {
        this.send(c.ws, { t: "versionMismatch" });
        try {
          c.ws.close();
        } catch {
          /* already closing */
        }
        this.clients.delete(peerId);
      } else {
        this.send(ws, { t: "join", peerId });
      }
    }
    ws.addEventListener("message", (e) => {
      const m = parse(e.data);
      if (m && m.t === "offer" && typeof m.to === "number") {
        const c = this.clients.get(m.to);
        if (c) this.send(c.ws, { t: "offer", code: m.code });
      } else if (m && m.t === "meta") {
        // host publishing/refreshing its public listing (also the registry liveness heartbeat)
        this.isPublic = !!m.public;
        this.metaPhase = typeof m.phase === "string" ? m.phase : "lobby";
        this.metaDay = typeof m.day === "number" ? m.day : 1;
        this.metaPlayers = typeof m.players === "number" ? m.players : null;
        void this.syncRegistry();
      }
    });
    ws.addEventListener("close", () => {
      this.host = null;
      this.hostV = null;
      this.isPublic = false;
      void this.syncRegistry(); // unlist immediately on a clean host exit
      // host gone = session over (method C): tell every client and reset the room
      for (const c of this.clients.values()) {
        this.send(c.ws, { t: "hostgone" });
        try {
          c.ws.close();
        } catch {
          /* already closing */
        }
      }
      this.clients.clear();
    });
  }

  /** Push this room's public listing to the global Registry (or remove it). Called on host meta,
   *  player-count change, and host close. Only Room DOs write the registry — never clients. */
  private async syncRegistry(): Promise<void> {
    const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("global"));
    try {
      if (this.isPublic && this.host) {
        const entry = {
          code: this.code,
          v: this.hostV,
          players: this.metaPlayers ?? 1 + this.clients.size, // host-reported (established peers); fallback to socket count
          max: 4,
          phase: this.metaPhase,
          day: this.metaDay,
          lastSeen: 0, // Registry stamps this
        };
        await reg.fetch("https://reg/register", { method: "POST", body: JSON.stringify(entry) });
      } else {
        await reg.fetch("https://reg/deregister", {
          method: "POST",
          body: JSON.stringify({ code: this.code }),
        });
      }
    } catch {
      /* registry unavailable → browser/quick-match degrade; code-based play is unaffected */
    }
  }

  private attachClient(ws: WebSocket, v: number | null): void {
    // a reconnecting client whose host has already left: tell it the session is over (terminal)
    // instead of letting it wait for an offer that will never come. Scoped to hadHost so the
    // client-before-host startup race still works (that client waits for the retroactive join).
    if (this.hadHost && !this.host) {
      this.send(ws, { t: "nohost" });
      ws.close();
      return;
    }
    // wire-version gate (host present): refuse a client on an incompatible build before P2P
    if (this.host && this.versionConflict(v)) {
      this.send(ws, { t: "versionMismatch" });
      ws.close();
      return;
    }
    if (this.clients.size >= 3) {
      this.send(ws, { t: "full" });
      ws.close();
      return;
    }
    const peerId = this.nextPeerId++;
    this.clients.set(peerId, { ws, v });
    if (this.host) this.send(this.host, { t: "join", peerId });
    void this.syncRegistry(); // player count changed
    ws.addEventListener("message", (e) => {
      const m = parse(e.data);
      if (m && m.t === "answer" && this.host) {
        this.send(this.host, { t: "answer", from: peerId, code: m.code });
      }
    });
    ws.addEventListener("close", () => {
      this.clients.delete(peerId);
      void this.syncRegistry(); // player count changed
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
