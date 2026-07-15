import { CONFIG } from "../sim/config";
import {
  cardItem,
  effWeapon,
  meleeArc,
  meleeReach,
  rerollCost,
  type StoreItem,
  storeItems,
} from "../sim/data/arsenal";
import { DEPLOYABLE_TYPES } from "../sim/data/deployables";
import { ENEMY_TYPES } from "../sim/data/enemies";
import { WORKBENCH } from "../sim/data/map";
import { PICKUP_TYPES } from "../sim/data/pickups";
import { PLAYER_COLORS } from "../sim/data/players";
import { UNLOCKABLE_CARDS, UPGRADES } from "../sim/data/upgrades";
import { UNLOCKABLE, WEAPON_ORDER, WEAPONS } from "../sim/data/weapons";
import { type LightCandidate, selectLights } from "../sim/engine/lights";
import { cameraTarget, localPlayer, nearestPlayer } from "../sim/engine/players";
import { newState, setUnlockProvider } from "../sim/state";
import { actionMotion, deriveActionChannel } from "../sim/systems/actionFeel";
import { flashlightIntensity } from "../sim/systems/flashlight";
import { integrityGrade } from "../sim/systems/integrity";
import { effectiveSearchTime } from "../sim/systems/player";
import { ambientForClock, clockFrac, clockLabel } from "../sim/systems/siege";
import type { Player, State, WeaponDef } from "../sim/types";
import { resolveHotbarSlot } from "./autoAim";
import { Audio } from "./engine/audio";
import { Renderer, SHAPE } from "./engine/renderer";
import { Input } from "./input";
import { addSalvage, buyUnlock, loadMeta } from "./meta";
import { Net } from "./net/net";
import { DEFAULT_LOADOUT, getSettings, MAX_LOADOUT, setLoadout } from "./settings";
import { resetStalkerFx, stalkerFx } from "./systems/stalkerFx";
import { resetStalkerPhantom, sysStalkerPhantom } from "./systems/stalkerPhantom";
import { el, hide, renderList, show } from "./ui";

// Feed persisted meta-unlocks into the (browser-free) sim closure. Registered before the first
// `newState()` below so single-player boot state is identical to the old direct-`loadMeta` path.
setUnlockProvider(() => loadMeta().unlocked);

let state: State = newState();

export function getState(): State {
  return state;
}

// Whether THIS client's shop overlay is open. Client-local UI state — the sim no longer pauses
// and the snapshot carries no shop flag. Opened by interacting at the fortress workbench during
// the day (main.ts), closed by the Done control or leaving. Movement input is suppressed while open.
let shopOpen = false;
export function isShopOpen(): boolean {
  return shopOpen;
}
export function openShopOverlay(): void {
  shopOpen = true;
}
export function closeShopOverlay(): void {
  shopOpen = false;
}

const TOXIC: [number, number, number] = [0.49, 1.0, 0.31];

// draw-only: first time each deployable id was seen (for the spawn-in emerge). Works for SP
// (id appears when placed) and co-op (id appears in a snapshot) — no synced spawn timer needed.
const deployableSeen = new Map<number, number>();

// Sprite zombies are drawn at this multiple of the hitbox diameter (rad*2), > 1 so the
// illustration reads instead of minifying to mush at the collision size. Feel knob.
const SPRITE_SCALE = CONFIG.render.spriteScale;
// The illustration's FRONT is its bottom edge (local -y). rot = face + this offset points that
// front at the target from any direction (world +y = screen down → +90° aligns -y with face).
// If the sprite faces a quarter/half turn off on device, nudge this by ±PI/2 or PI.
const SPRITE_FACE_OFFSET = CONFIG.render.spriteFaceOffset;
// Hit-flash strength for sprites: on a hit the tint is multiplied by (1 + fl*this), i.e. an
// overbright pop (a texture multiply can't lerp to pure white like the SDF fill does). Feel knob.
const SPRITE_FLASH = 1.5;

// medkit overlay prop (viz-part shaped): a white case with a green cross. Posed by drawRigParts.
const MEDKIT_PROP: WeaponDef["viz"] = [
  { shape: "rect", dx: 0, dy: 0, len: 9, wid: 7, rot: 0, color: [0.9, 0.9, 0.92] },
  { shape: "rect", dx: 0, dy: 0, len: 6, wid: 2, rot: 0, color: [0.2, 0.85, 0.35] },
  { shape: "rect", dx: 0, dy: 0, len: 2, wid: 6, rot: 0, color: [0.2, 0.85, 0.35] },
];

// hammer/tool overlay prop: a handle + a head.
const TOOL_PROP: WeaponDef["viz"] = [
  { shape: "rect", dx: 4, dy: 0, len: 12, wid: 2.5, rot: 0, color: [0.5, 0.4, 0.3] },
  { shape: "rect", dx: 10, dy: 0, len: 5, wid: 6, rot: 0, color: [0.7, 0.72, 0.75] },
];

/* -------------------------- UPDATE / DRAW ----------------------- */
let hbT = 0; // heartbeat timer
let groanT = 2; // ambient groan timer
// Grab scare (local player only): tracks the stalker contactCd so we can detect a new grab.
// A grab is detected when contactCd jumps up to contactCd max (stalker.ts sets it on contact).
let prevStalkerCd = 0; // contactCd last frame — render-side edge detector for the scare

/* ---- horror "feel" layer (light/sound polish) ----
 * All of this is pure visual/audio re-derived from `state` on whichever machine renders:
 * it never touches the sim (`update`/`state`/`sysFx`/`sysAI`), so single-player stays
 * byte-for-byte and every co-op client produces its own fear locally from the snapshot world. */

/** Time-correlated 0..1 flicker value: a smooth low tremor with occasional brief surges, so the
 *  cone reads as a failing bulb rather than per-frame static. Decorrelated per `seed` (player id). */
function flickerNoise(t: number, seed: number): number {
  const s = seed * 1.37;
  const base = 0.5 + 0.3 * Math.sin(t * 9.1 + s) + 0.2 * Math.sin(t * 23.7 + s * 2.3);
  const surge = Math.max(0, Math.sin(t * 2.3 + s * 5)) ** 6; // sparse deeper dip
  return Math.max(0, Math.min(1, base * 0.5 + surge));
}

// dust motes: fixed per-mote seeds, animated purely from state.time (no per-frame state)
const DUST = Array.from({ length: CONFIG.flashlight.dustCount }, () => ({
  ang: Math.random() * 2 - 1, // -1..1 → fraction of the cone half-angle
  dist: 0.18 + Math.random() * 0.72, // fraction of cone range
  phase: Math.random() * Math.PI * 2,
  spd: 0.25 + Math.random() * 0.7,
  size: 0.6 + Math.random() * 1.3,
}));

// darting shadows: visual-only streaks (NOT in state.particles → single-player safe)
interface Dart {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}
let darts: Dart[] = [];
let lastDrawT = 0; // for a render-side dt derived from state.time (advances on host & client)

// per-zombie voice bookkeeping (groan while lurking / screech on entering the cone). Keyed by
// zombie id; pure audio state, never synced. recentVoices throttles to avoid 4p×horde saturation.
const voiceMem = new Map<number, { wasLit: boolean; nextGroan: number }>();
let recentVoices: number[] = []; // state.time stamps of recent individual voices

// heartbeat→vignette pulse: set when a heartbeat fires, read (and decayed) in draw
let lastBeatT = -10;
let beatStrength = 0;
// honor the OS "reduce motion" setting: shaders can't read CSS media queries, so we freeze the
// blood churn/breathe by passing a constant clock (read once; guarded for non-DOM test env).
const reducedMotion =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
// HP→world grade (desaturation + dim): eased current values. sat=1 dim=1 = full color.
// Gated on state.running so dead-player 0 HP doesn't drain debrief/title screens.
// Snapped to 1 by toTitle (and the newState reset); held (not advanced) while not running.
let gradeSatCur = 1;
let gradeDimCur = 1;
// Full-screen damage flash is a PER-VIEWER cue, owned client-side (not on State / not synced):
// the DO would only compute+discard it. Bumped on the local player's hitFlash edge (client.ts)
// and by the stalker scare (below); decayed each client frame (main.ts calls decayFlash).
let flashT = 0;
let flashColor: [number, number, number] = [1, 0.3, 0.3];

/** Add to this client's screen flash (clamped) and set its color. */
export function bumpFlash(amt: number, color: [number, number, number]): void {
  flashT = Math.min(1, flashT + amt);
  flashColor = color;
}

/** Exponential decay of this client's screen flash (called from the render loop). */
export function decayFlash(dt: number): void {
  flashT *= Math.exp(-CONFIG.feel.flashDecay * dt);
}

// flashlight-death edge: tracks LOCAL player's battery fraction tick-to-tick so audioAmbience can
// fire lightDie exactly once when it crosses zero. Reset to 1 each run so a dead battery from a
// prior run can't suppress the cue at the start of the next.
let prevBattery = 1;

/** Reset the per-run atmosphere bookkeeping so stale zombie ids / darts don't carry across runs. */
function resetAtmosphere(): void {
  voiceMem.clear();
  recentVoices = [];
  darts = [];
  lastBeatT = -10;
  beatStrength = 0;
  gradeSatCur = 1;
  gradeDimCur = 1;
  prevBattery = 1;
  // Reset the render-side draw clock so the first draw() of a fresh run (where state.time resets
  // to 0) doesn't produce a negative/large ddt that flings darts or garbles ease steps.
  lastDrawT = 0;
  prevStalkerCd = 0;
  resetStalkerFx();
  resetStalkerPhantom();
}

export function audioAmbience(dt: number): void {
  const p = localPlayer(state);
  const hpf = p.hp / p.maxHp;
  const wd = effWeapon(p, p.weapon);
  // running dry feeds the dread too — the fear of an empty gun
  const totalAmmo = p.ammo + (p.reserve[p.weapon] ?? 0);
  const lowAmmo = !wd.melee && wd.mag > 0 && totalAmmo < wd.mag * CONFIG.horror.lowAmmo;
  // dread = the low-frequency drone of VISIBLE pressure. The floor is low so quiet moments go
  // near-silent (the "silence" dynamic) and the next threat lands harder. Unseen threats no
  // longer feed the drone — they drive the separate high tension layer below (role split).
  const dread = Math.min(
    1,
    CONFIG.horror.dreadFloor +
      state.surrounded / (CONFIG.horror.surroundCount * 1.6) +
      (hpf < CONFIG.horror.lowHp ? 0.35 : 0) +
      (lowAmmo ? 0.2 : 0) +
      (state.phase === "night" ? 0.12 : 0),
  );
  Audio.setDread(dread);
  // tension = the rising dissonance of UNSEEN threats crowding the dark behind/around you
  Audio.setTension(Math.min(1, state.lurking / CONFIG.horror.surroundCount));

  // flashlight-death: one-shot cue when the LOCAL player's battery crosses zero. Runs on every
  // machine via audioAmbience (single/host/client all call this), so co-op clients hear their
  // own cue correctly from their synced battery — NOT from a sysPlayer event (which clients
  // never run). prevBattery is reset to 1 each run so a dead prior-run battery can't suppress it.
  const batf = p.battery / CONFIG.flashlight.batteryMax;
  if (prevBattery > 0 && batf <= 0) Audio.lightDie();
  prevBattery = batf;

  if (hpf < CONFIG.horror.lowHp) {
    hbT -= dt;
    if (hbT <= 0) {
      const strength = 1 - hpf / CONFIG.horror.lowHp; // closer to death = stronger
      Audio.heartbeat(0.6 + strength * 0.6);
      lastBeatT = state.time; // pulse the vignette in time with the beat (read in updateHUD)
      beatStrength = 0.5 + strength * 0.5;
      hbT = 0.9 - strength * 0.4;
    }
  } else {
    hbT = 0.3;
  }

  // per-zombie groans / cone-entry screeches, re-derived locally from the world
  zombieVoices();

  // day = explore/respite, so voices are sparser + quieter than the night siege (night unchanged).
  const night = state.phase === "night";
  const voiceMul = night ? 1 : CONFIG.horror.dayVoiceMul;
  const voiceVol = night ? 1 : CONFIG.horror.dayVoiceVol;

  // ambient horde murmur — proximity-gated so it only sounds when a zombie is ACTUALLY near the
  // local player (no groans-from-nowhere when the map's roamers are far). Sparser/quieter by day.
  groanT -= dt;
  if (groanT <= 0 && state.surrounded > 0) {
    Audio.groan((Math.random() * 2 - 1) * 0.8, "walker", voiceVol);
    groanT = Math.max(0.6, 3.5 - state.zombies.length * 0.06) * voiceMul;
  }
}

/**
 * Drive the looping ambience + rummage samples. Called once per rAF frame from main.ts so loops
 * correctly stop at title/gameover
 * and stay consistent across single/host/client (all share the render frame). Reads state only —
 * no mutation — so single-player stays byte-for-byte and clients drive it from the synced world.
 */
export function audioLoops(): void {
  const live = state.running;
  // day/night ambience (crossfades because both are toggled from the same phase)
  Audio.loop("amb_day", live && state.phase === "day", CONFIG.audio.ambVolume);
  Audio.loop("amb_night", live && state.phase === "night", CONFIG.audio.ambVolume);
  // rummage loop while the LOCAL player searches a nearby cache (day or night, read-only scan).
  // At night this SFX is the audible "rummaging" that thematically explains the zombie lure.
  let searching = false;
  if (live) {
    const lp = localPlayer(state);
    const reach = CONFIG.siege.interactRadius;
    const reach2 = reach * reach;
    const full = effectiveSearchTime(state.phase);
    for (const c of state.caches) {
      if (c.looted || c.searchT <= 0 || c.searchT >= full) continue;
      const dx = c.x - lp.x;
      const dy = c.y - lp.y;
      if (dx * dx + dy * dy <= reach2) {
        searching = true;
        break;
      }
    }
  }
  Audio.loop("search", searching, CONFIG.audio.searchVolume);
}

/**
 * Per-zombie horror voices, re-derived LOCALLY (no snapshot fields, no sim state). For each
 * nearby zombie relative to the local player we fire:
 *  - a screech the instant it crosses from the dark into the flashlight cone ("it was right there"),
 *  - an occasional groan while it lurks unseen and close.
 * A rolling concurrency cap keeps a 4-player horde from saturating into noise; when many lurk we
 * thin the individual voices and let the tension layer carry the dread (quantity → quality).
 */
function zombieVoices(): void {
  const lp = localPlayer(state);
  const now = state.time;
  // day damp (matches audioAmbience): quieter + sparser groans during the explore phase.
  const night = state.phase === "night";
  const voiceMul = night ? 1 : CONFIG.horror.dayVoiceMul;
  const voiceVol = night ? 1 : CONFIG.horror.dayVoiceVol;
  const coneCos = Math.cos(CONFIG.flashlight.halfAngle);
  const aimX = Math.cos(lp.aim);
  const aimY = Math.sin(lp.aim);
  const nearR = CONFIG.horror.surroundRadius * 1.4; // voices carry a little past the dread radius
  const nearR2 = nearR * nearR;

  // anti-saturation budget: drop voices older than the window, then cap how many may sound
  const win = CONFIG.horror.voiceWindowMs / 1000;
  recentVoices = recentVoices.filter((t) => now - t <= win);
  const cap =
    state.lurking > CONFIG.horror.lurkThinAt
      ? Math.max(1, CONFIG.horror.maxConcurrentVoices - 2)
      : CONFIG.horror.maxConcurrentVoices;
  const canVoice = (): boolean => {
    if (recentVoices.length >= cap) return false;
    recentVoices.push(now);
    return true;
  };

  for (const z of state.zombies) {
    const dx = z.x - lp.x;
    const dy = z.y - lp.y;
    const d2 = dx * dx + dy * dy;
    let m = voiceMem.get(z.id);
    if (d2 > nearR2) {
      // far away: forget its lit-state so a later approach re-triggers a screech cleanly
      if (m) voiceMem.delete(z.id);
      continue;
    }
    const d = Math.sqrt(d2) || 1;
    const lit = (dx / d) * aimX + (dy / d) * aimY > coneCos; // caught in the cone
    const pan = Math.max(-1, Math.min(1, dx / 400));
    const vol = Math.max(0.3, 1 - d / nearR);
    if (!m) {
      m = { wasLit: lit, nextGroan: now + Math.random() * CONFIG.horror.groanCooldown };
      voiceMem.set(z.id, m);
    }
    // screech the moment it enters the light from the dark
    if (lit && !m.wasLit && canVoice()) Audio.screech(pan, vol);
    m.wasLit = lit;
    // groan while lurking unseen and close, on an irregular per-zombie cadence (damped by day)
    if (!lit && now >= m.nextGroan) {
      m.nextGroan = now + CONFIG.horror.groanCooldown * (0.6 + Math.random() * 0.8) * voiceMul;
      if (Math.random() < CONFIG.horror.groanChance && canVoice())
        Audio.groan(pan, z.type, vol * voiceVol);
    }
  }
}

/** spawn one shadow streak near a cone edge, sweeping across the beam. */
function spawnDart(lp: Player): void {
  if (darts.length >= 6) return;
  const flc = CONFIG.flashlight;
  const side = Math.random() < 0.5 ? -1 : 1;
  const dist = flc.range * (0.35 + Math.random() * 0.45);
  const ang = lp.aim + side * flc.halfAngle * (0.7 + Math.random() * 0.5); // start near a cone edge
  const cross = lp.aim - (Math.PI / 2) * side; // sweep toward the opposite edge
  const sp = CONFIG.horror.dartSpeed * (0.8 + Math.random() * 0.4);
  darts.push({
    x: lp.x + Math.cos(ang) * dist,
    y: lp.y + Math.sin(ang) * dist,
    vx: Math.cos(cross) * sp,
    vy: Math.sin(cross) * sp,
    life: CONFIG.horror.dartLife,
    maxLife: CONFIG.horror.dartLife,
  });
}

/** Visual atmosphere drawn inside the local player's cone: drifting dust + occasional darting
 *  shadows. Pure render (no sim state) so single-player stays byte-for-byte; `ddt` is derived
 *  from state.time (which advances on host & client) since draw() has no dt of its own. */
function drawAtmosphere(R: typeof Renderer, lp: Player, ddt: number): void {
  const flc = CONFIG.flashlight;
  const ambient = ambientForClock(state.phase, state.phaseT, state.day);
  const lit = lp.battery > 0 && ambient < 0.2; // only meaningful in the dark
  if (lit) {
    // dust motes: faint additive specks drifting in the beam
    for (const m of DUST) {
      const ang = lp.aim + m.ang * flc.halfAngle * 0.92;
      const drift = Math.sin(state.time * m.spd + m.phase);
      const dist = m.dist * flc.range * 0.62 + drift * 22;
      const x = lp.x + Math.cos(ang) * dist + Math.cos(state.time * m.spd * 0.6 + m.phase) * 10;
      const y = lp.y + Math.sin(ang) * dist + Math.sin(state.time * m.spd * 0.8 + m.phase) * 10;
      const tw = 0.45 + 0.55 * Math.sin(state.time * 1.6 + m.phase * 3); // slow twinkle
      if (tw <= 0) continue;
      const c = flc.dustColor;
      R.glow(x, y, m.size * flc.dustSize, c[0], c[1], c[2], flc.dustAlpha * tw);
    }
    // darting shadows: more likely the more unseen threats crowd the dark
    if (state.lurking > 0 && Math.random() < state.lurking * CONFIG.horror.dartChancePerLurk * ddt)
      spawnDart(lp);
  }
  for (let i = darts.length - 1; i >= 0; i--) {
    const d = darts[i] as Dart;
    d.life -= ddt;
    if (d.life <= 0) {
      darts.splice(i, 1);
      continue;
    }
    d.x += d.vx * ddt;
    d.y += d.vy * ddt;
    const a = d.life / d.maxLife;
    // a near-black streak that briefly occludes the beam (a thing crossing your light)
    R.rect(d.x, d.y, 28, 7, Math.atan2(d.vy, d.vx), 0.02, 0.02, 0.03, 0.7 * a);
  }
}

/**
 * Client-side ambience: the client runs no sim, so it recomputes the dread inputs
 * (surrounded/lurking, normally set by sysAI) from the snapshot world relative to the
 * local player, then reuses audioAmbience for the dread/heartbeat/groan soundscape.
 */
export function clientAmbience(dt: number): void {
  const lp = localPlayer(state);
  const r2 = CONFIG.horror.surroundRadius * CONFIG.horror.surroundRadius;
  const coneCos = Math.cos(CONFIG.flashlight.halfAngle);
  const aimX = Math.cos(lp.aim);
  const aimY = Math.sin(lp.aim);
  let near = 0;
  let lurking = 0;
  for (const z of state.zombies) {
    const dx = lp.x - z.x;
    const dy = lp.y - z.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < r2) {
      near++;
      const d = Math.sqrt(d2) || 1;
      if ((dx / d) * aimX + (dy / d) * aimY < coneCos) lurking++;
    }
  }
  state.surrounded = near;
  state.lurking = lurking;
  audioAmbience(dt);
}

export function draw(): void {
  const R = Renderer;
  const lp = localPlayer(state);
  // render-side dt from state.time (advances on host via update + client via snapshot); clamped
  // so a backgrounded tab's time jump can't fling darts across the map.
  const ddt = Math.max(0, Math.min(0.1, state.time - lastDrawT));
  lastDrawT = state.time;

  // --- stalker telegraph (footfall/heartbeat audio + cone-flicker signal) ---
  // Render/audio only; returns a 0..1 dread value used to modulate the local player's cone below.
  const stalkerDread = stalkerFx(state, lp, ddt);
  // fake perception cues (silhouettes now; phantom steps in Stage 2) — render/audio-only.
  const phantoms = sysStalkerPhantom(state, lp, ddt, stalkerDread);

  // --- grab scare (local victim only): the full diegetic grab feedback — hard purple flash +
  //     camera shake + camera lurch + stinger. Keyed off the stalker's contactCd edge (jumps to
  //     max on each grab), which is now SYNCED in the snapshot, so this fires identically on the
  //     host and on a client victim. Kept in draw() (not sysStalker) so a client — which never runs
  //     sysStalker — still gets it. contactCd is per-stalker (global), so a proximity gate limits
  //     the scare to the player actually grabbed (only the victim is within contact range). ---
  if (state.stalker && state.running) {
    const sk = state.stalker;
    const cdNow = sk.contactCd;
    const justGrabbed = cdNow > prevStalkerCd && cdNow >= CONFIG.stalker.contactCd * 0.95;
    if (justGrabbed) {
      const lplayer = localPlayer(state);
      const gdx = sk.x - lplayer.x;
      const gdy = sk.y - lplayer.y;
      const near = gdx * gdx + gdy * gdy < (CONFIG.stalker.contactDist * 1.6) ** 2;
      if (lplayer.id === state.localId && lplayer.hp > 0 && near) {
        // Hard flash (0.7 base + boost) in cold stalker purple — client-owned per-viewer cue.
        bumpFlash(0.7 + CONFIG.stalker.scareFlashBoost, [0.8, 0.1, 0.8]);
        state.cam.shake = Math.min(state.cam.shake + CONFIG.feel.shakeMax, CONFIG.feel.shakeMax);
        // Camera lurch: bias the camera toward the stalker for one frame by nudging cam position.
        // We use a cam drag rather than directly mutating c.x/c.y so sysCamera's lerp recovers naturally.
        const ddx = sk.x - state.cam.x;
        const ddy = sk.y - state.cam.y;
        const ddl = Math.hypot(ddx, ddy) || 1;
        state.cam.x += (ddx / ddl) * CONFIG.stalker.scareDragDist;
        state.cam.y += (ddy / ddl) * CONFIG.stalker.scareDragDist;
        // Audio stinger (no text — diegetic only)
        Audio.stalkerStinger();
      }
    }
    prevStalkerCd = cdNow;
  } else {
    prevStalkerCd = 0;
  }

  const c = state.cam;
  const sh = c.shake;
  const camX = c.x + (Math.random() * 2 - 1) * sh;
  const camY = c.y + (Math.random() * 2 - 1) * sh;
  // daylight floods the arena; night sinks to near-black (flashlight essential)
  const flc = CONFIG.flashlight;
  const ambient = ambientForClock(state.phase, state.phaseT, state.day);
  R.setLightParams(
    Math.cos(flc.halfAngle),
    flc.range,
    ambient,
    flc.personalRadius,
    flc.personalMax,
    flc.emissiveFloor,
  );
  // one aimed flashlight per living player + weapon-bearing deployables, culled to viewport
  R.beginLights();
  const dcfg = CONFIG.deployables;
  const { x: hx, y: hy } = R.worldToScreenHalf();
  const cands: LightCandidate[] = [];
  for (const pl of state.players) {
    if (pl.hp <= 0 || pl.absent) continue;
    const baseIntensity = flashlightIntensity(
      pl.battery / flc.batteryMax,
      flc.lowThreshold,
      flc.flickerDepth,
      flc.baseFlickerDepth,
      flickerNoise(state.time, pl.id),
      flc.dimFloor,
      flc.dimStart,
    );
    // Apply stalker cone-flicker to the LOCAL player's light only (the "something interfering
    // with your beam" effect — feels personal, not global). Capped so the cone never goes black.
    const intensity =
      pl.id === state.localId
        ? Math.max(flc.dimFloor, baseIntensity - stalkerDread * CONFIG.stalker.flickerMax)
        : baseIntensity;
    cands.push({
      x: pl.x,
      y: pl.y,
      ax: Math.cos(pl.aim),
      ay: Math.sin(pl.aim),
      intens: intensity,
      range: flc.range,
      cosHalf: Math.cos(flc.halfAngle),
      priority: 1,
    });
  }
  for (const d of state.deployables) {
    if (!DEPLOYABLE_TYPES[d.defId]?.weapon) continue;
    cands.push({
      x: d.x,
      y: d.y,
      ax: Math.cos(d.aim),
      ay: Math.sin(d.aim),
      intens: dcfg.lightIntensity * (d.reloading ? 0.6 : 1),
      range: flc.range * dcfg.lightRangeMul,
      cosHalf: Math.cos(dcfg.lightHalfAngle),
      priority: 0,
    });
  }
  for (const c of selectLights(cands, camX, camY, hx, hy, R.maxLights())) {
    R.addLight(c.x, c.y, c.ax, c.ay, c.intens, c.cosHalf, c.range);
  }
  R.begin();

  // --- ground: blood decals ---
  for (const d of state.decals) {
    const cap = CONFIG.fx.blood.maxAlpha;
    const a = Math.min(cap, (d.life / d.maxLife) * cap);
    if (d.spriteKey) {
      const dl = R.spriteLayer(d.spriteKey);
      if (dl < 0) continue;
      const dk = CONFIG.fx.gore.fragDecalDarken;
      const dsz = d.size ?? 8; // cell size captured at settle (matches the flying fragment); fallback if absent
      R.spriteFragQuad(d.x, d.y, dsz, dsz, d.rot, dl, d.cellX ?? 0, d.cellY ?? 0, dk, dk, dk, a);
    } else {
      R.circle(d.x, d.y, d.r, d.color[0], d.color[1], d.color[2], a);
    }
  }

  // --- shelter: stone walls + boarded openings, world loot caches, fortifications ---
  drawShelter(R);
  drawCaches(R);
  drawDeployables(R);

  // --- fortress workbench marker (shop spot): a ring, brighter by day when it's usable ---
  if (state.phase === "day") {
    R.ring(WORKBENCH.x, WORKBENCH.y, 22, 0.9, 0.8, 0.4, 0.9);
    R.glow(WORKBENCH.x, WORKBENCH.y, 46, 0.5, 0.42, 0.2, 0.5);
  } else {
    R.ring(WORKBENCH.x, WORKBENCH.y, 22, 0.4, 0.4, 0.45, 0.4);
  }

  // --- normal particles (shards / smoke / flesh fragments) ---
  for (const pt of state.particles) {
    const a = pt.life / pt.maxLife;
    if (pt.kind === "shard")
      R.rect(pt.x, pt.y, pt.r * 2, pt.r, pt.rot, pt.color[0], pt.color[1], pt.color[2], a);
    else if (pt.kind === "smoke")
      R.circle(pt.x, pt.y, pt.r, pt.color[0], pt.color[1], pt.color[2], a * 0.5);
    else if (pt.kind === "frag" && pt.spriteKey) {
      const fl = R.spriteLayer(pt.spriteKey);
      if (fl >= 0)
        R.spriteFragQuad(
          pt.x,
          pt.y,
          pt.r,
          pt.r,
          pt.rot,
          fl,
          pt.cellX ?? 0,
          pt.cellY ?? 0,
          1,
          1,
          1,
          a,
        );
    }
  }

  // --- zombies ---
  for (const z of state.zombies) {
    const grow = z.spawnT > 0 ? 1 - z.spawnT / 0.35 : 1; // 0..1 emerge
    const rad = z.r * (0.4 + 0.6 * grow);
    const wob = Math.sin(state.time * 7 + z.wob) * z.r * 0.05;
    const zx = z.x + wob;
    const zy = z.y + Math.cos(state.time * 6 + z.wob) * z.r * 0.04;
    const ft = nearestPlayer(state, z.x, z.y) ?? lp;
    const face = Math.atan2(ft.y - z.y, ft.x - z.x);
    const fl = z.flash > 0 ? z.flash / 0.12 : 0;
    // wound: bleed the body toward blood color + darken slightly as hp drops (persistent),
    // then layer the transient white hit-flash on top. The body is non-additive: out of cone it
    // dims to ambient (gloom), reading as a faint silhouette rather than a lit body — the dark's
    // tell is that shape, not the old diffuse additive halo (removed: it didn't fit the sprites).
    const wound = 1 - z.hp / z.maxHp;
    const gg = CONFIG.fx.gore;
    const dk = 1 - gg.woundDarken * wound;

    // Every enemy type has a required sprite (EnemyType.sprite + the enemies.test.ts coverage
    // guard), and the Phase-1 load gate guarantees the atlas is ready before any run draws — so
    // there is no SDF/eyes fallback path; a valid enemy always resolves to a sprite layer.
    const spriteKey = ENEMY_TYPES[z.type]?.sprite;
    const layer = spriteKey ? R.spriteLayer(spriteKey) : -1;
    if (layer >= 0) {
      // A textured sprite already has its own colors, so its tint is WHITE at full HP (true
      // illustration), darkening toward blood only as it's wounded. The hit-flash is a >1
      // overbright multiply (brightens the texel on hit). Normal pass (u_emissive 0) → still black
      // outside the flashlight cone.
      const flash = 1 + fl * SPRITE_FLASH;
      const tr = (1 + (gg.woundTint[0] - 1) * wound) * dk * flash;
      const tg = (1 + (gg.woundTint[1] - 1) * wound) * dk * flash;
      const tb = (1 + (gg.woundTint[2] - 1) * wound) * dk * flash;
      // Rotate so the illustration's front (its bottom, local -y) points at the target from any
      // direction — front-first approach. Drawn at SPRITE_SCALE× the hitbox (bare rad*2 mushes).
      const sz = rad * 2 * SPRITE_SCALE;
      R.spriteQuad(zx, zy, sz, sz, face + SPRITE_FACE_OFFSET, layer, tr, tg, tb, grow);
    }
  }

  // --- stalker ---
  if (state.stalker) {
    const sk = state.stalker;
    const skLayer = R.spriteLayer("stalker");
    if (skLayer >= 0) {
      // Brute radius is 27; stalker is a bit larger — use 32 as the logical hitbox radius for draw.
      const skRad = 32;
      const sz = skRad * 2 * SPRITE_SCALE;
      // White tint (true illustration); fade in on spawn via vis.
      R.spriteQuad(sk.x, sk.y, sz, sz, sk.face + SPRITE_FACE_OFFSET, skLayer, 1, 1, 1, sk.vis);
    }
    // Faint cold glow during the night phase — a silhouette that barely shows in gloom (the
    // lighting model means it reads as a cold shape, not a lit body). Matches the "gloom, not a
    // void" principle: the stalker is visible enough to be found, not an invisible wall.
    const isNight = state.phase === "night";
    if (isNight) {
      R.glow(sk.x, sk.y, 38, 0.3, 0.4, 0.9, 0.12 * sk.vis);
    }
  }

  // --- fake stalker silhouettes (Phase 1.5): dark, low-alpha, no hitbox; fade in/out over life ---
  if (phantoms.length) {
    const phLayer = R.spriteLayer("stalker");
    if (phLayer >= 0) {
      const phSz = 32 * 2 * SPRITE_SCALE; // same logical size as the real stalker draw
      for (const p of phantoms) {
        const u = 1 - p.life / p.maxLife; // 0 at spawn → 1 at death
        const a = Math.sin(Math.PI * u) * CONFIG.stalker.phantomAlphaMax; // fade in then out
        if (a <= 0) continue;
        // cold, near-black tint — reads as "a shape at the edge of the light," not a lit body
        R.spriteQuad(
          p.x,
          p.y,
          phSz,
          phSz,
          p.face + SPRITE_FACE_OFFSET,
          phLayer,
          0.14,
          0.17,
          0.3,
          a,
        );
      }
    }
  }

  // --- pickups (self-lit so they read in the dark; bob + blink before expiry) ---
  for (const pk of state.pickups) {
    const def = PICKUP_TYPES[pk.defId];
    if (!def) continue;
    const bob = Math.sin(state.time * 3 + pk.bob) * 3;
    const y = pk.y + bob;
    const fade = Math.min(1, pk.life / 2); // fade over the last 2s
    const blink = pk.life < 4 ? 0.55 + 0.45 * Math.sin(state.time * 12) : 1;
    const a = fade * blink;
    R.glow(pk.x, y, 28, def.glow[0], def.glow[1], def.glow[2], 0.55 * a);
    if (def.shape === "cross") {
      // medkit: a plus sign
      R.rect(pk.x, y, 16, 5, 0, def.color[0], def.color[1], def.color[2], a);
      R.rect(pk.x, y, 5, 16, 0, def.color[0], def.color[1], def.color[2], a);
    } else if (def.shape === "battery") {
      // battery: an upright cell with a little terminal nub
      R.rect(pk.x, y, 9, 15, 0, def.color[0], def.color[1], def.color[2], a);
      R.rect(pk.x, y - 9, 4, 3, 0, def.color[0], def.color[1], def.color[2], a);
    } else {
      // ammo: a slowly spinning crate
      R.rect(
        pk.x,
        y,
        13,
        13,
        state.time * 1.5 + pk.bob,
        def.color[0],
        def.color[1],
        def.color[2],
        a,
      );
    }
    R.ring(pk.x, y, 11, 0.02, 0.03, 0.02, 0.6 * a);
  }

  // --- bullets (tracer + glowing core) ---
  for (const b of state.bullets) {
    const mx = (b.x + b.px) / 2;
    const my = (b.y + b.py) / 2;
    const dxl = b.x - b.px;
    const dyl = b.y - b.py;
    const ln = Math.hypot(dxl, dyl) || b.r;
    const dir = Math.atan2(dyl, dxl);
    R.add(mx, my, ln + b.r * 2, 2.5, dir, b.color[0], b.color[1], b.color[2], 0.55, SHAPE.rect);
    R.glow(b.x, b.y, b.r * 3, b.color[0], b.color[1], b.color[2], 0.9);
    R.circle(b.x, b.y, b.r, 1, 0.96, 0.8, 1);
  }

  // --- players (local in TOXIC, teammates in their palette color + overhead HP) ---
  for (const pl of state.players) {
    if (pl.hp <= 0 || pl.absent) drawDownedPlayer(R, pl);
    else drawPlayer(R, pl, pl.id === state.localId);
  }
  drawReviveLinks(R);

  // --- additive particles (sparks / rings) ---
  for (const pt of state.particles) {
    const a = pt.life / pt.maxLife;
    if (pt.kind === "spark")
      R.glow(pt.x, pt.y, pt.r * 2.5, pt.color[0], pt.color[1], pt.color[2], a);
    else if (pt.kind === "ring")
      R.add(
        pt.x,
        pt.y,
        pt.r * 2,
        pt.r * 2,
        0,
        pt.color[0],
        pt.color[1],
        pt.color[2],
        a * 0.8,
        SHAPE.ring,
      );
  }

  // --- atmosphere: dust motes + darting shadows in the local cone ---
  drawAtmosphere(R, lp, ddt);

  // HP-driven grade (desaturation + dim) and blood vignette: both gated on state.running so a
  // dead player's 0 HP doesn't drain the debrief / title screens. When not running the cur vars
  // are held at whatever toTitle already snapped them to (1/1), and blood is zeroed so
  // the shader pass is skipped entirely.
  if (state.running) {
    // share cameraTarget and hpFrac with both grade and blood (different onset/gamma each)
    const cb = cameraTarget(state);
    const hpFrac = Math.max(0, cb.hp) / cb.maxHp;

    // HP→world grade: ease toward target frame-rate-independently
    const cg = integrityGrade(hpFrac, CONFIG.horror.desatOnset, CONFIG.horror.desatGamma);
    const satT = 1 - cg * (1 - CONFIG.horror.desatFloor);
    const dimT = 1 - cg * CONFIG.horror.desatDim;
    const k = reducedMotion ? 1 : 1 - Math.exp(-CONFIG.horror.desatEaseRate * ddt);
    gradeSatCur += (satT - gradeSatCur) * k;
    gradeDimCur += (dimT - gradeDimCur) * k;

    // blood vignette: same cb/hpFrac, different onset/gamma; heartbeat throb from local player
    const bloodG = integrityGrade(hpFrac, CONFIG.horror.bloodOnset, CONFIG.horror.bloodGamma);
    const bLow = lp.hp / lp.maxHp < CONFIG.horror.lowHp;
    // throb is bounded downstream in blood.frag (clamp on drive + alpha)
    const bPulse = bLow ? beatStrength * Math.exp(-(state.time - lastBeatT) * 7) : 0;
    R.setBlood(bloodG * CONFIG.horror.bloodMax, bPulse, reducedMotion ? 0 : state.time);
  } else {
    // not running (debrief / title / arsenal): keep grade at 1/1 (held by snap), zero blood
    R.setBlood(0, 0, state.time);
  }
  // always push the grade — held at 1/1 on non-running screens, eased during gameplay
  R.setGrade(gradeSatCur, gradeDimCur);

  R.flush(camX, camY);
}

/** Render a viz-part list (rect/circle/ring/hex/tri) at an origin, posed along `ang`. Shared by
 *  the weapon rig and overlay props — dispatch is shared, pose (origin/angle) is the caller's. */
function drawRigParts(
  R: typeof Renderer,
  parts: WeaponDef["viz"],
  ox: number,
  oy: number,
  ang: number,
  aMul: number,
  fwdScale: number,
): void {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  for (const part of parts) {
    const fwd = part.dx * fwdScale;
    const lat = part.dy;
    const wx = ox + ca * fwd - sa * lat;
    const wy = oy + sa * fwd + ca * lat;
    const [cr, cg, cb] = part.color ?? [1, 1, 1];
    const a = (part.alpha ?? 1) * aMul;
    const rot = ang + part.rot;
    switch (part.shape) {
      case "circle":
        R.circle(wx, wy, part.len / 2, cr, cg, cb, a);
        break;
      case "ring":
        R.ring(wx, wy, part.len / 2, cr, cg, cb, a);
        break;
      case "hex":
        R.hex(wx, wy, part.len / 2, rot, cr, cg, cb, a);
        break;
      case "tri":
        R.tri(wx, wy, part.len / 2, rot, cr, cg, cb, a);
        break;
      default:
        R.rect(wx, wy, part.len, part.wid, rot, cr, cg, cb, a);
        break;
    }
  }
}

/** Draw the held-weapon silhouette from its data-driven `viz` parts, posed by the draw-anim timer.
 *  Generic per-shape dispatch only — no per-weapon branches (CLAUDE.md). The whole rig dips toward
 *  the body mid-action, then extends and aligns to aim as rigPhase → 1 (reload or switch). */
function drawWeaponRig(
  R: typeof Renderer,
  px: number,
  py: number,
  aim: number,
  wd: WeaponDef,
  rigPhase: number, // 0 = lowered/mid-action, 1 = ready
): void {
  const e = 1 - (1 - rigPhase) * (1 - rigPhase);
  const DOWN = 0.6; // rad the rig dips off-aim mid-draw (sign may need flipping in dev — Y is flipped)
  const ang = aim + (1 - e) * DOWN; // dip while drawing → align when ready
  const fwdScale = 0.3 + 0.7 * e; // pulled in → full extension
  const aMul = 0.6 + 0.4 * e; // dimmed → full
  // parts default to wd.color when they carry no per-part color (drawRigParts falls back to
  // white, so pre-fill the weapon color here to preserve the original look)
  const parts = wd.viz.map((p) => ({ ...p, color: p.color ?? wd.color }));
  drawRigParts(R, parts, px, py, ang, aMul, fwdScale);
}

/** draw one player: body, gun, muzzle/reload/heal feedback; teammates get an overhead HP bar */
function drawPlayer(R: typeof Renderer, pl: Player, isLocal: boolean): void {
  const col = isLocal
    ? TOXIC
    : (PLAYER_COLORS[pl.id % PLAYER_COLORS.length] as [number, number, number]);
  const ch = deriveActionChannel(pl, state);
  const mot = actionMotion(ch.kind, ch.phase, state.time, CONFIG.actionFeel);
  // lean toward the aim focus; bob perpendicular to it
  const px = pl.x + pl.recoilX + Math.cos(pl.aim) * mot.lean - Math.sin(pl.aim) * mot.bob;
  const py = pl.y + pl.recoilY + Math.sin(pl.aim) * mot.lean + Math.cos(pl.aim) * mot.bob;
  const layer = R.spriteLayer("player");
  // No SDF fallback: the "player" sprite is a REQUIRED_SPRITES asset (guarded by
  // spriteAssets.test.ts), so layer < 0 only happens for the first frames before the atlas
  // finishes decoding — skip the body draw then rather than flash a placeholder circle.
  if (layer >= 0) {
    // Teammates keep a faint palette halo so they stay identifiable at a glance in co-op; the
    // local player gets none (the textured sprite carries its own colors — a body-tint halo read
    // as a green glow around your own character).
    if (!isLocal) R.glow(px, py, pl.r * 2.6, col[0], col[1], col[2], 0.3);
    // white tint = true illustration; layer a transient overbright on hit (a texture multiply
    // can't lerp to pure white like the SDF fill, but the pop reads). Rotated so the sprite's
    // front (its bottom, local -y) points along the aim from any direction.
    const flash = 1 + (pl.hitFlash > 0 ? Math.min(1, pl.hitFlash * 3) : 0) * SPRITE_FLASH;
    const sz = pl.r * 2 * SPRITE_SCALE;
    R.spriteQuad(px, py, sz, sz, pl.aim + SPRITE_FACE_OFFSET, layer, flash, flash, flash, 1);
  }
  if (pl.hitFlash > 0) R.glow(px, py, pl.r * 3.4, 1, 0.2, 0.2, Math.min(0.9, pl.hitFlash * 3));
  const heldWd = WEAPONS[pl.weapon];
  if (heldWd) {
    // reload and switch both lower→raise the rig; other kinds leave it ready (phase 1)
    const rigPhase = ch.kind === "switch" || ch.kind === "reload" ? ch.phase : 1;
    drawWeaponRig(R, px, py, pl.aim, heldWd, rigPhase);
  }
  if (pl.muzzle > 0) {
    const wd = WEAPONS[pl.weapon];
    if (wd?.melee) {
      // a single crescent blade-arc that SWEEPS across the swing cone. Phase comes from the
      // synced muzzle (1→0 over the swing window), so the arc reads the same for local, host,
      // and remote players. (In co-op a remote teammate's muzzle only refreshes at snapshot
      // rate, so the sweep is a touch steppier there — the same limitation the old fade had;
      // solo and your own swing are smooth at frame rate.)
      const k = Math.min(1, pl.muzzle / 0.1); // 1 at swing start → 0 at the end
      const reach = meleeReach(wd, pl.r);
      const arc = meleeArc(wd);
      const [cr, cg, cb] = wd.color;
      // the blade's leading edge travels from one rim of the cone to the other; its tips run
      // tangent to the arc, so as `sweep` rotates the crescent carves across the cone
      const sweep = pl.aim + arc * (2 * k - 1);
      const cx = px + Math.cos(sweep) * reach * 0.55;
      const cy = py + Math.sin(sweep) * reach * 0.55;
      R.slash(cx, cy, reach * 0.95, sweep, cr, cg, cb, 0.9 * k);
      R.glow(cx, cy, reach * 0.7, cr, cg, cb, 0.4 * k);
    } else {
      const tx = px + Math.cos(pl.aim) * pl.r * 1.7;
      const ty = py + Math.sin(pl.aim) * pl.r * 1.7;
      R.glow(tx, ty, pl.r * 1.6, 1, 0.9, 0.6, Math.min(1, pl.muzzle * 18));
    }
  }
  if (pl.reloadT > 0) {
    const wd = effWeapon(pl, pl.weapon);
    const prog = 1 - pl.reloadT / wd.reload;
    R.rect(pl.x, pl.y - pl.r - 12, 34 * prog, 4, 0, 1, 0.75, 0.2, 1);
  }
  // healing: breathing green aura + a medkit prop raised at the off-hand + rooted bob + bar
  if (pl.healT > 0) {
    const af = CONFIG.actionFeel;
    const prog = 1 - pl.healT / CONFIG.heal.duration;
    const pulse =
      af.heal.auraBase +
      af.heal.auraPulse * (0.5 + 0.5 * Math.sin(state.time * af.heal.auraPulseHz * Math.PI * 2));
    R.glow(px, py, pl.r * 3.4, 0.3, 1, 0.45, pulse);
    // medkit prop at the off-hand (lateral to aim): a white box + a green cross, via drawRigParts
    const ox = px - Math.sin(pl.aim) * af.propOffset;
    const oy = py + Math.cos(pl.aim) * af.propOffset;
    drawRigParts(R, MEDKIT_PROP, ox, oy, pl.aim, 1, 1);
    R.rect(pl.x, pl.y - pl.r - 12, 34 * prog, 4, 0, 0.3, 1, 0.45, 1);
  }
  // swing prop (repair=tool, mateHeal=medkit). ch.kind is never "mateHeal" while healT>0
  // (deriveActionChannel returns "heal"), so this never double-draws the heal prop.
  if (ch.kind === "repair" || ch.kind === "mateHeal") {
    const af = CONFIG.actionFeel;
    const ox = px - Math.sin(pl.aim) * af.propOffset;
    const oy = py + Math.cos(pl.aim) * af.propOffset;
    const prop = ch.kind === "repair" ? TOOL_PROP : MEDKIT_PROP;
    drawRigParts(R, prop, ox, oy, pl.aim + (1 - ch.phase) * 0.5, 1, 1); // slight swing rotation
  }
  // teammates: overhead HP bar + id tag so their state is readable at a glance
  if (!isLocal) {
    const f = Math.max(0, Math.min(1, pl.hp / pl.maxHp));
    const w = pl.r * 1.8;
    const yb = pl.y - pl.r - 10;
    R.rect(pl.x, yb, w, 3, 0, 0, 0, 0, 0.5);
    R.rect(pl.x - (w * (1 - f)) / 2, yb, w * f, 3, 0, 1 - f, 0.2 + 0.6 * f, 0.2, 0.95);
    R.number(pl.x, yb - 8, pl.id + 1, 11, col[0], col[1], col[2], 0.9);
  }
}

/** A downed player: a dim, additive ghost so allies can spot where someone fell even in
 *  near-black night (a plain circle would be swallowed by the low ambient). No gun/HP bar. */
function drawDownedPlayer(R: typeof Renderer, pl: Player): void {
  const col = (PLAYER_COLORS[pl.id % PLAYER_COLORS.length] as [number, number, number]) ?? TOXIC;
  R.glow(pl.x, pl.y, pl.r * 2.6, col[0], col[1], col[2], 0.4);
  R.ring(pl.x, pl.y, pl.r * 0.9, col[0] * 0.6, col[1] * 0.6, col[2] * 0.6, 0.5);
  // co-op revive progress: a green bar fills while a teammate tends this body
  if (pl.assistT > 0) {
    const f = Math.min(1, pl.assistT / CONFIG.assist.reviveTime);
    const w = 34;
    const yb = pl.y - pl.r - 10;
    R.rect(pl.x, yb, w, 4, 0, 0.05, 0.05, 0.05, 0.8);
    R.rect(pl.x - (w * (1 - f)) / 2, yb, w * f, 4, 0, 0.3, 1, 0.45, 1);
  }
}

/** Co-op: for each downed teammate being revived, draw a tending aura on the body + a faint beam
 *  from the nearest standing teammate (the reviver). Purely derived — no synced reviver id. */
function drawReviveLinks(R: typeof Renderer): void {
  if (state.players.length < 2) return;
  const af = CONFIG.actionFeel.revive;
  const reach2 = CONFIG.siege.interactRadius * CONFIG.siege.interactRadius;
  for (const t of state.players) {
    if (t.hp > 0 || t.absent || t.assistT <= 0) continue;
    const prog = Math.min(1, t.assistT / CONFIG.assist.reviveTime);
    const pulse = af.beamAlpha * (0.6 + 0.4 * Math.sin(state.time * af.auraPulseHz * Math.PI * 2));
    R.glow(t.x, t.y, t.r * 3, 0.4, 1, 0.6, pulse); // tending aura on the body
    // nearest standing teammate = the reviver; draw a faint beam
    let rv: Player | null = null;
    let best = reach2;
    for (const h of state.players) {
      if (h === t || h.hp <= 0 || h.absent) continue;
      const d = (h.x - t.x) ** 2 + (h.y - t.y) ** 2;
      if (d < best) {
        best = d;
        rv = h;
      }
    }
    if (rv) {
      const mx = (rv.x + t.x) / 2;
      const my = (rv.y + t.y) / 2;
      R.glow(mx, my, 8 + 10 * prog, 0.4, 1, 0.6, pulse * 0.8);
    }
  }
}

/** draw a segment as an oriented rect of the given thickness */
function drawSeg(
  R: typeof Renderer,
  s: { x1: number; y1: number; x2: number; y2: number },
  thick: number,
  r: number,
  g: number,
  b: number,
  a = 1,
): void {
  const cx = (s.x1 + s.x2) / 2;
  const cy = (s.y1 + s.y2) / 2;
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  R.rect(cx, cy, Math.hypot(dx, dy) + thick, thick, Math.atan2(dy, dx), r, g, b, a);
}

/** draw the f-fraction of a segment from its start, as a thin bar (HP indicator) */
function drawSegFrac(
  R: typeof Renderer,
  s: { x1: number; y1: number; x2: number; y2: number },
  f: number,
  r: number,
  g: number,
  b: number,
): void {
  const fx = s.x1 + (s.x2 - s.x1) * f;
  const fy = s.y1 + (s.y2 - s.y1) * f;
  drawSeg(R, { x1: s.x1, y1: s.y1, x2: fx, y2: fy }, 3, r, g, b, 0.95);
}

function drawShelter(R: typeof Renderer): void {
  for (const w of state.walls) drawSeg(R, w, 14, 0.32, 0.34, 0.33);
  for (const bar of state.barricades) {
    if (bar.hp <= 0) continue;
    const f = bar.hp / bar.maxHp;
    const fl = bar.flash > 0 ? bar.flash / 0.12 : 0;
    // healthy wood → splintered red as it takes damage, flashing white on a hit
    let r = 0.55 + (1 - f) * 0.35;
    let g = 0.4 * f + 0.06;
    let b = 0.2 * f + 0.04;
    r += (1 - r) * fl;
    g += (1 - g) * fl;
    b += (1 - b) * fl;
    drawSeg(R, bar, 4 + 7 * f, r, g, b);
    // overlaid HP bar so damage is unmistakable
    if (f < 1) {
      drawSeg(R, bar, 3, 0.05, 0.05, 0.05, 0.8); // dark track
      drawSegFrac(R, bar, f, 1 - f, 0.3 + 0.6 * f, 0.15); // red→green fill
    }
  }
}

/** Placed fortifications: supply stations (pulsing crate) and auto-sentries (base + barrel). */
function drawDeployables(R: typeof Renderer): void {
  for (const d of state.deployables) {
    const def = DEPLOYABLE_TYPES[d.defId];
    if (!def) continue;
    const [r, g, b] = def.color;
    if (!deployableSeen.has(d.id)) deployableSeen.set(d.id, state.time);
    const age = state.time - (deployableSeen.get(d.id) ?? state.time);
    const emerge = Math.min(1, age / CONFIG.actionFeel.deploy.emerge); // 0..1
    if (emerge < 1) {
      const k = 1 - emerge;
      R.ring(d.x, d.y, 30 * k + 8, r, g, b, 0.6 * k); // settling landing ring
      R.glow(d.x, d.y, 24, r, g, b, 0.5 * k); // spawn-in flash, fades to nothing
    }
    const visual = def.visual ?? (def.movement ? "drone" : def.emitter ? "crate" : "turret");
    if (visual === "drone") {
      // an airborne quad: a ground shadow stays put while the body bobs above it. The bob is
      // purely time-based with a per-id phase offset to desync multiple drones — folding d.x
      // into the phase (as before) coupled the vertical bob to the horizontal orbit, so it
      // hitched as the drone swept around the ring.
      const by = d.y + Math.sin(state.time * 4 + d.id * 2.399) * 3;
      R.circle(d.x, d.y, 8, 0, 0, 0, 0.28); // shadow (no bob)
      const af = d.ammoFrac ?? 1;
      const lowBlink = af < 0.2 ? 0.4 + 0.6 * Math.abs(Math.sin(state.time * 8)) : 1;
      R.glow(d.x, by, 18, r, g, b, (d.reloading ? 0.2 : 0.4) * lowBlink); // dimmed scanner
      R.ring(d.x, by, 13 * af + 3, r, g, b, 0.5 * lowBlink); // shrinks as ammo depletes
      // chassis: two arms crossing in an X (oriented to aim) + a small core
      const arm = 11;
      R.rect(d.x, by, arm * 2, 2.5, d.aim + Math.PI / 4, r, g, b, 0.85);
      R.rect(d.x, by, arm * 2, 2.5, d.aim - Math.PI / 4, r, g, b, 0.85);
      R.hex(d.x, by, 5, state.time * 1.5, r, g, b, 1); // core body
      // four rotors at the arm tips; a fast-spinning tri reads as blade blur
      const rot = state.time * 14;
      for (const off of [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4]) {
        const rx = d.x + Math.cos(d.aim + off) * arm;
        const ry = by + Math.sin(d.aim + off) * arm;
        R.ring(rx, ry, 4, r, g, b, 0.7); // rotor housing
        R.tri(rx, ry, 3.5, rot, r, g, b, 0.5); // blade blur
      }
      // forward camera eye; dims while reloading (reloading is snapshot-synced, targetId is not)
      const ex = d.x + Math.cos(d.aim) * 9;
      const ey = by + Math.sin(d.aim) * 9;
      R.glow(ex, ey, 6, r, g, b, d.reloading ? 0.3 : 0.8);
      drawDeployableHp(R, d, d.x, by);
    } else if (visual === "crate") {
      // supply station: a glowing crate with a beacon that ramps toward each drop. Phase from
      // state.time (synced on host & client); the emitter drops on the same state.time grid
      // (see tickEmitter), so the beacon ramp peaks exactly as a drop lands — no host-only state.
      const interval = def.emitter?.interval ?? 8;
      const frac = (state.time % interval) / interval; // 0..1 toward the next drop
      const beacon = 0.3 + 0.6 * frac * frac; // ramps brighter as the drop nears
      R.glow(d.x, d.y, 24, r, g, b, 0.3 + beacon * 0.3);
      R.rect(d.x, d.y, 20, 16, 0, 0.5, 0.42, 0.26, 1); // crate body
      R.rect(d.x, d.y, 20, 4, 0, r, g, b, 0.9); // colour band
      // corner bolts
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          R.rect(d.x + sx * 8, d.y + sy * 6, 2.5, 2.5, 0, r, g, b, 0.8);
        }
      }
      // supply mark: a small cross on the top face
      R.rect(d.x, d.y, 7, 2, 0, 0.9, 0.9, 0.85, 0.9);
      R.rect(d.x, d.y, 2, 7, 0, 0.9, 0.9, 0.85, 0.9);
      // beacon light on top, flashes as the drop nears
      R.glow(d.x, d.y - 12, 5, r, g, b, beacon);
      R.ring(d.x, d.y, 12, r, g, b, 0.7);
      drawDeployableHp(R, d, d.x, d.y);
    } else {
      // turret: tripod base + rotating housing + twin barrels that track the target
      R.glow(d.x, d.y, 26, r, g, b, d.reloading ? 0.2 : 0.4);
      // tripod: three static splayed struts under the base
      for (const leg of [
        Math.PI / 2,
        Math.PI / 2 + (2 * Math.PI) / 3,
        Math.PI / 2 + (4 * Math.PI) / 3,
      ]) {
        R.rect(d.x + Math.cos(leg) * 9, d.y + Math.sin(leg) * 9, 10, 3.5, leg, 0.28, 0.3, 0.32, 1);
      }
      R.circle(d.x, d.y, 12, 0.18, 0.2, 0.22, 1); // base plate (matches collider radius)
      R.ring(d.x, d.y, 12, r, g, b, 0.8);
      R.hex(d.x, d.y, 7, d.aim, r, g, b, 1); // rotating housing
      // twin barrels along aim, offset perpendicular so it reads as a gun not a stick
      const px = Math.cos(d.aim + Math.PI / 2);
      const py = Math.sin(d.aim + Math.PI / 2);
      const bx = d.x + Math.cos(d.aim) * 14;
      const barrelY = d.y + Math.sin(d.aim) * 14;
      R.rect(bx + px * 3, barrelY + py * 3, 20, 3.5, d.aim, r, g, b, 1);
      R.rect(bx - px * 3, barrelY - py * 3, 20, 3.5, d.aim, r, g, b, 1);
      // muzzle glow at the barrel tips; dims while reloading
      const mx = d.x + Math.cos(d.aim) * 24;
      const my = d.y + Math.sin(d.aim) * 24;
      R.glow(mx, my, d.reloading ? 4 : 7, r, g, b, d.reloading ? 0.2 : 0.5);
      drawDeployableHp(R, d, d.x, d.y);
    }
  }
  if (deployableSeen.size > 64) {
    const live = new Set(state.deployables.map((d) => d.id));
    for (const id of deployableSeen.keys()) if (!live.has(id)) deployableSeen.delete(id);
  }
}

/** A small HP bar above a damaged deployable (hidden at full / for indestructible units). */
function drawDeployableHp(
  R: typeof Renderer,
  d: State["deployables"][number],
  x: number,
  y: number,
): void {
  if (d.hpFrac >= 1) return;
  const f = Math.max(0, d.hpFrac);
  R.rect(x, y - 16, 22, 3, 0, 0.05, 0.05, 0.05, 0.8);
  R.rect(x - (22 * (1 - f)) / 2, y - 16, 22 * f, 3, 0, 1, 0.3, 0.2, 1);
}

function drawCaches(R: typeof Renderer): void {
  for (const c of state.caches) {
    if (c.looted) {
      // emptied: a dim open crate
      R.rect(c.x, c.y, 20, 16, 0, 0.18, 0.16, 0.12, 1);
      R.ring(c.x, c.y, 12, 0.1, 0.09, 0.07, 0.6);
      continue;
    }
    const bob = Math.sin(state.time * 2.5 + c.x) * 1.5;
    R.glow(c.x, c.y + bob, 26, 0.7, 0.6, 0.3, 0.4);
    R.rect(c.x, c.y + bob, 22, 17, 0, 0.55, 0.46, 0.28, 1);
    R.rect(c.x, c.y + bob, 22, 4, 0, 0.4, 0.33, 0.2, 1); // lid line
    R.ring(c.x, c.y + bob, 13, 0.9, 0.8, 0.4, 0.7);
    // rattling lid + search progress bar while being rummaged
    if (c.searchT > 0) {
      const af = CONFIG.actionFeel.search;
      const rattle = Math.sin(state.time * af.digHz * Math.PI * 2) * af.lidRattle;
      R.rect(c.x + rattle, c.y + bob - 6, 22, 4, 0, 0.4, 0.33, 0.2, 1); // rattling lid
      const f = Math.min(1, c.searchT / effectiveSearchTime(state.phase));
      R.rect(c.x, c.y - 20, 30, 4, 0, 0.05, 0.05, 0.05, 0.8);
      R.rect(c.x - (30 * (1 - f)) / 2, c.y - 20, 30 * f, 4, 0, 0.3, 1, 0.45, 1);
    }
  }
}

/* ----------------------------- HUD ------------------------------ */
let lastWeapon = "";
export function updateHUD(): void {
  const p = localPlayer(state);
  const wd = effWeapon(p, p.weapon);
  // HP→world grade (desaturation + dim) now lives entirely in draw() via R.setGrade, driven
  // frame-rate-independently with an eased cur value. No CSS filter writes here.
  el("wave").textContent = String(state.day);
  el("weapon-name").textContent = wd.name + (p.reloadT > 0 ? " · RELOADING" : "");
  const reserve = p.reserve[p.weapon] ?? 0;
  if (wd.melee) {
    el("ammo-val").textContent = "∞";
    el("mag-val").textContent = "—";
    el("reserve-val").textContent = "—";
  } else {
    el("ammo-val").textContent = String(p.ammo);
    el("mag-val").textContent = String(wd.mag);
    el("reserve-val").textContent = String(reserve);
  }
  // low-ammo warning: empty mag, or total rounds below a mag's worth
  const totalAmmo = p.ammo + reserve;
  const lowAmmo = !wd.melee && wd.mag > 0 && (p.ammo === 0 || totalAmmo < wd.mag);
  el("ammo").classList.toggle("low", lowAmmo);

  // medkits
  el("medkit-val").textContent = String(p.medkits);
  el("medkit").classList.toggle("empty", p.medkits <= 0);

  // deploy queue: bought-but-unplaced fortifications. Q drops the front (▸) at your feet.
  // Grouped by type in purchase order, so the first token is what places next.
  if (p.deployQueue.length === 0) {
    hide("deploybar");
  } else {
    show("deploybar");
    const counts = new Map<string, number>();
    for (const id of p.deployQueue) counts.set(id, (counts.get(id) ?? 0) + 1);
    el("deploy-q").textContent = `▸ ${[...counts]
      .map(([id, n]) => `${DEPLOYABLE_TYPES[id]?.name ?? id} ×${n}`)
      .join(" · ")}`;
  }

  // day/night phase — an in-game clock; the dial fills toward dusk (day) / dawn (night).
  // During breached/resetting the clock is meaningless (phaseT runs against breachedDuration /
  // resettingDuration, not dayDuration/nightDuration), so show a feel-appropriate fixed label instead.
  const phaseEl = el("phase");
  const night = state.phase === "night";
  if (state.phase === "breached") {
    phaseEl.textContent = `FORTRESS FALLEN · DAY ${state.day}`;
    phaseEl.classList.toggle("night", true);
  } else if (state.phase === "resetting") {
    phaseEl.textContent = `REBUILDING… · DAY ${state.day}`;
    phaseEl.classList.toggle("night", true);
  } else {
    phaseEl.textContent = `${night ? "NIGHT" : "DAY"} ${state.day} · ${clockLabel(state.phase, state.phaseT, state.day)}`;
    phaseEl.classList.toggle("night", night);
  }
  const dial = el("clock-dial");
  dial.classList.toggle("night", night);
  dial.style.setProperty("--frac", String(clockFrac(state.phase, state.phaseT, state.day)));

  // contextual interact prompt (repair barricade / search cache)
  const ip = interactPrompt();
  const promptEl = el("prompt");
  promptEl.textContent = ip ?? "";
  promptEl.classList.toggle("show", ip !== null);

  el("money").textContent = String(p.money);
  // weapon slot highlight — indexed by LOADOUT position (slot-0 = loadout[0], etc.)
  // so a loadout that isn't a WEAPON_ORDER prefix still highlights the right slot.
  const loadoutNow = getSettings().loadout;
  if (p.weapon !== lastWeapon) {
    lastWeapon = p.weapon;
    for (let i = 0; i < loadoutNow.length; i++) {
      const slot = document.getElementById(`slot-${i}`);
      if (slot) slot.classList.toggle("active", loadoutNow[i] === p.weapon);
    }
  }
  // update per-slot ammo every frame (mag drains per shot, not just on switch)
  updateHotbarAmmo(p);

  // damage flash overlay
  const fl = el("flash");
  fl.style.opacity = String(Math.min(0.6, flashT));
  fl.style.background = `radial-gradient(circle at 50% 50%, transparent 40%, rgba(${Math.round(flashColor[0] * 255)},${Math.round(flashColor[1] * 255)},${Math.round(flashColor[2] * 255)},0.9) 100%)`;

  // downed spectator banner (co-op): you're out until the next dawn
  el("downed").classList.toggle("show", p.hp <= 0);

  // Mobile action buttons: only shown under body.mobile while in an active run (not in shop)
  if (document.body.classList.contains("mobile") && state.running && !shopOpen) {
    show("action-btns");
    // Heal: always visible; show medkit count
    el("btn-heal-count").textContent = `×${p.medkits}`;
    // Fortify: visible only when the local player has a queued deployable
    const hasFortify = p.deployQueue.length > 0;
    if (hasFortify) show("btn-fortify");
    else hide("btn-fortify");
    // Repair: visible when near a damaged barricade (reuse the interactPrompt logic)
    const hasRepair = ip === "[E] repair";
    if (hasRepair) show("btn-repair");
    else hide("btn-repair");
  } else {
    hide("action-btns");
  }
}

/* --------------------------- FLOW / UI -------------------------- */

/**
 * Update per-slot ammo/reserve text for all hotbar slots.
 * Active weapon uses p.ammo; inactive weapons use p.mags[id] (saved mag).
 */
function updateHotbarAmmo(p: Player): void {
  const loadout = getSettings().loadout;
  for (let i = 0; i < loadout.length; i++) {
    const id = loadout[i] as string;
    const w = WEAPONS[id];
    if (!w) continue;
    const ammoEl = document.getElementById(`slot-${i}-ammo`);
    if (!ammoEl) continue;
    if (w.melee) {
      ammoEl.textContent = "∞";
    } else {
      const mag = id === p.weapon ? p.ammo : (p.mags[id] ?? 0);
      const rsv = p.reserve[id] ?? 0;
      ammoEl.textContent = `${mag}·${rsv}`;
    }
  }
}

/** Build the HUD weapon hotbar from the loadout (≤3 slots, indexed by loadout position). */
function buildWeaponSlots(): void {
  const row = el("weapons-row");
  row.innerHTML = "";
  const loadout = getSettings().loadout;
  for (let i = 0; i < loadout.length; i++) {
    const id = loadout[i] as string;
    if (!state.owned[id]) continue;
    const w = WEAPONS[id];
    if (!w) continue;
    const s = document.createElement("span");
    s.className = "wslot";
    s.id = `slot-${i}`;
    // icon color: use the weapon's defined color (first viz part or weapon color)
    const [r, g, b] = w.color;
    s.style.setProperty(
      "--wslot-color",
      `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`,
    );
    const label = document.createElement("span");
    label.className = "wslot-name";
    label.textContent = `${i + 1} ${w.name}`;
    const ammoSpan = document.createElement("span");
    ammoSpan.className = "wslot-ammo";
    ammoSpan.id = `slot-${i}-ammo`;
    ammoSpan.textContent = "";
    s.appendChild(label);
    s.appendChild(ammoSpan);
    // tap → weaponSlot via resolveHotbarSlot → same path as number keys
    const hotbarIndex = i;
    s.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // don't also trigger canvas stick
      const absSlot = resolveHotbarSlot(getSettings().loadout, WEAPON_ORDER, hotbarIndex);
      if (absSlot !== null) Input.touchWeaponSlot = absSlot;
    });
    row.appendChild(s);
  }
  lastWeapon = ""; // force a re-highlight on the next HUD tick
}

/**
 * Full per-row signature: index + id + price + desc — every mutable thing `create` renders into a
 * row. Used as the renderList key for Fortify rows.
 */
const shopRowSig = (it: StoreItem, i: number): string => `${i}:${it.id}:${it.price}:${it.desc}`;

function renderShop(): void {
  const me = localPlayer(state);
  el("shop-credits").textContent = String(me.money);
  const freeLeft = Math.max(0, CONFIG.arsenal.freePicks - me.draftFreePicksUsed);
  el("shop-free").textContent =
    freeLeft > 0 ? `${freeLeft} free pick${freeLeft > 1 ? "s" : ""}` : "free picks used";

  // draft cards (from this player's offer)
  const cards = me.draftOffer
    .map((id) => cardItem(state, me, id))
    .filter((it): it is StoreItem => it !== undefined);
  const cardKey = (it: StoreItem) =>
    `${it.id}:${it.price}:${me.draftFreePicksUsed < CONFIG.arsenal.freePicks ? 1 : 0}`;
  renderList(el("draft-cards"), cards, cardKey, (it, i) => {
    const free = me.draftFreePicksUsed < CONFIG.arsenal.freePicks;
    const able = free || it.canBuy(state, me);
    const d = document.createElement("div");
    d.className = `dcard${able ? "" : " off"}`;
    const kind = it.id.startsWith("lvl:") ? "Weapon" : "Perk";
    const cost = free
      ? `<span class='dpick'>FREE</span>`
      : `<span class='sprice'>${it.price}</span>`;
    d.innerHTML = `<div class='dtop'><span class='dnum'>${i + 1}</span><span class='dkind'>${kind}</span></div><div class='cname'>${it.name}</div><div class='desc'>${it.desc}</div><div class='dfoot'>${cost}</div>`;
    d.onclick = () => draftTake(it.id);
    return d;
  });

  // reroll button state
  const rc = rerollCost(me.draftRerolls);
  el("reroll-cost").textContent = String(rc);
  const rbtn = el<HTMLButtonElement>("rerollBtn");
  rbtn.onclick = () => draftReroll();
  rbtn.classList.toggle("off", me.money < rc || me.draftOffer.length === 0);

  // loadout selection strip (owned weapons this run)
  renderLoadout("shop-loadout", state.owned);

  // fortify list (deployables) — existing .srow look
  const forts = storeItems(state, me);
  renderList(el("choices"), forts, shopRowSig, (it) => {
    const able = it.canBuy(state, me);
    const d = document.createElement("div");
    d.className = `srow${able ? "" : " off"}`;
    d.innerHTML = `<div class='sinfo'><div class='cname'>${it.name}</div><div class='desc'>${it.desc}</div></div><div class='sprice'>${it.price}</div>`;
    d.onclick = () => buyItem(it.id);
    return d;
  });
}

/** Buy a Fortify (deployable) item by id. Client → CoopEvent request; the DO applies authoritatively. */
export function buyItem(itemId: string): void {
  if (!shopOpen) return;
  Net.client?.requestBuy(itemId);
  Audio.ui(true);
}

/**
 * Place the next queued deployable at the local player's feet. On a client this ships a
 * reliable request to the DO (the placement + queue decrement arrive via the snapshot);
 * the DO applies it authoritatively. Gating (alive, day-only at the fortress, etc.) is done by
 * the caller in main.ts.
 */
export function deployPlace(): void {
  Net.client?.requestPlace();
  Audio.ui(true);
}

/** Take a draft card. Ships a request to the DO (applied authoritatively). */
export function draftTake(cardId: string): void {
  if (!shopOpen) return;
  Net.client?.requestDraftTake(cardId);
  Audio.ui(true);
}

/** Reroll the local player's draft offer. Ships a request to the DO (applied authoritatively). */
export function draftReroll(): void {
  if (!shopOpen) return;
  Net.client?.requestDraftReroll();
  Audio.ui(true);
}

/** Close this client's shop overlay (day-start already happened on the DO at dawn). Local only. */
export function shopDeploy(): void {
  if (!shopOpen) return;
  Audio.ui(true);
  closeShopOverlay();
}

/**
 * Reconcile the shop overlay with `shopOpen` every frame (all modes). Clients open it
 * locally when they interact with the workbench. renderShop is called each frame while open —
 * renderList diffs so only changed cards rebuild.
 */
export function syncShopUI(): void {
  const open = shopOpen;
  const shown = shopVisible();
  if (open && !shown) {
    el("shop-wave").textContent = String(state.day);
    show("shop");
  } else if (!open && shown) {
    hide("shop");
    return;
  }
  if (open) renderShop();
}

/** Apply a dawn SALVAGE payout: bank this player's share to their cross-run meta. The arena
 *  keeps cycling — there is no game-over in the living arena. */
export function clientBanked(salvage: number): void {
  addSalvage(salvage);
}

/** Back to the title screen (so the player can spend SALVAGE before redeploying). */
export function toTitle(): void {
  hide("over");
  hide("shop");
  hide("hud");
  hide("lobby");
  hide("coop");
  // snap grade to full color so title / arsenal show no desaturation bleed-through
  gradeSatCur = 1;
  gradeDimCur = 1;
  renderArsenal();
  show("start");
}

/**
 * Drop unowned ids from the loadout; if that empties it, reset to DEFAULT_LOADOUT ∩ owned.
 * Call at run start and whenever ownership changes (e.g. after renderArsenal/unlock).
 */
function reconcileLoadout(owned: Record<string, boolean>): void {
  const filtered = getSettings().loadout.filter((id) => owned[id]);
  if (filtered.length > 0) {
    setLoadout(filtered);
  } else {
    const fallback = DEFAULT_LOADOUT.filter((id) => owned[id]);
    setLoadout(fallback.length > 0 ? fallback : DEFAULT_LOADOUT.slice(0, 1));
  }
}

/**
 * Render the loadout chip strip into `containerId`. Each chip toggles its weapon id in the
 * persistent loadout (capped at MAX_LOADOUT; over-cap attempts shake the chip).
 * `owned` is the set of weapon ids available this screen (meta.unlocked for arsenal, state.owned for shop).
 */
function renderLoadout(containerId: string, owned: Record<string, boolean>): void {
  const container = el(containerId);
  const currentLoadout = getSettings().loadout;
  // Build chips in WEAPON_ORDER for consistent ordering (knife included)
  const chips = WEAPON_ORDER.filter((id) => owned[id]);
  const sig = chips.map((id) => `${id}:${currentLoadout.includes(id) ? 1 : 0}`).join(",");
  if (container.dataset.lsig === sig) return; // no change — skip rebuild
  container.dataset.lsig = sig;
  container.innerHTML = "";
  for (const id of chips) {
    const w = WEAPONS[id];
    if (!w) continue;
    const active = currentLoadout.includes(id);
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `lchip${active ? " active" : ""}`;
    chip.textContent = w.name;
    chip.onclick = () => {
      const loadout = getSettings().loadout;
      if (loadout.includes(id)) {
        // deselect
        setLoadout(loadout.filter((x) => x !== id));
      } else if (loadout.length < MAX_LOADOUT) {
        // select (maintain WEAPON_ORDER)
        const next = WEAPON_ORDER.filter((wid) => loadout.includes(wid) || wid === id);
        setLoadout(next.slice(0, MAX_LOADOUT));
      } else {
        // at cap — shake the chip briefly as feedback
        chip.classList.add("shake");
        chip.addEventListener("animationend", () => chip.classList.remove("shake"), { once: true });
        Audio.ui(false);
        return;
      }
      Audio.ui(true);
      // re-render this strip (and the sibling strip if both are visible)
      renderLoadout(containerId, owned);
    };
    container.appendChild(chip);
  }
}

/** Render the dedicated ARSENAL overlay: SALVAGE balance + WEAPONS and CARDS unlock groups. */
export function renderArsenal(): void {
  const meta = loadMeta();
  el("ars-bal").textContent = String(meta.salvage);

  const weaponRows = UNLOCKABLE.flatMap((u) => {
    const w = WEAPONS[u.id];
    if (!w) return [];
    const owned = !!meta.unlocked[u.id];
    return [
      { id: u.id, price: u.price, name: w.name, owned, able: !owned && meta.salvage >= u.price },
    ];
  });
  const cardRows = UNLOCKABLE_CARDS.flatMap((c) => {
    const perkId = c.id.slice("card:".length);
    const u = UPGRADES.find((x) => x.id === perkId);
    if (!u) return [];
    const owned = !!meta.unlocked[c.id];
    return [
      { id: c.id, price: c.price, name: u.name, owned, able: !owned && meta.salvage >= c.price },
    ];
  });

  const draw = (boxId: string, rows: typeof weaponRows) =>
    renderList(
      el(boxId),
      rows,
      (r) => `${r.id}:${r.owned}:${r.able}`,
      (r) => {
        const d = document.createElement("div");
        d.className = `arow${r.owned ? " owned" : r.able ? "" : " off"}`;
        d.innerHTML = r.owned
          ? `<div class='cname'>${r.name}</div><div class='atag'>UNLOCKED</div>`
          : `<div class='cname'>${r.name}</div><div class='aprice'>${r.price} &#9670;</div>`;
        if (!r.owned && r.able) d.onclick = () => unlockNode(r.id, r.price);
        return d;
      },
    );
  draw("ars-weapons", weaponRows);
  draw("ars-cards", cardRows);

  // Build the owned map from meta (unlocked + starters are always owned between runs)
  const ownedForArsenal: Record<string, boolean> = {};
  for (const id of WEAPON_ORDER) {
    // A weapon is available in the arsenal if it's a starter or has been unlocked
    const isUnlockable = UNLOCKABLE.some((u) => u.id === id);
    if (!isUnlockable || meta.unlocked[id]) ownedForArsenal[id] = true;
  }
  reconcileLoadout(ownedForArsenal);
  renderLoadout("ars-loadout", ownedForArsenal);
}

function unlockNode(id: string, price: number): void {
  if (buyUnlock(id, price)) {
    Audio.ui(true);
    renderArsenal();
  } else {
    Audio.ui(false);
  }
}

/** Open the dedicated arsenal overlay from the title screen. */
export function openArsenal(): void {
  renderArsenal();
  show("arsenal-screen");
}

/** Close the dedicated arsenal overlay and return to the title screen. */
export function closeArsenal(): void {
  hide("arsenal-screen");
}

function shopVisible(): boolean {
  return !el("shop").classList.contains("hidden");
}

/** Context hint for the HUD. E acts on the nearest costed target (heal a hurt teammate /
 *  repair a wall); searching a cache is automatic (stand still), so it shows a passive hint. */
function interactPrompt(): string | null {
  const p = localPlayer(state);
  if (p.hp <= 0) return null; // downed: spectating, no interaction
  const reach = CONFIG.siege.interactRadius;

  let barD = reach;
  for (const b of state.barricades) {
    if (b.hp >= b.maxHp) continue;
    const d = Math.hypot((b.x1 + b.x2) / 2 - p.x, (b.y1 + b.y2) / 2 - p.y);
    if (d < barD) barD = d;
  }
  let mateD = reach;
  if (p.medkits >= 1) {
    for (const o of state.players) {
      if (o.id === p.id || o.absent || o.hp <= 0 || o.hp >= o.maxHp) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < mateD) mateD = d;
    }
  }
  // E targets the nearest of the two (matches interact())
  if (mateD < reach && mateD <= barD) return "[E] heal teammate";
  if (barD < reach) return "[E] repair";

  for (const c of state.caches) {
    if (c.looted) continue;
    if (Math.hypot(c.x - p.x, c.y - p.y) < reach) return "stand still to search";
  }
  return null;
}

// Flashlight toggle (F) and medkit use (H) are player actions driven through
// PlayerInput and applied in sysPlayer (so they route to the right player in MP).

/**
 * Client-mode boot: a renderable run-state with NO local sim (the host drives the
 * world via snapshots). Phase/day/economy all arrive over the wire; we just start a
 * fresh state for the static map (walls/barricades/caches are identical code) and show
 * the HUD. localId + owned/wlevel are filled in by the host's Hello.
 */
export function startClientGame(): void {
  // Defense-in-depth: `state = newState()` is destructive. A reconnect reuses the existing
  // Client (rebind), but if any path ever constructed a second Client mid-run its first
  // snapshot would wipe the live game — no-op here so only the first client boot builds state.
  if (state.running) return;
  state = newState();
  Renderer.setWalls(state.walls);
  deployableSeen.clear();
  state.running = true;
  lastWeapon = "";
  resetAtmosphere();
  Audio.resume();
  hide("start");
  hide("over");
  hide("shop");
  hide("lobby");
  hide("coop");
  show("hud");
  buildWeaponSlots();
}

/** Apply the host's Hello: adopt our player id and the shared weapon ownership. Per-player
 *  weapon levels (wlevel) are no longer shared — they arrive per player in the snapshot. */
export function clientApplyHello(localId: number, owned: Record<string, boolean>): void {
  state.localId = localId;
  state.owned = owned;
  buildWeaponSlots();
}
