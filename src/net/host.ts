import { addPlayer, removePlayer } from "../engine/players";
import { applyBuy, getState, shopDeploy, startNightNow } from "../game";
import type { NetMsg } from "./net";
import { encodeSnapshot } from "./snapshot";
import type { PeerLink } from "./transport";

/**
 * Host role: owns the authoritative sim and fans world snapshots out to every client.
 *
 * Players are NOT spawned the instant a peer connects — the host may still be in the
 * lobby (game not started, state about to be re-created by startGame). Instead each peer
 * gets a player id immediately (sent via Hello so the client knows which player is it),
 * and the player object is created in `start()` (Deploy) or, for late joiners after the
 * game is running, on connect. Inputs arrive on the reliable channel and drive that
 * player in the host's sim.
 */
export class Host {
  readonly links: PeerLink[] = [];
  private peers: { link: PeerLink; pid: number; open: boolean }[] = [];
  private started = false;
  private nextPid = 1; // host itself is player 0

  add(link: PeerLink): void {
    const pid = this.nextPid++;
    const peer = { link, pid, open: false };
    this.peers.push(peer);
    this.links.push(link);

    link.onOpen(() => {
      peer.open = true;
      const st = getState();
      const hello: NetMsg = { t: "hello", localId: pid, owned: st.owned, wlevel: st.wlevel };
      link.sendRel(hello);
      // late joiner (game already running) → spawn now; lobby joiner waits for start()
      if (this.started && !st.players.some((p) => p.id === pid)) {
        addPlayer(st, pid, 0, 80, `P${pid + 1}`);
      }
    });

    link.onRel((m) => {
      const msg = m as NetMsg;
      const st = getState();
      if (msg.t === "input") {
        const p = st.players.find((pl) => pl.id === pid);
        if (p) p.input = msg.input;
      } else if (msg.t === "buy") {
        // authoritative purchase routed to the requesting peer's player (wlevel/money
        // changes flow back to everyone via the snapshot — no extra broadcast needed)
        applyBuy(
          st,
          msg.itemId,
          st.players.find((pl) => pl.id === pid),
        );
      } else if (msg.t === "deploy") {
        shopDeploy(); // idempotent (no-op unless the shop is open)
      } else if (msg.t === "nightStart") {
        startNightNow(); // idempotent (no-op unless we're in the day phase)
      } else if (msg.t === "ping") {
        link.sendRel({ t: "pong", id: msg.id }); // RTT probe echo (see client netStats)
      }
    });

    link.onClose(() => {
      if (this.started) removePlayer(getState(), pid);
      this.peers = this.peers.filter((x) => x !== peer);
      const i = this.links.indexOf(link);
      if (i >= 0) this.links.splice(i, 1);
    });
  }

  /** Deploy: the host's fresh game state exists now — spawn a player for each connected peer. */
  start(): void {
    this.started = true;
    const st = getState();
    for (const peer of this.peers) {
      if (peer.open && !st.players.some((p) => p.id === peer.pid)) {
        addPlayer(st, peer.pid, 0, 80, `P${peer.pid + 1}`);
      }
    }
  }

  /** How many peers are currently connected (for the lobby squad display). */
  get connected(): number {
    return this.peers.filter((p) => p.open).length;
  }

  /** pids of currently-connected peers (for the lobby squad badges). */
  connectedPids(): number[] {
    return this.peers.filter((p) => p.open).map((p) => p.pid);
  }

  /** Broadcast the current world to all peers (called at CONFIG.net.sendHz after start). */
  broadcast(tick: number): void {
    if (this.links.length === 0) return;
    const buf = encodeSnapshot(getState(), tick);
    for (const l of this.links) l.sendSnap(buf);
  }

  /** Tell every client the run ended so they bank their salvage share + show the debrief. */
  broadcastGameOver(salvage: number, day: number, kills: number, money: number): void {
    const msg: NetMsg = { t: "gameover", salvage, day, kills, money };
    for (const l of this.links) l.sendRel(msg);
  }
}
