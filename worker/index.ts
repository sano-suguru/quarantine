// worker/index.ts
// Worker entry for QUARANTINE. Routes /arena/:CODE WebSocket upgrades to the authoritative
// Arena Durable Object; everything else 404s (static assets are served by the [assets] block
// in wrangler.toml, which matches before this fetch runs). The old WebRTC signaling relay
// (Room/Registry DOs + TURN) was deleted in 2b-0 — method C is gone.
export { Arena } from "./arena";

export interface Env {
  // Authoritative game-arena DO (one arena = one DO, idFromName = room code).
  ARENA: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const arenaMatch = url.pathname.match(/^\/arena\/([^/]+)$/);
    if (arenaMatch) {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      // room codes are case-insensitive: normalize so "raid" and "RAID" hit one DO
      const code = decodeURIComponent(arenaMatch[1] as string).toUpperCase();
      return env.ARENA.get(env.ARENA.idFromName(code)).fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
};
