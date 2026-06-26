import { CONFIG } from "../config";
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
  | { t: "error"; reason?: string };

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
  return `${scheme}://${host}/room/${encodeURIComponent(code)}?role=${role}`;
}

export interface HostRoom {
  close(): void;
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
    } else if (m.t === "error") {
      onState({ connected, error: m.reason ?? "signal-error" });
    }
  });
  ws.addEventListener("error", () => onState({ connected, error: "unreachable" }));

  return {
    close() {
      ws.close();
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
      } else if (m.t === "hostgone") {
        if (!settled) reject(new Error("host left"));
      }
    });
    ws.addEventListener("error", () => {
      if (!settled) reject(new Error("signaling unreachable"));
    });
  });
}
