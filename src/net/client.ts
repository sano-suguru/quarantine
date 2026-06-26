import { CONFIG } from "../config";
import { effWeapon } from "../data/arsenal";
import { ENEMY_TYPES } from "../data/enemies";
import { Audio } from "../engine/audio";
import { rand } from "../engine/math";
import { localPlayer } from "../engine/players";
import { clientApplyHello, clientGameOver, getState, startClientGame } from "../game";
import { fxHurt, fxImpact, fxKill, fxMuzzle } from "../systems/fx";
import { integrateMovement } from "../systems/player";
import type { Bullet } from "../types";
import { advanceGhosts } from "./ghost";
import type { NetMsg } from "./net";
import type { PlayerInput } from "./playerInput";
import { type Snapshot, applySnapshot, decode, lerpSnapshots } from "./snapshot";
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
    wlevel: Record<string, number>;
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
  // visual-only predicted tracers (negative id) so the shot's bullet line shows instantly
  // instead of ~interpDelay late; the real bullet/damage stay host-authoritative.
  private ghosts: Bullet[] = [];
  private ghostId = -1;
  // net diagnostics (surfaced by the ?netlog HUD): rel-channel ping/pong RTT + snapshot jitter.
  private rttMs = 0;
  private pingId = 0;
  private pingSent = new Map<number, number>();
  private pingAcc = 0;

  constructor(
    private link: PeerLink,
    private onStart?: () => void,
  ) {
    link.onRel((m) => {
      const msg = m as NetMsg;
      if (msg.t === "hello") {
        this.hello = { localId: msg.localId, owned: msg.owned, wlevel: msg.wlevel };
        if (this.started) clientApplyHello(msg.localId, msg.owned, msg.wlevel);
      } else if (msg.t === "gameover") {
        clientGameOver(msg.salvage, msg.day, msg.kills, msg.money);
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
      if (this.started && !getState().running) return; // run ended: stop fx/audio behind the debrief
      const snap = decode(b);
      if (!this.started) {
        startClientGame(); // host has deployed — leave the lobby, show the game
        this.started = true;
        if (this.hello) clientApplyHello(this.hello.localId, this.hello.owned, this.hello.wlevel);
        this.onStart?.();
      }
      this.buf.push({ snap, at: performance.now() });
      if (this.buf.length > 8) this.buf.shift();
      this.reconcile(snap);
      if (this.prev) this.effects(this.prev, snap);
      this.prev = snap;
    });
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
        fxKill(st, z.x, z.y, (t?.color ?? GREY) as RGB, (t?.glow ?? GREY) as RGB, big);
        Audio.kill(big);
      }
    }
    const pz = new Map(prev.zombies.map((z) => [z.id, z]));
    for (const z of next.zombies) {
      const p = pz.get(z.id);
      if (p && z.flash > p.flash + 0.01) {
        const t = ENEMY_TYPES[z.type];
        fxImpact(st, z.x, z.y, Math.random() * Math.PI * 2, (t?.color ?? GREY) as RGB);
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
    }
  }

  /** Send this frame's local input to the host (reliable, sequenced). */
  send(input: PlayerInput): void {
    const msg: NetMsg = { t: "input", input, seq: this.seq++ };
    this.link.sendRel(msg);
  }

  /** Co-op flow requests — the host validates and applies them authoritatively. */
  requestBuy(itemId: string): void {
    this.link.sendRel({ t: "buy", itemId });
  }
  requestDeploy(): void {
    this.link.sendRel({ t: "deploy" });
  }
  requestNight(): void {
    this.link.sendRel({ t: "nightStart" });
  }

  /** Net diagnostics for the ?netlog HUD: RTT (rel ping/pong), snapshot interval + jitter, buffer. */
  netStats(): { rtt: number; interval: number; jitter: number; buf: number } {
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
    return {
      rtt: Math.round(this.rttMs),
      interval: Math.round(mean),
      jitter: Math.round(jitter),
      buf: this.buf.length,
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
    if (!this.started || this.buf.length === 0) return;

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
      if (inp && lp.healT <= 0) {
        const tmp = { x: this.predX, y: this.predY, r: lp.r, speed: lp.speed };
        integrateMovement(tmp, inp, st.walls, dt);
        this.predX = tmp.x;
        this.predY = tmp.y;
      }
      lp.x = this.predX;
      lp.y = this.predY;
      if (inp) lp.aim = inp.aim;
    }

    // advance existing ghost tracers (always, so they self-expire even while host-paused)
    this.ghosts = advanceGhosts(this.ghosts, dt);

    // Predict the FEEL of firing locally (muzzle flash, shot audio, recoil,
    // screen shake) so the trigger feels instant. We do NOT spawn a bullet or spend ammo:
    // the real round + damage are host-authoritative and arrive via snapshot. Gated on the
    // authoritative ammo/reload/heal (from the snapshot) so we never flash on an empty mag.
    if (this.fireCdLocal > 0) this.fireCdLocal -= dt;
    if (inp) {
      const wd = effWeapon(st, lp.weapon);
      const wantFire = inp.firing && (wd.auto || !this.firedThisHoldLocal);
      if (
        wantFire &&
        this.fireCdLocal <= 0 &&
        lp.reloadT <= 0 &&
        lp.healT <= 0 &&
        (wd.melee || lp.ammo > 0)
      ) {
        const tipX = lp.x + Math.cos(lp.aim) * lp.r;
        const tipY = lp.y + Math.sin(lp.aim) * lp.r;
        fxMuzzle(st, tipX, tipY, lp.aim, wd.color);
        lp.muzzle = wd.melee ? 0.04 : 0.05;
        const rk = wd.recoil * (wd.melee ? 0.6 : 0.9);
        lp.recoilX -= Math.cos(lp.aim) * rk;
        lp.recoilY -= Math.sin(lp.aim) * rk;
        st.cam.shake = Math.min(st.cam.shake + wd.recoil, 18);
        if (wd.melee) Audio.melee();
        else Audio.shot(lp.weapon);
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
        this.fireCdLocal = 1 / (wd.fireRate * st.fireRateMul);
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
