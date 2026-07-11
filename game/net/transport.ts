/**
 * WebRTC transport for co-op (manual SDP, one host ↔ one client).
 *
 * Each connection is a `PeerLink` = one RTCPeerConnection with TWO data channels:
 *   - "snap": unreliable/unordered ({maxRetransmits:0}) — latest-wins world snapshots
 *   - "rel" : reliable/ordered — input, hello, and (later) lobby/flow events
 *
 * Signaling here is manual copy-paste of a single SDP "code" per side. We use
 * NON-TRICKLE ICE (wait for gathering to finish) so the one code we hand the user
 * already contains every candidate — otherwise the paste connects to nothing.
 */

import { CONFIG } from "../../sim/config";

type Role = "host" | "client";

/* ------------------------------ ICE diagnostics ------------------------------ */
// Opt-in netcode tracing for debugging cross-network connects. Gated so we never spill ICE
// candidates (local/public IPs) to ordinary visitors: enable with `?netlog` in the URL or
// `localStorage.netlog="1"`. Co-op only — single-player never builds a PeerLink, so this is dead
// code in SP. Strip / leave gated once a connection issue is resolved.
export const NETLOG = (() => {
  try {
    return (
      (typeof location !== "undefined" && location.search.includes("netlog")) ||
      (typeof localStorage !== "undefined" && localStorage.getItem("netlog") === "1")
    );
  } catch {
    return false;
  }
})();

function nlog(role: Role, ...args: unknown[]): void {
  if (NETLOG) console.info(`[net ${role}]`, ...args);
}

/** Attach state/candidate listeners that reveal WHY a P2P connect succeeds or stalls. */
function wireDiag(pc: RTCPeerConnection, role: Role): void {
  if (!NETLOG) return;
  pc.addEventListener("iceconnectionstatechange", () =>
    nlog(role, "iceConnectionState", pc.iceConnectionState),
  );
  pc.addEventListener("connectionstatechange", () => {
    nlog(role, "connectionState", pc.connectionState);
    if (pc.connectionState === "connected") void logSelectedPair(pc, role);
  });
  pc.addEventListener("icegatheringstatechange", () =>
    nlog(role, "iceGatheringState", pc.iceGatheringState),
  );
  pc.addEventListener("icecandidate", (e) => {
    const c = e.candidate;
    // log TYPE/PROTOCOL only (no address): srflx => STUN reached; relay => TURN; host-only =>
    // STUN/UDP likely blocked. Absence of srflx across both peers is the smoking gun.
    if (c) nlog(role, "cand", c.type, c.protocol ?? "");
    else nlog(role, "cand gathering finished");
  });
  pc.addEventListener("icecandidateerror", (e) => {
    nlog(role, "candErr", `code=${e.errorCode}`, e.url ?? "", e.errorText ?? "");
  });
}

/** After connect, report which candidate pair won — host/srflx/relay tells us if TURN was needed. */
async function logSelectedPair(pc: RTCPeerConnection, role: Role): Promise<void> {
  try {
    const stats = await pc.getStats();
    for (const r of stats.values()) {
      const pair = r as {
        type: string;
        nominated?: boolean;
        state?: string;
        localCandidateId?: string;
        remoteCandidateId?: string;
      };
      if (pair.type === "candidate-pair" && pair.nominated && pair.state === "succeeded") {
        const l = stats.get(pair.localCandidateId ?? "") as
          | { candidateType?: string; protocol?: string }
          | undefined;
        const rm = stats.get(pair.remoteCandidateId ?? "") as
          | { candidateType?: string; protocol?: string }
          | undefined;
        nlog(
          role,
          "SELECTED PAIR",
          `local=${l?.candidateType}/${l?.protocol}`,
          `remote=${rm?.candidateType}/${rm?.protocol}`,
        );
      }
    }
  } catch (err) {
    nlog(role, "getStats failed", err);
  }
}

export interface PeerLink {
  sendSnap(buf: ArrayBuffer): void;
  sendRel(obj: unknown): void;
  onSnap(cb: (buf: ArrayBuffer) => void): void;
  onRel(cb: (obj: unknown) => void): void;
  onOpen(cb: () => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/**
 * Build a PeerLink whose data channels may arrive LATER. The host creates its channels
 * up front and attaches them immediately; the client only receives channels via
 * `ondatachannel` AFTER the connection establishes — which can't happen until the host
 * has the client's answer. So callbacks are stored in arrays and dispatched once a
 * channel is attached, letting the client return its answer code without waiting on a
 * connection that is itself waiting on that answer (the earlier deadlock).
 */
function createLinkState(
  pc: RTCPeerConnection,
  role: Role,
): {
  link: PeerLink;
  attach: (ch: RTCDataChannel) => void;
} {
  let snap: RTCDataChannel | null = null;
  let rel: RTCDataChannel | null = null;
  let opened = false;
  let closed = false;
  let gotSnap = false;
  let gotRel = false;
  const snapCbs: ((buf: ArrayBuffer) => void)[] = [];
  const relCbs: ((obj: unknown) => void)[] = [];
  const openCbs: (() => void)[] = [];
  const closeCbs: (() => void)[] = [];

  const fireOpen = (): void => {
    if (!opened && snap?.readyState === "open" && rel?.readyState === "open") {
      opened = true;
      for (const cb of openCbs) cb();
    }
  };
  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb();
  };
  pc.addEventListener("connectionstatechange", () => {
    const s = pc.connectionState;
    if (s === "failed" || s === "closed" || s === "disconnected") fireClose();
  });

  const attach = (ch: RTCDataChannel): void => {
    if (ch.label === "snap") {
      snap = ch;
      ch.binaryType = "arraybuffer";
      ch.addEventListener("message", (e) => {
        if (!gotSnap) {
          gotSnap = true;
          nlog(role, "first SNAP received"); // client leaves the lobby on this
        }
        for (const cb of snapCbs) cb(e.data as ArrayBuffer);
      });
    } else if (ch.label === "rel") {
      rel = ch;
      ch.addEventListener("message", (e) => {
        if (!gotRel) {
          gotRel = true;
          nlog(role, "first REL received"); // hello arrives here; if REL but no SNAP => snap drop
        }
        const obj = JSON.parse(e.data as string);
        for (const cb of relCbs) cb(obj);
      });
      ch.addEventListener("close", fireClose);
    }
    ch.addEventListener("open", () => {
      nlog(role, `channel "${ch.label}" open`);
      fireOpen();
    });
    fireOpen();
  };

  const link: PeerLink = {
    sendSnap(buf) {
      if (snap?.readyState === "open") snap.send(buf);
    },
    sendRel(obj) {
      if (rel?.readyState === "open") rel.send(JSON.stringify(obj));
    },
    onSnap(cb) {
      snapCbs.push(cb);
    },
    onRel(cb) {
      relCbs.push(cb);
    },
    onOpen(cb) {
      openCbs.push(cb);
      if (opened) cb();
    },
    onClose(cb) {
      closeCbs.push(cb);
      if (closed) cb();
    },
    close() {
      pc.close();
    },
  };
  return { link, attach };
}

/** True if any of these ICE servers is a TURN relay (turn:/turns:). */
function iceHasTurn(servers: RTCIceServer[]): boolean {
  return servers.some((s) => {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    return urls.some((u) => u.startsWith("turn:") || u.startsWith("turns:"));
  });
}

/**
 * Resolve ICE servers for a new PeerConnection: static STUN (CONFIG) plus, in the production
 * (https) deploy, ephemeral TURN creds minted by the signaling Worker's `/turn` route (covers
 * UDP-blocked / symmetric-NAT peers — incl. TURNS over 443). Cached per session; falls back to
 * STUN-only when `/turn` is unavailable (dev, or TURN key not configured) so STUN-reachable peers
 * still connect.
 */
/**
 * Whether relay (TURN) is usable this session, derived from the `/turn` response (D). Surfaced so
 * the UI can explain a cross-NAT connect failure when the monthly TURN budget is exhausted instead
 * of failing silently. Pure so it's unit-testable; defaults to "stun-only" for every non-available,
 * non-budget case (TURN key unset, 403, fetch error, dev/http where /turn isn't called).
 */
export type TurnStatus = "available" | "budget-reached" | "stun-only";
export function turnStatusOf(
  ok: boolean,
  iceServers: RTCIceServer[] | undefined,
  reason: string | undefined,
): TurnStatus {
  if (ok && Array.isArray(iceServers) && iceServers.length > 0) return "available";
  if (reason === "budget-reached") return "budget-reached"; // /turn fail-closed at the monthly cap
  return "stun-only";
}

let turnStatus: TurnStatus = "stun-only";
/** Latest known relay status (see TurnStatus). Set once per session when resolveIceServers runs. */
export function getTurnStatus(): TurnStatus {
  return turnStatus;
}

let cachedIce: RTCIceServer[] | null = null;
async function resolveIceServers(): Promise<RTCIceServer[]> {
  if (cachedIce) return cachedIce;
  // CONFIG.net.iceServers is typed structurally (IceServerConfig) so config.ts stays DOM-free;
  // assert it still satisfies the real DOM RTCIceServer here, where DOM lib is available.
  const base = CONFIG.net.iceServers satisfies RTCIceServer[];
  try {
    if (typeof location !== "undefined" && location.protocol === "https:") {
      const res = await fetch("/turn", { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { iceServers?: RTCIceServer[]; reason?: string };
        turnStatus = turnStatusOf(true, data.iceServers, data.reason);
        if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
          cachedIce = [...base, ...data.iceServers];
          nlog("client", "TURN creds fetched", `${data.iceServers.length} server group(s)`);
          return cachedIce;
        }
      } else {
        turnStatus = "stun-only"; // e.g. same-origin 403 — no trustworthy body to read
      }
      nlog("client", "no TURN creds (/turn empty or unavailable) — STUN only", turnStatus);
    }
  } catch {
    /* fall back to STUN-only (turnStatus stays its default) */
  }
  cachedIce = base;
  return cachedIce;
}

/**
 * Resolve once ICE gathering can produce a CONNECTABLE SDP. Non-trickle ICE bakes whatever
 * candidates exist *now* into the one code we ship, so resolving too early loses slow candidates
 * forever (the old flat 3 s truncated srflx/relay on restrictive links → guaranteed cross-NAT
 * failure). Rules:
 *   - resolve immediately when gathering reaches "complete";
 *   - STUN-only: once a reflexive (srflx) candidate arrives, wait a short grace for siblings then
 *     go (keeps the common case fast without truncating before any srflx exists);
 *   - TURN configured: do NOT early-resolve on srflx — relay candidates gather slower and we need
 *     one, so wait for "complete" up to the hard cap (the cap must out-wait TURN allocation);
 *   - hard cap backstops a server that never answers.
 */
function waitIceComplete(pc: RTCPeerConnection, role: Role, wantRelay: boolean): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let graceSet = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (why: string): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      pc.removeEventListener("icegatheringstatechange", onState);
      pc.removeEventListener("icecandidate", onCand);
      nlog(role, "iceComplete via", why);
      resolve();
    };
    const onState = (): void => {
      if (pc.iceGatheringState === "complete") finish("complete");
    };
    const onCand = (e: RTCPeerConnectionIceEvent): void => {
      const c = e.candidate;
      if (graceSet || !c) return;
      // We have a usable path once the candidate type we actually need has arrived: a reflexive
      // candidate for STUN-only, or a relay candidate when TURN is configured. Early-resolve after
      // a short grace (lets sibling candidates land) instead of blocking on `complete`/the hard cap
      // — which can sit the full timeout when a transport or DNS lookup stalls (the cross-network
      // case hit `iceComplete via hard cap` = ~8 s/peer before this).
      const usable = wantRelay ? c.type === "relay" : c.type === "srflx";
      if (usable) {
        graceSet = true;
        timers.push(setTimeout(() => finish("candidate grace"), CONFIG.net.iceGatherGraceMs));
      }
    };
    pc.addEventListener("icegatheringstatechange", onState);
    pc.addEventListener("icecandidate", onCand);
    timers.push(setTimeout(() => finish("hard cap"), CONFIG.net.iceGatherMaxMs));
  });
}

/** Host side: create the offer code; later feed the client's answer code back in. */
export async function createHostLink(): Promise<{
  link: PeerLink;
  offer: string;
  accept: (answerCode: string) => Promise<void>;
}> {
  const servers = await resolveIceServers();
  const pc = new RTCPeerConnection({ iceServers: servers });
  wireDiag(pc, "host");
  const { link, attach } = createLinkState(pc, "host");
  // host creates the channels up front and attaches them immediately
  attach(pc.createDataChannel("snap", { ordered: false, maxRetransmits: 0 }));
  attach(pc.createDataChannel("rel", { ordered: true }));
  await pc.setLocalDescription(await pc.createOffer());
  await waitIceComplete(pc, "host", iceHasTurn(servers));
  const offer = await encodeSDP(pc.localDescription as RTCSessionDescription);
  const accept = async (answerCode: string): Promise<void> => {
    await pc.setRemoteDescription(await decodeSDP(answerCode));
  };
  return { link, offer, accept };
}

/** Client side: consume the host's offer code, produce the answer code to send back. */
export async function createClientLink(
  offerCode: string,
): Promise<{ link: PeerLink; answer: string }> {
  const servers = await resolveIceServers();
  const pc = new RTCPeerConnection({ iceServers: servers });
  wireDiag(pc, "client");
  const { link, attach } = createLinkState(pc, "client");
  // client's channels arrive only after the connection is up (i.e. after the host
  // applies our answer) — attach them whenever they show up, don't block on them here
  pc.addEventListener("datachannel", (e) => attach(e.channel));
  await pc.setRemoteDescription(await decodeSDP(offerCode));
  await pc.setLocalDescription(await pc.createAnswer());
  await waitIceComplete(pc, "client", iceHasTurn(servers));
  const answer = await encodeSDP(pc.localDescription as RTCSessionDescription);
  return { link, answer }; // return immediately; channels bind on connect
}

/* ---------------------------- SDP code (de)compress --------------------------- */
// JSON → (deflate if available) → base64, with a 1-char scheme prefix. Keeps the
// pasteable code short; falls back to plain base64 when CompressionStream is absent.

async function encodeSDP(desc: RTCSessionDescription): Promise<string> {
  const json = JSON.stringify({ t: desc.type, s: desc.sdp });
  const bytes = new TextEncoder().encode(json);
  const cs = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (cs) {
    const packed = await streamBytes(new cs("deflate-raw"), bytes);
    return `1${bytesToB64(packed)}`;
  }
  return `0${bytesToB64(bytes)}`;
}

async function decodeSDP(code: string): Promise<RTCSessionDescriptionInit> {
  const scheme = code[0];
  const bytes = b64ToBytes(code.slice(1));
  let json: string;
  const ds = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (scheme === "1" && ds) {
    json = new TextDecoder().decode(await streamBytes(new ds("deflate-raw"), bytes));
  } else {
    json = new TextDecoder().decode(bytes);
  }
  const o = JSON.parse(json) as { t: RTCSdpType; s: string };
  return { type: o.t, sdp: o.s };
}

async function streamBytes(
  transform: CompressionStream | DecompressionStream,
  input: Uint8Array,
): Promise<Uint8Array> {
  // CompressionStream's writable is typed WritableStream<BufferSource>; the cast lets
  // pipeThrough accept it (runtime is fine — it consumes our Uint8Array chunk).
  const pair = transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(pair);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] as number);
  return btoa(s);
}

function b64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
