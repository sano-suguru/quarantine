import type { PlayerInput } from "../../sim/playerInput";
import type { Client } from "./client";
import type { CoopEvent, HostEvent } from "./events";

/**
 * Wire-protocol version. The DO and every client MUST match or they desync silently (the snapshot
 * binary layout + NetMsg/CoopEvent shapes are not self-describing). The DO echoes its version in
 * the Hello; the client re-checks it after the arena WS opens and self-ejects on a mismatch
 * (see client.ts onVersionMismatch). There is no separate signaling/handshake layer.
 *
 * BUMP THIS whenever the wire format changes — `snapshot.ts` encode/decode, the `NetMsg`/`CoopEvent`
 * unions, or the Hello fields. The golden byte test in `snapshot.test.ts` fails on any encode change
 * to force a conscious bump (don't just silence it — bump here too).
 *
 * The constant itself lives in sim/net/protocol.ts (DO-importable) and is re-exported here.
 */
export { PROTOCOL_VERSION } from "../../sim/net/protocol";

/** Messages on the reliable channel (JSON). Snapshots go on the binary channel. */
export type NetMsg =
  | {
      t: "hello";
      localId: number;
      owned: Record<string, boolean>;
      /** per-player reconnect token: client stores {localId, nonce} and replays it on rejoin so
       *  the DO re-attaches to the same player slot. Optional for back-compat. */
      nonce?: string;
      /** the DO's PROTOCOL_VERSION: the client re-checks it after the arena WS opens to detect a
       *  wire-version mismatch after the arena WS opens. */
      v?: number;
      /** DO → client: true if this Hello re-attached the client's still-held body (rejoin within
       *  grace); false/absent = a fresh slot (initial join, or a rejoin after graceMs retired the
       *  body). Lets the client show a silent in-place resume vs a "respawned" note. Additive JSON. */
      resumed?: boolean;
    }
  | { t: "input"; input: PlayerInput; seq: number }
  | { t: "ping"; id: number } // client→DO RTT probe (rel channel); the DO echoes pong
  | { t: "pong"; id: number }
  | CoopEvent
  | HostEvent;

/** Session-wide networking state, read by the main loop. */
export const Net: {
  client: Client | null;
} = {
  client: null,
};
