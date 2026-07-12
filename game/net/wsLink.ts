// game/net/wsLink.ts
// A PeerLink-shaped adapter over one binary WebSocket to the Arena DO. Snapshots (binary) and
// reliable messages (JSON) are multiplexed behind a 1-byte tag (sim/net/wire), so client.ts's
// existing PeerLink call sites (sendSnap/sendRel/onSnap/onRel/onOpen/onClose/close) are unchanged.
import { frameRel, unframe } from "../../sim/net/wire";
import type { PeerLink } from "./link";

export function createArenaLink(url: string): PeerLink {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const snapCbs: ((buf: ArrayBuffer) => void)[] = [];
  const relCbs: ((obj: unknown) => void)[] = [];
  const openCbs: (() => void)[] = [];
  const closeCbs: (() => void)[] = [];
  let closed = false;
  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb();
  };
  ws.addEventListener("open", () => {
    for (const cb of openCbs) cb();
  });
  ws.addEventListener("close", fireClose);
  ws.addEventListener("error", fireClose);
  ws.addEventListener("message", (e) => {
    const u = unframe(e.data as ArrayBuffer);
    if (u.kind === "snap") for (const cb of snapCbs) cb(u.buf);
    else for (const cb of relCbs) cb(u.obj);
  });
  return {
    sendSnap() {
      /* client never sends snapshots (server→client only); no-op keeps the interface shape */
    },
    sendRel(obj) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frameRel(obj)); // guard mirrors transport.ts:178
    },
    onSnap(cb) {
      snapCbs.push(cb);
    },
    onRel(cb) {
      relCbs.push(cb);
    },
    onOpen(cb) {
      if (ws.readyState === WebSocket.OPEN) cb();
      else openCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
      if (closed) cb();
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}
