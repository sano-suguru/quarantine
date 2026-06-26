import type { Client } from "./client";
import type { CoopEvent, HostEvent } from "./events";
import type { Host } from "./host";
import type { PlayerInput } from "./playerInput";

/** Which role this client is playing this session. */
export type NetMode = "single" | "host" | "client";

/**
 * Co-op wire-protocol version. Host and client MUST match or they desync silently (the snapshot
 * binary layout + NetMsg/CoopEvent shapes are not self-describing). Sent on the signaling URL
 * (`&v=`) so a mismatch is rejected BEFORE P2P, and echoed in Hello so the manual-SDP path (which
 * bypasses signaling) re-checks after open.
 *
 * BUMP THIS whenever the wire format changes — `snapshot.ts` encode/decode, the `NetMsg`/`CoopEvent`
 * unions, or the Hello fields. The golden byte test in `snapshot.test.ts` fails on any encode change
 * to force a conscious bump (don't just silence it — bump here too).
 */
export const PROTOCOL_VERSION = 1;

/** Messages on the reliable channel (JSON). Snapshots go on the binary channel. */
export type NetMsg =
  | {
      t: "hello";
      localId: number;
      owned: Record<string, boolean>;
      wlevel: Record<string, number>;
      /** per-player reconnect token (P4): client stores {localId, nonce} and replays it on
       *  rejoin so the host re-attaches to the same player slot. Optional for back-compat. */
      nonce?: string;
      /** host's PROTOCOL_VERSION (D): lets the manual-SDP path — which bypasses the signaling
       *  version gate — detect a mismatch after the P2P link opens. */
      v?: number;
    }
  | { t: "input"; input: PlayerInput; seq: number }
  | { t: "ping"; id: number } // client→host RTT probe (rel channel); host echoes pong
  | { t: "pong"; id: number }
  | CoopEvent
  | HostEvent;

/** Session-wide networking state, read by the main loop to pick host/client/single paths. */
export const Net: {
  mode: NetMode;
  host: Host | null;
  client: Client | null;
} = {
  mode: "single",
  host: null,
  client: null,
};
