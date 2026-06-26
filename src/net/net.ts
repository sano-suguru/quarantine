import type { Client } from "./client";
import type { CoopEvent, HostEvent } from "./events";
import type { Host } from "./host";
import type { PlayerInput } from "./playerInput";

/** Which role this client is playing this session. */
export type NetMode = "single" | "host" | "client";

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
