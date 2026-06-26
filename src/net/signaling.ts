import { CONFIG } from "../config";
import { PROTOCOL_VERSION } from "./net";
import { type PeerLink, createClientLink, createHostLink } from "./transport";

/**
 * Room-code auto-connect over a WebSocket signaling relay (see signaling/). This is a thin
 * layer over the manual-SDP transport: it carries the same offer/answer code strings, just
 * exchanged automatically through the relay instead of copy-paste. Non-trickle ICE means a
 * single offer and single answer per peer — no per-candidate chatter.
 *
 * Host = hub: one PeerLink per joining client (createHostLink each time). Client = spoke.
 */

type SignalMsg =
  | { t: "join"; peerId: number }
  | { t: "offer"; code: string }
  | { t: "answer"; from: number; code: string }
  | { t: "full" }
  | { t: "hostgone" }
  | { t: "nohost" } // reconnect: the room had a host but it's gone now → session over (terminal)
  | { t: "versionMismatch" } // host/client wire-protocol versions differ → can't play (terminal)
  | { t: "error"; reason?: string };

/** Outcome of a reconnect attempt (rejoinRoom). `open` = P2P re-established; the rest are
 *  why we couldn't: `nohost`/`hostgone`/`full` are terminal (stop), `timeout` is retryable. */
export type RejoinResult =
  | { status: "open"; link: PeerLink }
  | { status: "nohost" }
  | { status: "hostgone" }
  | { status: "full" }
  | { status: "versionMismatch" }
  | { status: "timeout" };

/**
 * ws:// for plain http (incl. localhost dev), wss:// when the page is served over https.
 * In the production single-Worker deploy the signaling relay is the page's *own origin*, so
 * derive the host from `location.host`; over http (localhost dev = `bun run signal`) fall back
 * to `CONFIG.net.signalUrl`. This removes any need to bake the deployed host into config.
 */
function roomUrl(code: string, role: "host" | "client"): string {
  const https = location.protocol === "https:";
  const scheme = https ? "wss" : "ws";
  const host = https ? location.host : CONFIG.net.signalUrl;
  // `v` lets the relay reject a host/client wire-version mismatch before P2P (see signaling/room.ts)
  return `${scheme}://${host}/room/${encodeURIComponent(code)}?role=${role}&v=${PROTOCOL_VERSION}`;
}

export interface HostRoom {
  close(): void;
  /** Publish/refresh this room in the public registry (public=false unlists it). Sent on the host
   *  signaling socket; drive it from the host's Worker-clock tick so it isn't throttled in a
   *  backgrounded tab and doubles as the registry liveness heartbeat. */
  setMeta(meta: { public: boolean; phase: string; day: number }): void;
}

/**
 * Open a room as host. For each client that joins, mint a fresh PeerLink, ship our offer
 * through the relay, and hand the link to `onPeer` (caller wires it into Host). `onState`
 * reports connection-count changes and errors (e.g. signaling unreachable).
 */
export function hostRoom(
  code: string,
  onPeer: (link: PeerLink, peerId: number) => void,
  onState: (s: { connected: number; error?: string }) => void,
): HostRoom {
  const ws = new WebSocket(roomUrl(code, "host"));
  const accepts = new Map<number, (answerCode: string) => Promise<void>>();
  let connected = 0;
  // latest public-listing meta; flushed the instant the socket opens so a public room registers
  // immediately (not after the first heartbeat tick), and re-sent on every setMeta thereafter.
  let lastMeta: { public: boolean; phase: string; day: number } | null = null;

  ws.addEventListener("open", () => {
    if (lastMeta) ws.send(JSON.stringify({ t: "meta", ...lastMeta }));
  });

  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data as string) as SignalMsg;
    if (m.t === "join") {
      void (async () => {
        const { link, offer, accept } = await createHostLink();
        accepts.set(m.peerId, accept);
        link.onOpen(() => {
          connected++;
          onState({ connected });
        });
        link.onClose(() => {
          connected = Math.max(0, connected - 1);
          accepts.delete(m.peerId);
          onState({ connected });
        });
        onPeer(link, m.peerId);
        ws.send(JSON.stringify({ t: "offer", to: m.peerId, code: offer }));
      })();
    } else if (m.t === "answer") {
      void accepts.get(m.from)?.(m.code);
    } else if (m.t === "versionMismatch") {
      // a joining client is on a different build than us; the relay refused to pair us
      onState({ connected, error: "a player tried to join on a different version" });
    } else if (m.t === "error") {
      onState({ connected, error: m.reason ?? "signal-error" });
    }
  });
  ws.addEventListener("error", () => onState({ connected, error: "unreachable" }));

  return {
    close() {
      ws.close();
    },
    setMeta(meta) {
      lastMeta = meta; // buffer so the "open" handler can flush it if the socket isn't up yet
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "meta", ...meta }));
    },
  };
}

/** Join a room as client: receive the host's offer, answer it, resolve with the PeerLink.
 *  The signaling socket closes itself once the P2P link is up (non-trickle = nothing more
 *  to exchange). Rejects on a full room, a missing host, or an unreachable relay. */
export function joinRoom(code: string): Promise<PeerLink> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(roomUrl(code, "client"));
    let settled = false;
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string) as SignalMsg;
      if (m.t === "offer") {
        void (async () => {
          const { link, answer } = await createClientLink(m.code);
          ws.send(JSON.stringify({ t: "answer", code: answer }));
          link.onOpen(() => ws.close()); // signaling no longer needed once P2P is up
          settled = true;
          resolve(link);
        })();
      } else if (m.t === "full") {
        reject(new Error("room is full"));
        ws.close();
      } else if (m.t === "versionMismatch") {
        reject(new Error("host is on a different version — update to play together"));
        ws.close();
      } else if (m.t === "hostgone") {
        if (!settled) reject(new Error("host left"));
      }
    });
    ws.addEventListener("error", () => {
      if (!settled) reject(new Error("signaling unreachable"));
    });
  });
}

/**
 * Reconnect a dropped client to the same room (P4). Unlike joinRoom (which resolves the instant
 * our answer is sent and throws on failure), this waits for the P2P link to actually OPEN before
 * reporting success, and returns a discriminated result so the caller can tell a terminal failure
 * (host gone → stop) from a retryable one (timeout → back off and try again). The host is still on
 * its signaling socket the whole session, so a live host answers our re-join with a fresh offer;
 * a dead room replies `nohost` (see signaling/room.ts).
 */
export function rejoinRoom(code: string): Promise<RejoinResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(roomUrl(code, "client"));
    let settled = false;
    const done = (r: RejoinResult): void => {
      if (settled) return;
      settled = true;
      try {
        if (r.status !== "open") ws.close(); // an `open` result closed the socket itself
      } catch {
        /* already closing */
      }
      resolve(r);
    };
    // per-attempt cap: if the link never opens (NAT/relay stall), report timeout → caller backs off
    const timer = setTimeout(() => done({ status: "timeout" }), CONFIG.net.p2pOpenTimeoutMs);
    const finish = (r: RejoinResult): void => {
      clearTimeout(timer);
      done(r);
    };
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data as string) as SignalMsg;
      if (m.t === "offer") {
        void (async () => {
          try {
            const { link, answer } = await createClientLink(m.code);
            ws.send(JSON.stringify({ t: "answer", code: answer }));
            link.onOpen(() => {
              ws.close(); // signaling no longer needed once P2P is up
              finish({ status: "open", link });
            });
          } catch {
            finish({ status: "timeout" });
          }
        })();
      } else if (m.t === "nohost") {
        finish({ status: "nohost" });
      } else if (m.t === "hostgone") {
        finish({ status: "hostgone" });
      } else if (m.t === "full") {
        finish({ status: "full" });
      } else if (m.t === "versionMismatch") {
        finish({ status: "versionMismatch" });
      }
    });
    ws.addEventListener("error", () => finish({ status: "timeout" }));
  });
}
