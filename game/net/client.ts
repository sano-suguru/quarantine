import { CONFIG } from "../../sim/config";
import { effWeapon } from "../../sim/data/arsenal";
import { DEPLOYABLE_TYPES } from "../../sim/data/deployables";
import { ENEMY_TYPES } from "../../sim/data/enemies";
import { segMid } from "../../sim/engine/geometry";
import { approach, rand } from "../../sim/engine/math";
import { localPlayer } from "../../sim/engine/players";
import { applySnapshot, decode, lerpSnapshots, type Snapshot } from "../../sim/snapshot";
import { applyFireFeel } from "../../sim/systems/feel";
import {
  fxActionBurst,
  fxHurt,
  fxImpact,
  fxKill,
  fxMote,
  goreIntensity,
} from "../../sim/systems/fx";
import { integrateMovement } from "../../sim/systems/player";
import type { Bullet } from "../../sim/types";
import { Audio } from "../engine/audio";
import { drainFxEvents } from "../fx-drain";
import { clientApplyHello, clientGameOver, getState, startClientGame } from "../game";
import { advanceGhosts } from "./ghost";
import { type NetMsg, PROTOCOL_VERSION } from "./net";
import type { PlayerInput } from "./playerInput";
import type { PeerLink } from "./transport";

type RGB = [number, number, number];
const GREY: RGB = [0.5, 0.5, 0.5];

/**
 * Client role: runs NO authoritative sim. It samples local input, ships it to the host,
 * and renders the world from buffered snapshots. The game screen appears on the FIRST
 * snapshot (once the host presses Deploy); Hello (our id + ownership) is applied then.
 *
 * Remote entities interpolate at `now - interpDelay` (no 30Hz stepping).
 * The LOCAL player is client-predicted: we integrate our own movement every
 * frame (instant response) and gently reconcile toward the host's authoritative position
 * on each snapshot (hard-snap only on large error). aim is fully local. Other local-player
 * fields (hp/ammo/…) come from the snapshot so the HUD stays correct.
 */
export class Client {
  private seq = 0;
  private started = false;
  private hello: {
    localId: number;
    owned: Record<string, boolean>;
  } | null = null;
  private buf: { snap: Snapshot; at: number }[] = [];
  private prev: Snapshot | null = null; // last snapshot, for combat-fx diffing
  // local-player predictor
  private predX = 0;
  private predY = 0;
  private predInit = false;
  // local fire-feedback predictor: muzzle/audio/recoil/shake fire instantly;
  // the actual bullet + damage stay host-authoritative (arrives via snapshot).
  private fireCdLocal = 0;
  private firedThisHoldLocal = false;
  // local-player FEEL is predicted too (like position): we own recoil/muzzle frame-to-frame and
  // re-impose them over each snapshot, so our own swing/kick stays smooth instead of stuttering
  // at snapshot rate and never pops against the authoritative value.
  private predRecoilX = 0;
  private predRecoilY = 0;
  private predMuzzle = 0;
  // visual-only predicted tracers (negative id) so the shot's bullet line shows instantly
  // instead of ~interpDelay late; the real bullet/damage stay host-authoritative.
  private ghosts: Bullet[] = [];
  private ghostId = -1;
  // net diagnostics (surfaced by the ?netlog HUD): rel-channel ping/pong RTT + snapshot jitter.
  private rttMs = 0;
  private pingId = 0;
  private pingSent = new Map<number, number>();
  private pingAcc = 0;
  private lastTick = -1; // highest snapshot tick applied (drops stale/reordered snaps)
  private reorders = 0; // count of dropped out-of-order snaps
  private gaps: number[] = []; // recent missed-tick counts between accepted snaps (rolling loss %)
  private freezeFrames = 0; // frames where the render time outran the newest snapshot
  private totalFrames = 0;
  // reconnect (P4): `live` gates send/render/callbacks while suspended between links;
  // lastSnapAt/lastRelAt drive the main-loop starvation watchdog (a true drop = BOTH go quiet).
  private live = true;
  private disposed = false;
  private lastSnapAt = 0;
  private lastRelAt = 0;

  constructor(
    private link: PeerLink,
    private onStart?: () => void,
    private hooks: {
      /** persist our reconnect identity (localId + nonce from Hello) so rebind can replay it */
      onIdentity?: (pid: number, nonce: string) => void;
      /** token to claim on the next P2P open: rejoin (reconnect) vs a fresh join */
      rejoin?: { pid: number; nonce: string } | null;
      /** host runs an incompatible wire version (manual-SDP path; signaling gates the rest) */
      onVersionMismatch?: () => void;
      /** the room is full (host + 3): stop and surface a terminal "room is full" to the lobby */
      onRoomFull?: () => void;
    } = {},
  ) {
    this.wire(link);
  }

  /** Wire snapshot/rel/open handlers onto `link`. Called for the initial link and again by
   *  rebind() on a reconnected link — so a dropped client resumes the SAME Client instance
   *  (never re-running the destructive startClientGame). */
  private wire(link: PeerLink): void {
    link.onRel((m) => {
      if (!this.live) return;
      this.lastRelAt = performance.now();
      const msg = m as NetMsg;
      if (msg.t === "hello") {
        // wire-version gate for the manual-SDP path (signaling gates room-code / quick-match);
        // mismatch → stop before showing the game, surface a clear error
        if (msg.v !== undefined && msg.v !== PROTOCOL_VERSION) {
          this.live = false;
          this.hooks.onVersionMismatch?.();
          return;
        }
        this.hello = { localId: msg.localId, owned: msg.owned };
        this.hooks.onIdentity?.(msg.localId, msg.nonce ?? "");
        if (this.started) clientApplyHello(msg.localId, msg.owned);
      } else if (msg.t === "gameover") {
        clientGameOver(msg.salvage, msg.day, msg.kills, msg.money);
      } else if (msg.t === "roomfull") {
        // host turned us away (room at capacity). Stop net activity and tear down our own link
        // — the host deliberately did NOT close it (so this rel wasn't dropped from the buffer).
        this.live = false;
        this.hooks.onRoomFull?.();
        try {
          this.link.close();
        } catch {
          /* already closing */
        }
      } else if (msg.t === "pong") {
        const sent = this.pingSent.get(msg.id);
        if (sent !== undefined) {
          this.pingSent.delete(msg.id);
          const rtt = performance.now() - sent;
          this.rttMs = this.rttMs ? this.rttMs * 0.7 + rtt * 0.3 : rtt; // EWMA
        }
      }
    });
    link.onSnap((b) => {
      if (!this.live) return;
      if (this.started && !getState().running) return; // run ended: stop fx/audio behind the debrief
      const snap = decode(b);
      // unreliable/unordered channel: drop a stale/reordered snapshot so interpolation never runs
      // backwards and prev→next fx-diffing doesn't misfire on an older frame.
      if (snap.tick <= this.lastTick) {
        this.reorders++;
        return;
      }
      if (this.lastTick >= 0) {
        this.gaps.push(snap.tick - this.lastTick - 1); // missed ticks since the last accepted snap
        if (this.gaps.length > 40) this.gaps.shift();
      }
      this.lastTick = snap.tick;
      this.lastSnapAt = performance.now();
      if (!this.started) {
        startClientGame(); // host has deployed — leave the lobby, show the game
        this.started = true;
        if (this.hello) clientApplyHello(this.hello.localId, this.hello.owned);
        this.onStart?.();
      }
      this.buf.push({ snap, at: performance.now() });
      if (this.buf.length > 8) this.buf.shift();
      this.reconcile(snap);
      if (this.prev) this.effects(this.prev, snap);
      this.prev = snap;
    });
    // every P2P open, claim our identity so the host can re-attach (rejoin) or assign a slot (join)
    link.onOpen(() => {
      const r = this.hooks.rejoin;
      link.sendRel(r ? { t: "rejoin", pid: r.pid, nonce: r.nonce } : { t: "join" });
    });
  }

  /**
   * Terminal teardown: close the current link and mark the client dead. Idempotent — safe to call
   * from endCoop() regardless of whether we ever opened. Unlike suspend() (reconnect: keeps the
   * instance alive to rebind), dispose() ends this Client for good.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.live = false;
    try {
      this.link.close();
    } catch {
      /* link already closing/closed — teardown must not throw */
    }
  }

  /** Pause all net activity (send/render/callbacks) and drop stale prediction/buffers while the
   *  reconnect loop runs. Closes the dead link so its callbacks can't fire on the shared instance. */
  suspend(): void {
    this.live = false;
    try {
      this.link.close();
    } catch {
      /* already closing */
    }
    this.resetNet();
  }

  /** Reconnected: bind to the new link, replay our identity token on open, resume. Keeps
   *  `started`/`seq`/`hello` so the running game view continues; only the transport is swapped. */
  rebind(link: PeerLink, rejoin: { pid: number; nonce: string } | null): void {
    this.link = link;
    this.hooks.rejoin = rejoin;
    this.resetNet();
    // fresh activity stamps so the watchdog gives the new link time before re-triggering
    const now = performance.now();
    this.lastSnapAt = now;
    this.lastRelAt = now;
    this.live = true;
    this.wire(link);
  }

  /** Clear per-link prediction/interp buffers (kept across a reconnect would replay stale state:
   *  a phantom kill burst from prev→next diffing, or easing the predicted body across the map). */
  private resetNet(): void {
    this.buf = [];
    this.prev = null;
    this.ghosts = [];
    this.predInit = false;
    this.lastTick = -1;
    this.firedThisHoldLocal = false;
    this.fireCdLocal = 0;
    this.pingSent.clear();
  }

  /** Most-recent activity on EITHER channel. The watchdog reconnects only when both have been
   *  silent (no snap AND no pong) — a snap-only stall is a lossy path, not a dead link. */
  lastActivityMs(): number {
    return Math.max(this.lastSnapAt, this.lastRelAt);
  }

  /** Test hook (?netlog): force-drop the P2P link to exercise the reconnect path. */
  debugDrop(): void {
    try {
      this.link.close();
    } catch {
      /* already closing */
    }
  }

  /** Reproduce hit/kill/hurt fx + audio from the prev→next snapshot diff (none of these
   *  travel in snapshots; the client re-derives them so combat has blood and sound). */
  private effects(prev: Snapshot, next: Snapshot): void {
    const st = getState();
    const nextIds = new Set(next.zombies.map((z) => z.id));
    for (const z of prev.zombies) {
      if (!nextIds.has(z.id)) {
        const t = ENEMY_TYPES[z.type];
        const big = z.type === "brute";
        fxKill(
          st,
          z.x,
          z.y,
          (t?.color ?? GREY) as RGB,
          (t?.glow ?? GREY) as RGB,
          big,
          true,
          t?.sprite ?? "",
          0,
          t?.radius ?? 0,
        );
        Audio.kill(big);
      }
    }
    const pz = new Map(prev.zombies.map((z) => [z.id, z]));
    for (const z of next.zombies) {
      const p = pz.get(z.id);
      if (p && z.flash > p.flash + 0.01) {
        const t = ENEMY_TYPES[z.type];
        // re-derive gore strength from the synced hp drop (no dmg travels in snapshots).
        // Exact for non-lethal hits; the killing-frame finisher spray is host-only (see spec §E).
        const g = CONFIG.fx.gore;
        const intensity = goreIntensity(
          p.hp - z.hp,
          z.hp,
          z.maxHp,
          g.dmgRef,
          g.lowHpBand,
          g.finisherBonus,
        );
        fxImpact(st, z.x, z.y, Math.random() * Math.PI * 2, (t?.color ?? GREY) as RGB, intensity);
        Audio.hit();
      }
    }
    const pp = new Map(prev.players.map((p) => [p.id, p]));
    for (const pl of next.players) {
      const p = pp.get(pl.id);
      if (p && pl.hitFlash > p.hitFlash + 0.01) {
        fxHurt(st, pl.x, pl.y);
        if (pl.id === st.localId) Audio.hurt();
      }
      if (p && p.healT > 0.05 && pl.healT <= 0.05) {
        fxActionBurst(st, pl.x, pl.y, [0.3, 1, 0.45], false);
        if (pl.id === st.localId) Audio.heal();
      }
      // peer-revive completion only: anchor to the assist gauge (the host fires this burst in
      // sysAssist). A tended teammate always shows assistT>0 in the prev snapshot, while the
      // dawn batch-respawn (revivePlayer, no tending) has assistT==0 — so this no longer
      // bursts at dawn, matching the host. (Rare: an interrupt→immediate-resume revive can
      // show assistT==0 in prev and drop the burst — cosmetic only, never a false fire.)
      if (p && p.hp <= 0 && p.assistT > 0 && pl.hp > 0) {
        fxActionBurst(st, pl.x, pl.y, [0.4, 1, 0.6], true);
      }
      // mate-heal mote: an external hp bump (a teammate's medkit) while this player is NOT
      // self-healing at EITHER end of the interval. Requiring prev healT<=0.05 too excludes
      // the self-heal *completion* tick (prev still had healT>0.05), which otherwise emitted a
      // stray mote alongside the completion burst. No pickup/upgrade raises a live player's hp.
      if (
        p &&
        pl.hp > p.hp + 1 &&
        p.hp > 0 &&
        pl.hp < pl.maxHp + 1 &&
        p.healT <= 0.05 &&
        pl.healT <= 0.05
      ) {
        fxMote(st, pl.x, pl.y, [0.3, 1, 0.45]);
      }
    }
    for (let i = 0; i < next.caches.length; i++) {
      const pc = prev.caches[i];
      const nc = next.caches[i];
      if (pc && nc && !pc.looted && nc.looted) {
        // cache positions aren't in the snapshot; use the live state's cache list (index-matched)
        const cache = st.caches[i];
        if (cache) fxActionBurst(st, cache.x, cache.y, [0.9, 0.8, 0.4], false);
      }
    }
    for (let i = 0; i < next.barricades.length; i++) {
      const pb = prev.barricades[i];
      const nb = next.barricades[i];
      const bar = st.barricades[i];
      if (pb && nb && bar && pb.hp < nb.hp && nb.hp >= bar.maxHp && pb.hp < bar.maxHp) {
        const m = segMid(bar.x1, bar.y1, bar.x2, bar.y2);
        fxActionBurst(st, m.x, m.y, [0.8, 0.7, 0.3], false);
      }
    }
    const prevDIds = new Set(prev.deployables.map((d) => d.id));
    for (const d of next.deployables) {
      if (!prevDIds.has(d.id)) {
        const def = DEPLOYABLE_TYPES[d.defId];
        fxActionBurst(st, d.x, d.y, (def?.color ?? GREY) as RGB, false);
      }
    }
    const nextDIds = new Set(next.deployables.map((d) => d.id));
    for (const d of prev.deployables) {
      if (!nextDIds.has(d.id)) {
        const def = DEPLOYABLE_TYPES[d.defId];
        const color = (def?.color ?? GREY) as RGB;
        // best-effort: RTB vs destroyed inferred from last-synced ammoFrac — a destruction in the final-rounds window may show the soft cue (cosmetic, no desync).
        if (d.ammoFrac <= 0.02) {
          fxImpact(st, d.x, d.y, 0, color); // soft power-down on RTB
        } else {
          fxKill(st, d.x, d.y, color, color, true, false); // loud destruction burst (no flesh — it's a machine)
        }
      }
    }

    // stalker withdraw cue: present→false edge — a retreating footfall, NOT a kill burst.
    // The stalker is a separate snapshot block and is never in `snap.zombies`, so it is
    // already excluded from the zombie kill-rederivation above (the prev.zombies / nextIds
    // id-diff loop only sees zombie entries, not this block).
    if (prev.stalker.present && !next.stalker.present) {
      // Play a retreating footfall cue (quiet, centred — stalker is withdrawing off-arena)
      Audio.stalkerFootfall(0, 0.3);
    }

    // stalkerFx (footfall/heartbeat/cone-flicker) for co-op clients is driven automatically
    // by game.ts:draw() via state.stalker, which applySnapshot now populates from the
    // synced block above. No additional wiring needed here.
    // Grab scare on the client: game.ts:draw() edge-detects state.stalker.contactCd, which is
    // now SYNCED in the snapshot block, so the flash/shake/lurch/stinger fire for a client
    // victim exactly as on the host. The pain grunt + blood come from the hitFlash re-derivation
    // above (fxHurt + Audio.hurt). Local-only, victim-gated by proximity in game.ts.
  }

  /** Send this frame's local input to the host (reliable, sequenced). */
  send(input: PlayerInput): void {
    if (!this.live) return; // suspended during a reconnect — don't ship to a dead/closing link
    const msg: NetMsg = { t: "input", input, seq: this.seq++ };
    this.link.sendRel(msg);
  }

  /** Co-op flow requests — the host validates and applies them authoritatively. */
  requestBuy(itemId: string): void {
    this.link.sendRel({ t: "buy", itemId });
  }
  requestPlace(): void {
    this.link.sendRel({ t: "place" });
  }
  requestDeploy(): void {
    this.link.sendRel({ t: "deploy" });
  }
  requestDraftTake(cardId: string): void {
    this.link.sendRel({ t: "draftTake", cardId });
  }
  requestDraftReroll(): void {
    this.link.sendRel({ t: "draftReroll" });
  }

  /**
   * Net diagnostics for the ?netlog HUD. RTT (rel ping/pong EWMA), snapshot interval + jitter,
   * rolling loss % (missed ticks between accepted snaps), out-of-order drops, and freeze rate
   * (frames the render time outran the newest snapshot). Reading resets the frame-rate counters,
   * so freeze % is "since the last HUD read".
   */
  netStats(): {
    rtt: number;
    interval: number;
    jitter: number;
    loss: number;
    reorders: number;
    freeze: number;
  } {
    const ats = this.buf.map((b) => b.at);
    let mean = 0;
    let jitter = 0;
    if (ats.length >= 2) {
      const deltas: number[] = [];
      for (let i = 1; i < ats.length; i++) {
        deltas.push((ats[i] as number) - (ats[i - 1] as number));
      }
      mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const v = deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / deltas.length;
      jitter = Math.sqrt(v);
    }
    const lost = this.gaps.reduce((a, b) => a + b, 0);
    const loss = this.gaps.length ? Math.round((lost / (lost + this.gaps.length)) * 100) : 0;
    const freeze = this.totalFrames ? Math.round((this.freezeFrames / this.totalFrames) * 100) : 0;
    this.freezeFrames = 0;
    this.totalFrames = 0;
    return {
      rtt: Math.round(this.rttMs),
      interval: Math.round(mean),
      jitter: Math.round(jitter),
      loss,
      reorders: this.reorders,
      freeze,
    };
  }

  /** Nudge the predicted local position toward the host's authoritative one. */
  private reconcile(snap: Snapshot): void {
    const id = getState().localId;
    const me = snap.players.find((p) => p.id === id);
    if (!me) return;
    const prevMe = this.prev?.players.find((p) => p.id === id);
    // first snapshot, or a respawn (was down, now alive) → adopt the authoritative
    // position outright so prediction doesn't ease across the whole map to HOME.
    if (!this.predInit || (prevMe && prevMe.hp <= 0 && me.hp > 0)) {
      this.predX = me.x;
      this.predY = me.y;
      this.predRecoilX = 0;
      this.predRecoilY = 0;
      this.predMuzzle = 0;
      this.predInit = true;
      return;
    }
    const err = Math.hypot(me.x - this.predX, me.y - this.predY);
    if (err > CONFIG.net.snapTeleportThresh) {
      // large divergence (knockback, teleport, wall) → snap
      this.predX = me.x;
      this.predY = me.y;
    } else {
      // small drift → ease toward authoritative so movement stays responsive
      this.predX += (me.x - this.predX) * CONFIG.net.smoothCorrect;
      this.predY += (me.y - this.predY) * CONFIG.net.smoothCorrect;
    }
  }

  /**
   * Render step: interpolate remote entities into state, then overwrite the local player
   * with the client-predicted position/aim. `inp` is this frame's input (null if paused).
   */
  render(nowMs: number, inp: PlayerInput | null, dt: number): void {
    if (!this.live || !this.started || this.buf.length === 0) return;

    // RTT probe: ping the host on the reliable channel ~1×/s (the host echoes pong). Measures
    // the actual DataChannel path latency — what gameplay feels — not STUN consent RTT.
    this.pingAcc += dt;
    if (this.pingAcc >= 1) {
      this.pingAcc = 0;
      const id = ++this.pingId;
      this.pingSent.set(id, performance.now());
      this.link.sendRel({ t: "ping", id });
      if (this.pingSent.size > 5) {
        const oldest = this.pingSent.keys().next().value; // drop unanswered (host gone / lossy)
        if (oldest !== undefined) this.pingSent.delete(oldest);
      }
    }

    const rt = nowMs - CONFIG.net.interpDelayMs;
    const buf = this.buf;

    // freeze = the render time outran the newest snapshot (no future frame to interpolate toward →
    // remote entities hold still). Tracked as a rate to gauge loss/jitter impact in the ?netlog HUD.
    this.totalFrames++;
    const newestAt = buf[buf.length - 1]?.at ?? 0;
    if (rt >= newestAt) this.freezeFrames++;

    let a = buf[0] as (typeof buf)[number];
    for (const s of buf) if (s.at <= rt) a = s;
    let b = a;
    for (const s of buf) {
      if (s.at > rt) {
        b = s;
        break;
      }
    }
    const span = b.at - a.at;
    const t = span > 0 ? Math.max(0, Math.min(1, (rt - a.at) / span)) : 0;
    applySnapshot(getState(), lerpSnapshots(a.snap, b.snap, t));

    // local player: client-predicted position (instant), authoritative scalars from snap
    const st = getState();
    const lp = localPlayer(st);
    // only predict while alive; a downed local player is a spectator (camera follows a
    // teammate via cameraTarget), so leave its snapshot position/aim untouched.
    if (this.predInit && lp.hp > 0) {
      // mirror the host's move-weight ramp from the synced weapon (raw render dt is clamped, since
      // a backgrounded tab can deliver a huge dt that would overshoot the ramp / teleport us).
      const cdt = Math.min(dt, 0.1);
      lp.curMoveMul = approach(
        lp.curMoveMul,
        effWeapon(lp, lp.weapon).moveMul,
        CONFIG.player.moveRampRate * cdt,
      );
      if (inp && lp.healT <= 0) {
        const tmp = { x: this.predX, y: this.predY, r: lp.r, speed: lp.speed };
        integrateMovement(tmp, inp, st.walls, cdt, lp.curMoveMul);
        this.predX = tmp.x;
        this.predY = tmp.y;
      }
      lp.x = this.predX;
      lp.y = this.predY;
      if (inp) lp.aim = inp.aim;
      // feel is predicted like position: decay our owned recoil/muzzle at frame rate, then impose
      // over the snapshot value (applySnapshot just clobbered them with the host's slice).
      const recoilRk = Math.exp(-CONFIG.feel.recoilDecay * cdt);
      this.predRecoilX *= recoilRk;
      this.predRecoilY *= recoilRk;
      if (this.predMuzzle > 0) this.predMuzzle -= cdt;
      lp.recoilX = this.predRecoilX;
      lp.recoilY = this.predRecoilY;
      lp.muzzle = Math.max(0, this.predMuzzle);
    }

    // advance existing ghost tracers (always, so they self-expire even while host-paused)
    this.ghosts = advanceGhosts(this.ghosts, dt);

    // Predict the FEEL of firing locally (muzzle flash, shot audio, recoil,
    // screen shake) so the trigger feels instant. We do NOT spawn a bullet or spend ammo:
    // the real round + damage are host-authoritative and arrive via snapshot. Gated on the
    // authoritative ammo/reload/heal (from the snapshot) so we never flash on an empty mag.
    if (this.fireCdLocal > 0) this.fireCdLocal -= dt;
    if (inp) {
      const wd = effWeapon(lp, lp.weapon);
      const wantFire = inp.firing && (wd.auto || !this.firedThisHoldLocal);
      if (
        wantFire &&
        this.fireCdLocal <= 0 &&
        lp.reloadT <= 0 &&
        lp.switchT <= 0 &&
        lp.healT <= 0 &&
        (wd.melee || lp.ammo > 0)
      ) {
        const tipX = lp.x + Math.cos(lp.aim) * lp.r;
        const tipY = lp.y + Math.sin(lp.aim) * lp.r;
        // shared fire-feel (recoil/muzzle/shake/audio + the gun's muzzle sparks) — the exact code
        // the host runs, so our predicted melee lunge / gun kick can never drift from authority.
        // The slash visual itself is the crescent drawn in drawPlayer off the predicted muzzle.
        applyFireFeel(st, lp, wd);
        drainFxEvents(st); // play THIS client's predicted muzzle (shot/melee audio + muzzle sparks)
        // take ownership of the resulting feel so the per-frame re-impose keeps it smooth
        this.predRecoilX = lp.recoilX;
        this.predRecoilY = lp.recoilY;
        this.predMuzzle = lp.muzzle;
        // ghost tracers: visual-only, one per pellet, local spread (desync-harmless)
        if (!wd.melee) {
          for (let i = 0; i < wd.pellets; i++) {
            const a = lp.aim + rand(-wd.spread, wd.spread);
            this.ghosts.push({
              id: this.ghostId--,
              x: tipX,
              y: tipY,
              px: tipX,
              py: tipY,
              vx: Math.cos(a) * wd.bulletSpeed,
              vy: Math.sin(a) * wd.bulletSpeed,
              r: 4,
              dmg: 0,
              life: CONFIG.net.ghostLife,
              pierce: 0,
              knockback: 0,
              color: wd.color,
            });
          }
        }
        this.fireCdLocal = 1 / (wd.fireRate * lp.fireRateMul);
        this.firedThisHoldLocal = true;
      }
      if (!inp.firing) this.firedThisHoldLocal = false;
    }

    // append ghosts to the (snapshot-rebuilt) bullet list so draw() renders them this
    // frame. MUST stay last: applySnapshot above replaced state.bullets, and generation
    // just ran, so new ghosts show immediately and old arrays never accumulate.
    for (const g of this.ghosts) st.bullets.push(g);
  }
}
