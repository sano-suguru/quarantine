import { CONFIG } from "../config";
import { HOME_SPAWN } from "../data/map";
import { addPlayer, removePlayer } from "../engine/players";
import { applyBuy, getState, shopDeploy, startNightNow } from "../game";
import type { NetMsg } from "./net";
import { encodeSnapshot } from "./snapshot";
import type { PeerLink } from "./transport";

interface HostPeer {
  link: PeerLink;
  /** assigned player id (1..3). -1 until the client's first rel (join/rejoin) decides it. */
  pid: number;
  open: boolean;
  decided: boolean;
  /** reconnect token sent in Hello; the client replays it on rejoin to re-claim this slot. */
  nonce: string;
  /** when this peer's link dropped (performance.now); the body is held until +graceMs. 0 = live. */
  goneAt: number;
  /** fallback timer: if no first rel arrives shortly after open, treat the peer as a fresh join. */
  claimTimer: ReturnType<typeof setTimeout> | null;
}

let nonceSeq = 0;
function makeNonce(): string {
  // cooperative (not adversarial) — just needs to be unique enough to not collide across a session
  return `${(nonceSeq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Host role: owns the authoritative sim and fans world snapshots out to every client.
 *
 * Identity is decided from the client's FIRST reliable message after a P2P open (not on connect):
 *   - `join`   → a fresh peer; the host assigns a free slot (1..3) and a reconnect nonce.
 *   - `rejoin` → a reconnect; the host matches pid+nonce to the dropped player's still-held body
 *                and re-attaches the new link in place (no respawn, gear/hp/pos kept).
 * A dropped link does NOT remove the player immediately: the body is marked `absent` (inert) and
 * held for CONFIG.net.reconnect.graceMs so a quick reconnect re-attaches; past that it's removed
 * and a later rejoin becomes a fresh respawn. This is the listen-server reconnect (P4).
 */
export class Host {
  readonly links: PeerLink[] = [];
  private peers: HostPeer[] = [];
  private started = false;
  // when set, broadcasts are suppressed until this time (?netlog test hook to force snap starvation)
  private broadcastPausedUntil = 0;

  add(link: PeerLink): void {
    const peer: HostPeer = {
      link,
      pid: -1,
      open: false,
      decided: false,
      nonce: "",
      goneAt: 0,
      claimTimer: null,
    };
    this.peers.push(peer);
    this.links.push(link);

    link.onOpen(() => {
      peer.open = true;
      if (!this.started) {
        // lobby: no reconnect is possible before the game starts → decide a slot immediately
        // (the client's `join` first-rel then no-ops on the already-decided peer)
        this.decideFresh(peer);
      } else {
        // mid-game: wait for the client's first rel to tell a rejoin (re-attach a held body)
        // from a fresh join; fall back to fresh if it never arrives
        peer.claimTimer = setTimeout(
          () => this.decideFresh(peer),
          CONFIG.net.reconnect.rejoinClaimTimeoutMs,
        );
      }
    });

    link.onRel((m) => {
      if (!this.peers.includes(peer)) return; // stale link after a re-attach — ignore
      const msg = m as NetMsg;
      const st = getState();
      if (msg.t === "join" || msg.t === "rejoin") {
        if (peer.decided) return; // duplicate claim
        if (peer.claimTimer) clearTimeout(peer.claimTimer);
        peer.claimTimer = null;
        if (msg.t === "rejoin") this.tryRejoin(peer, msg.pid, msg.nonce);
        else this.decideFresh(peer);
        return;
      }
      if (!peer.decided) return; // gameplay messages before identity is decided are dropped
      if (msg.t === "input") {
        const p = st.players.find((pl) => pl.id === peer.pid);
        if (p) p.input = msg.input;
      } else if (msg.t === "buy") {
        applyBuy(
          st,
          msg.itemId,
          st.players.find((pl) => pl.id === peer.pid),
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
      if (peer.claimTimer) clearTimeout(peer.claimTimer);
      peer.claimTimer = null;
      if (!this.peers.includes(peer)) return; // already re-attached/untracked
      peer.open = false;
      const li = this.links.indexOf(link);
      if (li >= 0) this.links.splice(li, 1); // stop broadcasting to the dead link
      if (this.started && peer.decided) {
        const p = getState().players.find((pl) => pl.id === peer.pid);
        if (p) {
          // hold the body: inert + a grace clock. A rejoin within graceMs re-attaches in place;
          // tickGrace() removes it past graceMs.
          p.absent = true;
          peer.goneAt = performance.now();
        } else {
          this.peers = this.peers.filter((x) => x !== peer); // body already gone
        }
      } else {
        this.peers = this.peers.filter((x) => x !== peer); // pre-game / undecided drop
      }
    });
  }

  /** Assign a fresh slot + nonce, send Hello, and (if running) spawn the player. */
  private decideFresh(peer: HostPeer): void {
    if (peer.decided || !this.peers.includes(peer)) return;
    if (peer.claimTimer) clearTimeout(peer.claimTimer);
    peer.claimTimer = null;
    peer.pid = this.allocPid();
    peer.nonce = makeNonce();
    peer.decided = true;
    this.sendHello(peer);
    if (this.started) this.spawnFresh(peer.pid);
  }

  /** A reconnect claim: match pid+nonce to the held body and re-attach in place; else fresh. */
  private tryRejoin(peer: HostPeer, pid: number, nonce: string): void {
    const st = getState();
    const old = this.peers.find(
      (x) => x !== peer && x.decided && x.pid === pid && x.nonce === nonce,
    );
    const body = st.players.find((p) => p.id === pid);
    if (old && body) {
      // re-attach to the live (held) body — no respawn, gear/hp/pos preserved
      peer.pid = pid;
      peer.nonce = nonce; // stable identity for further reconnects
      peer.decided = true;
      peer.goneAt = 0;
      body.absent = false; // resume the body
      this.dropOld(old); // untrack + close the old link FIRST so its onClose no-ops
      this.sendHello(peer);
    } else {
      if (old) this.dropOld(old);
      this.decideFresh(peer); // grace expired / unknown token → fresh slot
    }
  }

  /** Untrack a superseded peer and close its (dead) link, guarded so its callbacks no-op. */
  private dropOld(old: HostPeer): void {
    if (old.claimTimer) clearTimeout(old.claimTimer);
    this.peers = this.peers.filter((x) => x !== old);
    const li = this.links.indexOf(old.link);
    if (li >= 0) this.links.splice(li, 1);
    try {
      old.link.close();
    } catch {
      /* already closing */
    }
  }

  private sendHello(peer: HostPeer): void {
    const st = getState();
    const hello: NetMsg = {
      t: "hello",
      localId: peer.pid,
      owned: st.owned,
      wlevel: st.wlevel,
      nonce: peer.nonce,
    };
    peer.link.sendRel(hello);
  }

  /** Lowest free player slot among decided peers (host is 0; clients 1..3). */
  private allocPid(): number {
    const used = new Set(this.peers.filter((p) => p.decided).map((p) => p.pid));
    for (let n = 1; n <= 3; n++) if (!used.has(n)) return n;
    return (Math.max(0, ...used) || 0) + 1; // shouldn't happen (room caps at 3 clients)
  }

  /** Spawn a fresh player for a slot: alive at HOME by day/shop; a downed spectator at night
   *  (revived at the next dawn by openShop) so a mid-night arrival matches the death/respawn feel. */
  private spawnFresh(pid: number): void {
    const st = getState();
    if (st.players.some((p) => p.id === pid)) return;
    const x = HOME_SPAWN.x + ((pid % 4) - 1.5) * 36;
    const p = addPlayer(st, pid, x, HOME_SPAWN.y, `P${pid + 1}`);
    if (st.phase === "night" && !st.inShop) p.hp = 0;
  }

  /** Deploy: the host's fresh game state exists now — spawn a player for each connected peer. */
  start(): void {
    this.started = true;
    for (const peer of this.peers) {
      if (peer.open && peer.decided) this.spawnFresh(peer.pid);
    }
  }

  /** Remove held bodies whose grace window has elapsed (called each host tick). */
  tickGrace(now: number): void {
    if (!this.started) return;
    const st = getState();
    const grace = CONFIG.net.reconnect.graceMs;
    for (const peer of [...this.peers]) {
      if (peer.open || !peer.decided || peer.goneAt === 0) continue;
      if (now - peer.goneAt > grace) {
        removePlayer(st, peer.pid);
        this.peers = this.peers.filter((x) => x !== peer);
      }
    }
  }

  /** How many peers are currently connected (for the lobby squad display). */
  get connected(): number {
    return this.peers.filter((p) => p.open).length;
  }

  /** pids of currently-connected, decided peers (for the lobby squad badges). */
  connectedPids(): number[] {
    return this.peers.filter((p) => p.open && p.decided).map((p) => p.pid);
  }

  /** ?netlog test hook: stop broadcasting for `ms` to force a client snapshot-starvation reconnect. */
  pauseBroadcast(ms: number): void {
    this.broadcastPausedUntil = performance.now() + ms;
  }

  /** Broadcast the current world to all peers (called at CONFIG.net.sendHz after start). */
  broadcast(tick: number): void {
    if (this.links.length === 0) return;
    if (performance.now() < this.broadcastPausedUntil) return;
    const buf = encodeSnapshot(getState(), tick);
    for (const l of this.links) l.sendSnap(buf);
  }

  /** Tell every client the run ended so they bank their salvage share + show the debrief. */
  broadcastGameOver(salvage: number, day: number, kills: number, money: number): void {
    const msg: NetMsg = { t: "gameover", salvage, day, kills, money };
    for (const l of this.links) l.sendRel(msg);
  }
}
