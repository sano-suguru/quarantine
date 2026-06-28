import { CONFIG } from "./config";
import { effWeapon, type StoreItem, salvageEarned, storeItems } from "./data/arsenal";
import { DEPLOYABLE_TYPES, deployableCount, placeDeployable, placeSpot } from "./data/deployables";
import { PICKUP_TYPES } from "./data/pickups";
import { PLAYER_COLORS } from "./data/players";
import { UNLOCKABLE, WEAPON_ORDER, WEAPONS } from "./data/weapons";
import { Audio } from "./engine/audio";
import { anyAlive, localPlayer, nearestPlayer, revivePlayer } from "./engine/players";
import { Renderer, SHAPE } from "./engine/renderer";
import { addSalvage, buyUnlock, loadMeta } from "./meta";
import { Net } from "./net/net";
import { newState } from "./state";
import { sysAI } from "./systems/ai";
import { sysAssist } from "./systems/assist";
import { sysBullets } from "./systems/bullets";
import { sysCamera } from "./systems/camera";
import { sysDeployables } from "./systems/deployables";
import { flashlightIntensity } from "./systems/flashlight";
import { sysFx } from "./systems/fx";
import { sysPickups } from "./systems/pickups";
import { effectiveSearchTime, sysPlayer } from "./systems/player";
import { ambientForClock, clockFrac, clockLabel, startDay, sysSiege } from "./systems/siege";
import type { Player, State } from "./types";
import { el, hide, renderList, show } from "./ui";

let state: State = newState();

export function getState(): State {
  return state;
}

const TOXIC: [number, number, number] = [0.49, 1.0, 0.31];

/* -------------------------- UPDATE / DRAW ----------------------- */
let hbT = 0; // heartbeat timer
let groanT = 2; // ambient groan timer

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

// heartbeat→vignette pulse: set when a heartbeat fires, read (and decayed) in updateHUD
let lastBeatT = -10;
let beatStrength = 0;
// local flashlight die edge (battery → 0): play a one-shot "going dark" cue
let prevBattery = 1;

/** Reset the per-run atmosphere bookkeeping so stale zombie ids / darts don't carry across runs. */
function resetAtmosphere(): void {
  voiceMem.clear();
  recentVoices = [];
  darts = [];
  lastBeatT = -10;
  beatStrength = 0;
  prevBattery = 1;
}

export function update(dt: number): void {
  if (!state.running || state.paused) return;

  // hitstop: briefly slow the sim on impactful kills
  let sdt = dt;
  if (state.hitstopT > 0) {
    state.hitstopT -= dt;
    sdt = dt * CONFIG.feel.hitstopScale;
  }
  state.flashT *= Math.exp(-CONFIG.feel.flashDecay * dt);

  state.time += sdt;
  sysPlayer(state, sdt);
  sysAssist(state, sdt); // co-op proximity revive of downed teammates (no-op in single-player)
  sysAI(state, sdt);
  if (!anyAlive(state)) {
    gameOver();
    return;
  }
  sysDeployables(state, sdt); // turrets fire / stations emit (after AI so the zombie set is current)
  sysBullets(state, sdt);
  sysPickups(state, sdt);
  sysFx(state, sdt);
  const ev = sysSiege(state, sdt);
  sysCamera(state, sdt);
  audioAmbience(dt);
  if (ev === "night") {
    announce("NIGHT", state.day);
    Audio.waveStart();
  } else if (ev === "dawn") {
    Audio.dawn();
    openShop();
  }
}

function audioAmbience(dt: number): void {
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

  // local flashlight dying (battery → 0 while lit): a one-shot "going dark" cue. Edge-detected
  // from the local player's synced battery so it fires once on host/client/single alike.
  const batf = p.battery / CONFIG.flashlight.batteryMax;
  if (p.lightOn && prevBattery > 0 && batf <= 0) Audio.lightDie();
  prevBattery = batf;

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
 * Drive the looping ambience + rummage samples. Called once per rAF frame from main.ts (NOT from
 * update, which is skipped while paused) so loops correctly stop during pause/shop/title/gameover
 * and stay consistent across single/host/client (all share the render frame). Reads state only —
 * no mutation — so single-player stays byte-for-byte and clients drive it from the synced world.
 */
export function audioLoops(): void {
  const live = state.running && !state.paused;
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
  const lit = lp.lightOn && lp.battery > 0 && ambient < 0.2; // only meaningful in the dark
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
  // one aimed flashlight per living player — teammates' cones light the dark too
  R.beginLights();
  for (const pl of state.players) {
    if (pl.hp <= 0 || pl.absent) continue;
    const intensity = flashlightIntensity(
      pl.battery / flc.batteryMax,
      pl.lightOn,
      flc.lowThreshold,
      flc.flickerDepth,
      flc.baseFlickerDepth,
      flickerNoise(state.time, pl.id),
    );
    R.addLight(pl.x, pl.y, Math.cos(pl.aim), Math.sin(pl.aim), intensity);
  }
  R.begin();

  // --- ground: blood decals ---
  for (const d of state.decals) {
    const cap = CONFIG.fx.blood.maxAlpha;
    const a = Math.min(cap, (d.life / d.maxLife) * cap);
    R.circle(d.x, d.y, d.r, d.color[0], d.color[1], d.color[2], a);
  }

  // --- shelter: stone walls + boarded openings, world loot caches, fortifications ---
  drawShelter(R);
  drawCaches(R);
  drawDeployables(R);

  // --- normal particles (shards / smoke) ---
  for (const pt of state.particles) {
    const a = pt.life / pt.maxLife;
    if (pt.kind === "shard")
      R.rect(pt.x, pt.y, pt.r * 2, pt.r, pt.rot, pt.color[0], pt.color[1], pt.color[2], a);
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
    const col: [number, number, number] = [
      z.color[0] + (1 - z.color[0]) * fl,
      z.color[1] + (1 - z.color[1]) * fl,
      z.color[2] + (1 - z.color[2]) * fl,
    ];
    const pulse = z.type === "brute" ? 0.5 + 0.3 * Math.sin(state.time * 4) : 0.4;
    R.glow(
      zx,
      zy,
      rad * 2.1,
      z.glow[0],
      z.glow[1],
      z.glow[2],
      (0.3 + 0.4 * fl + pulse * 0.2) * grow,
    );

    if (z.shape === SHAPE.tri) R.tri(zx, zy, rad, face, col[0], col[1], col[2], grow);
    else if (z.shape === SHAPE.hex)
      R.hex(zx, zy, rad, state.time * 0.6 + z.wob, col[0], col[1], col[2], grow);
    else R.circle(zx, zy, rad, col[0], col[1], col[2], grow);
    // dark silhouette outline
    R.ring(zx, zy, rad * 1.04, 0.02, 0.03, 0.02, 0.7 * grow);

    // glowing eyes (appear even as it emerges from the dark)
    const ex = Math.cos(face);
    const ey = Math.sin(face);
    const px2 = -ey;
    const py2 = ex;
    const eo = rad * 0.42;
    const es = rad * 0.32;
    for (const s of [-1, 1]) {
      R.add(
        zx + ex * eo + px2 * es * s,
        zy + ey * eo + py2 * es * s,
        rad * 0.42,
        rad * 0.42,
        0,
        z.eye[0],
        z.eye[1],
        z.eye[2],
        0.9,
        SHAPE.glow,
      );
    }

    // hp bar
    const f = z.hp / z.maxHp;
    if (f < 1 && z.spawnT <= 0) {
      const w = z.r * 1.6;
      const by = z.y - z.r - 7;
      R.rect(z.x, by, w, 3, 0, 0, 0, 0, 0.5);
      R.rect(z.x - (w * (1 - f)) / 2, by, w * f, 3, 0, 0.9 - 0.6 * f, 0.2 + 0.6 * f, 0.15, 0.95);
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

  // --- floating damage numbers ---
  for (const t of state.texts) {
    const a = Math.min(1, t.life / t.maxLife);
    if (t.crit) R.number(t.x, t.y, t.value, 20, 1, 0.75, 0.2, a);
    else R.number(t.x, t.y, t.value, 13, 1, 1, 0.85, a * 0.9);
  }

  R.flush(camX, camY);
}

/** draw one player: body, gun, muzzle/reload/heal feedback; teammates get an overhead HP bar */
function drawPlayer(R: typeof Renderer, pl: Player, isLocal: boolean): void {
  const col = isLocal
    ? TOXIC
    : (PLAYER_COLORS[pl.id % PLAYER_COLORS.length] as [number, number, number]);
  const px = pl.x + pl.recoilX;
  const py = pl.y + pl.recoilY;
  R.glow(px, py, pl.r * 3, col[0], col[1], col[2], 0.55);
  R.circle(px, py, pl.r, col[0], col[1], col[2], 1);
  R.ring(px, py, pl.r * 0.6, 0.05, 0.18, 0.05, 0.9);
  if (pl.hitFlash > 0) R.glow(px, py, pl.r * 3.4, 1, 0.2, 0.2, Math.min(0.9, pl.hitFlash * 3));
  const bx = px + Math.cos(pl.aim) * pl.r * 0.9;
  const by = py + Math.sin(pl.aim) * pl.r * 0.9;
  R.rect(bx, by, pl.r * 1.4, 6, pl.aim, 0.85, 0.95, 0.8, 1);
  if (pl.muzzle > 0) {
    const wd = WEAPONS[pl.weapon];
    if (wd?.melee) {
      // a single crescent blade-arc that SWEEPS across the swing cone. Phase comes from the
      // synced muzzle (1→0 over the swing window), so the arc reads the same for local, host,
      // and remote players. (In co-op a remote teammate's muzzle only refreshes at snapshot
      // rate, so the sweep is a touch steppier there — the same limitation the old fade had;
      // solo and your own swing are smooth at frame rate.)
      const k = Math.min(1, pl.muzzle / 0.1); // 1 at swing start → 0 at the end
      const reach = (wd.meleeRange ?? 30) + pl.r;
      const arc = wd.meleeArc ?? 0.95;
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
  // healing: green aura + progress bar (you're rooted and exposed while it fills)
  if (pl.healT > 0) {
    const prog = 1 - pl.healT / CONFIG.heal.duration;
    R.glow(px, py, pl.r * 3.4, 0.3, 1, 0.45, 0.4);
    R.rect(pl.x, pl.y - pl.r - 12, 34 * prog, 4, 0, 0.3, 1, 0.45, 1);
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
    const visual = def.visual ?? (def.movement ? "drone" : def.emitter ? "crate" : "turret");
    if (visual === "drone") {
      // an airborne unit: a ground shadow stays put while the body bobs above it
      const by = d.y + Math.sin(state.time * 4 + d.x * 0.05) * 3;
      R.circle(d.x, d.y, 8, 0, 0, 0, 0.28); // shadow (no bob)
      R.glow(d.x, by, 18, r, g, b, d.reloading ? 0.2 : 0.45); // scanner; dims while reloading
      const rot = state.time * 9; // spinning rotor blades (ring() can't rotate)
      R.tri(d.x, by, 7, rot, r, g, b, 0.5);
      R.tri(d.x, by, 7, rot + 2.094, r, g, b, 0.5);
      R.tri(d.x, by, 7, rot + 4.189, r, g, b, 0.5);
      R.hex(d.x, by, 6, state.time * 2, r, g, b, 1);
      R.ring(d.x, by, 9, r, g, b, 0.7);
      R.rect(d.x + Math.cos(d.aim) * 10, by + Math.sin(d.aim) * 10, 12, 3, d.aim, r, g, b, 0.9);
      drawDeployableHp(R, d, d.x, by);
    } else if (visual === "crate") {
      // supply station: a glowing crate that pulses as it nears its next drop
      const pulse = 0.5 + 0.3 * Math.sin(state.time * 3 + d.x);
      R.glow(d.x, d.y, 24, r, g, b, 0.35 + pulse * 0.2);
      R.rect(d.x, d.y, 20, 16, 0, 0.5, 0.42, 0.26, 1);
      R.rect(d.x, d.y, 20, 4, 0, r, g, b, 0.9);
      R.ring(d.x, d.y, 12, r, g, b, 0.7);
      drawDeployableHp(R, d, d.x, d.y);
    } else {
      // turret: base + a barrel that tracks its target; glow dims while reloading
      R.glow(d.x, d.y, 26, r, g, b, d.reloading ? 0.2 : 0.4);
      R.circle(d.x, d.y, 11, 0.2, 0.22, 0.24, 1);
      R.ring(d.x, d.y, 11, r, g, b, 0.8);
      const bx = d.x + Math.cos(d.aim) * 14;
      const by = d.y + Math.sin(d.aim) * 14;
      R.rect(bx, by, 20, 5, d.aim, r, g, b, 1);
      drawDeployableHp(R, d, d.x, d.y);
    }
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
    // search progress bar
    if (c.searchT > 0) {
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
  const hpf = Math.max(0, p.hp) / p.maxHp;
  el("hpbar").style.width = `${100 * hpf}%`;
  el("hpbar").style.background = hpf < 0.3 ? "var(--blood)" : "var(--toxic)";
  el("hpnum").textContent = `${Math.max(0, Math.ceil(p.hp))} / ${p.maxHp}`;
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

  // flashlight battery
  const batf = p.battery / CONFIG.flashlight.batteryMax;
  el("batbar").style.width = `${100 * batf}%`;
  const batBlock = el("battery");
  batBlock.classList.toggle("low", p.lightOn && batf < CONFIG.flashlight.lowThreshold);
  batBlock.classList.toggle("off", !p.lightOn || p.battery <= 0);
  el("bat-state").textContent = !p.lightOn
    ? "OFF"
    : p.battery <= 0
      ? "DEAD"
      : `${Math.ceil(batf * 100)}%`;

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

  // day/night phase — an in-game clock; the dial fills toward dusk (day) / dawn (night)
  const phaseEl = el("phase");
  const night = state.phase === "night";
  phaseEl.textContent = `${night ? "NIGHT" : "DAY"} ${state.day} · ${clockLabel(state.phase, state.phaseT, state.day)}`;
  phaseEl.classList.toggle("night", night);
  const dial = el("clock-dial");
  dial.classList.toggle("night", night);
  dial.style.setProperty("--frac", String(clockFrac(state.phase, state.phaseT, state.day)));

  // contextual interact prompt (repair barricade / search cache)
  const ip = interactPrompt();
  const promptEl = el("prompt");
  promptEl.textContent = ip ?? "";
  promptEl.classList.toggle("show", ip !== null);

  el("money").textContent = String(p.money);
  // live hostile count — meaningful in both phases now that night survivors carry into the day
  el("remaining").textContent = String(state.zombies.length);

  // weapon slot highlight (slots are built per run from owned weapons)
  if (p.weapon !== lastWeapon) {
    lastWeapon = p.weapon;
    for (let i = 0; i < WEAPON_ORDER.length; i++) {
      const slot = document.getElementById(`slot-${i}`);
      if (slot) slot.classList.toggle("active", WEAPON_ORDER[i] === p.weapon);
    }
  }

  // dread vignette intensity
  const hud = el("hud");
  const low = hpf < CONFIG.horror.lowHp;
  hud.classList.toggle("low", low);
  // heartbeat-synced red pulse: a quick throb in time with the heartbeat audio (set in
  // audioAmbience). Decays from state.time so audio and visuals beat together.
  const pulse = low ? beatStrength * Math.exp(-(state.time - lastBeatT) * 7) : 0;
  el("dread-pulse").style.opacity = String(Math.min(0.5, pulse));

  // damage flash overlay
  const fl = el("flash");
  fl.style.opacity = String(Math.min(0.6, state.flashT));
  fl.style.background = `radial-gradient(circle at 50% 50%, transparent 40%, rgba(${Math.round(state.flashColor[0] * 255)},${Math.round(state.flashColor[1] * 255)},${Math.round(state.flashColor[2] * 255)},0.9) 100%)`;

  // downed spectator banner (co-op): you're out until the next dawn
  el("downed").classList.toggle("show", p.hp <= 0);

  // pause overlay is state-driven (so a host pause shows on every client via the
  // snapshot); the shop has its own overlay and also sets paused, so suppress it there.
  if (state.paused && !state.inShop) show("pause");
  else hide("pause");
}

/* --------------------------- FLOW / UI -------------------------- */
function announce(label: string, n: number): void {
  const b = el("banner");
  el("banner-label").textContent = label;
  el("banner-n").textContent = String(n);
  b.classList.remove("show");
  void b.offsetWidth; // reflow to restart animation
  b.classList.add("show");
}

/** Build the HUD weapon row from the weapons owned this run (number = hotkey). */
function buildWeaponSlots(): void {
  const row = el("weapons-row");
  row.innerHTML = "";
  for (let i = 0; i < WEAPON_ORDER.length; i++) {
    const id = WEAPON_ORDER[i] as string;
    if (!state.owned[id]) continue;
    const w = WEAPONS[id];
    if (!w) continue;
    const s = document.createElement("span");
    s.className = "wslot";
    s.id = `slot-${i}`;
    s.textContent = `${i + 1} ${w.name}`;
    row.appendChild(s);
  }
  lastWeapon = ""; // force a re-highlight on the next HUD tick
}

export function startGame(): void {
  state = newState();
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
  startDay(state);
  announce("DAY", state.day);
}

let shopItems: StoreItem[] = [];
let shopSel = 0;
let shopEls: HTMLElement[] = [];
let shopSig = ""; // store-list signature; a change means the DOM must be rebuilt

/**
 * Full per-row signature: index + id + price + desc — every mutable thing `create` renders into a
 * row (but NOT `.sel`/`.off`, which are view-state re-applied each frame by highlightShop /
 * syncShopUI). It drives BOTH the rebuild gate (shopSig) and the renderList key, so the two can't
 * disagree: a deploy row's live built/queued count lives in `desc`, so a buy flips both the sig
 * and the key, rebuilding just that row with fresh text on host and client alike.
 */
const shopRowSig = (it: StoreItem, i: number): string => `${i}:${it.id}:${it.price}:${it.desc}`;
const shopSigOf = (items: StoreItem[]): string => items.map(shopRowSig).join("|");

/** Authoritative: open the arsenal between nights (host/single sim). The overlay itself
 *  is shown by syncShopUI from `state.inShop`, so clients open it from the snapshot. */
function openShop(): void {
  state.inShop = true;
  state.paused = true;
  Audio.setDread(0.1);
  // dawn revival: anyone who fell during the night comes back for the shop + next day
  // (a survivor cleared the wave to reach here). Gear is kept; see revivePlayer.
  for (const p of state.players) if (p.hp <= 0) revivePlayer(state, p);
  resupply();
}

/**
 * Apply a purchase host-authoritatively. `buyer` is the player who paid (perks with
 * personal stats apply to them). Returns false (and changes nothing) if the shop is
 * closed, the buyer is gone (dead/left), or the item can't be afforded.
 */
export function applyBuy(s: State, itemId: string, buyer: Player | undefined): boolean {
  if (!s.inShop || !buyer) return false;
  const it = storeItems(s, buyer).find((x) => x.id === itemId);
  if (!it?.canBuy(s, buyer)) return false;
  buyer.money -= it.price;
  it.buy(s, buyer);
  return true;
}

/**
 * Place the front of `player`'s deploy queue at their feet (in front, along aim), host-
 * authoritatively. Returns false (consuming nothing) if the player is down, holds nothing,
 * the world is at the type's cap, or there's no valid spot. The hard cap is re-checked here
 * (the buy gate is only a per-player view), so co-op buy races can't exceed it.
 */
export function applyPlace(s: State, player: Player | undefined): boolean {
  if (!player || player.hp <= 0) return false;
  const defId = player.deployQueue[0];
  if (!defId) return false;
  const def = DEPLOYABLE_TYPES[defId];
  if (!def || deployableCount(s, defId) >= def.cap) return false;
  const spot = placeSpot(s, player, def);
  if (!spot) return false;
  placeDeployable(s, defId, spot.x, spot.y);
  player.deployQueue.shift();
  return true;
}

function renderShop(): void {
  const me = localPlayer(state);
  el("shop-credits").textContent = String(me.money);
  const box = el("choices");
  // Key (shopRowSig) carries index + id + price + desc — the full rendered content — so a reused
  // row always has correct text AND a correct captured `i`. `.sel`/`.off` are NOT in the key:
  // they're view-state re-applied each frame (highlightShop / syncShopUI), so only a genuine
  // content change rebuilds a row while the rest keep their hover.
  renderList(box, shopItems, shopRowSig, (it, i) => {
    const able = it.canBuy(state, me);
    const d = document.createElement("div");
    d.className = `srow${able ? "" : " off"}`;
    d.innerHTML = `<div class='snum'>${i + 1}</div><div class='sinfo'><div class='cname'>${it.name}</div><div class='desc'>${it.desc}</div></div><div class='sprice'>${it.price}c</div>`;
    d.onclick = () => buyItem(i);
    d.onmouseenter = () => {
      shopSel = i;
      highlightShop();
    };
    return d;
  });
  // Re-grab node refs, then let highlightShop own `.sel`: a reused row keeps its old node, so the
  // selection class must be (re)applied after every reconcile rather than baked into create.
  shopEls = Array.from(box.children) as HTMLElement[];
  highlightShop();
}

/** Update only the selection highlight — no DOM teardown, so clicks survive. */
function highlightShop(): void {
  shopEls.forEach((d, i) => {
    d.classList.toggle("sel", i === shopSel);
  });
}

export function shopMove(dir: number): void {
  if (!state.inShop || shopItems.length === 0) return;
  shopSel = (shopSel + dir + shopItems.length) % shopItems.length;
  Audio.ui(false);
  highlightShop();
}

/**
 * Buy the item at index `i`. On a client this just ships a request to the host (money,
 * levels and re-render arrive via the snapshot); on host/single it applies authoritatively
 * and rebuilds the list locally (prices/levels can change).
 */
export function buyItem(i: number): void {
  if (!state.inShop) return;
  const it = shopItems[i];
  if (!it) return;
  if (Net.mode === "client") {
    Net.client?.requestBuy(it.id);
    Audio.ui(true);
    return;
  }
  if (applyBuy(state, it.id, localPlayer(state))) {
    Audio.ui(true);
    shopItems = storeItems(state, localPlayer(state));
    shopSig = shopSigOf(shopItems);
    if (shopSel >= shopItems.length) shopSel = Math.max(0, shopItems.length - 1);
    renderShop();
  } else {
    Audio.ui(false);
  }
}

/**
 * Place the next queued deployable at the local player's feet. On a client this ships a
 * reliable request to the host (the placement + queue decrement arrive via the snapshot);
 * on host/single it applies authoritatively. Gating (alive, not in shop, etc.) is done by
 * the caller in main.ts.
 */
export function deployPlace(): void {
  if (Net.mode === "client") {
    Net.client?.requestPlace();
    Audio.ui(true);
    return;
  }
  Audio.ui(applyPlace(state, localPlayer(state)));
}

export function shopBuySelected(): void {
  if (state.inShop) buyItem(shopSel);
}

/**
 * Leave the arsenal and start the next day. Client → request to the host (idempotent);
 * host/single → authoritative transition. The overlay is hidden by syncShopUI.
 */
export function shopDeploy(): void {
  if (Net.mode === "client") {
    Net.client?.requestDeploy();
    return;
  }
  if (!state.inShop) return;
  Audio.ui(true);
  state.inShop = false;
  state.paused = false;
  state.day++;
  startDay(state);
  announce("DAY", state.day);
}

/**
 * Reconcile the shop overlay with `state.inShop` every frame (all modes). Clients open it
 * straight from the snapshot. While open we avoid tearing down the DOM each frame: only a
 * change in the item id-list triggers a full re-render; otherwise we cheaply refresh the
 * credits text and per-row affordance so hover/selection survive.
 */
export function syncShopUI(): void {
  const me = localPlayer(state);
  const open = state.inShop;
  const shown = shopVisible();
  if (open && !shown) {
    shopItems = storeItems(state, me);
    shopSig = shopSigOf(shopItems);
    shopSel = 0;
    el("shop-wave").textContent = String(state.day);
    renderShop();
    show("shop");
    return;
  }
  if (!open) {
    if (shown) hide("shop");
    return;
  }
  // open && shown: rebuild only if the item set changed, else a light refresh
  const items = storeItems(state, me);
  const sig = shopSigOf(items);
  if (sig !== shopSig) {
    shopItems = items;
    shopSig = sig;
    if (shopSel >= shopItems.length) shopSel = Math.max(0, shopItems.length - 1);
    renderShop();
  } else {
    el("shop-credits").textContent = String(me.money);
    shopEls.forEach((d, i) => {
      const it = shopItems[i];
      if (it) d.classList.toggle("off", !it.canBuy(state, me));
    });
  }
}

/** End the run on this machine: bank our salvage share and show the debrief. Shared by
 *  the host/single gameOver and the client's gameover-event handler. */
function endRun(salvage: number, day: number, kills: number, money: number): void {
  state.running = false;
  Audio.gameOver();
  Audio.stopDread();
  addSalvage(salvage); // banks to THIS machine's localStorage (each player keeps their own)
  el("over-wave").textContent = String(day);
  el("over-kills").textContent = String(kills);
  el("over-money").textContent = String(money);
  el("over-salvage").textContent = String(salvage);
  hide("hud");
  show("over");
}

function gameOver(): void {
  // the run's SALVAGE is a party pot, split evenly (floor so co-op never over-banks);
  // each player banks their own share to their own localStorage via the gameover event.
  const total = salvageEarned(state.day, state.kills);
  const share = Math.floor(total / state.players.length);
  // money is per-player now; the debrief shows the squad's combined leftover credits
  // (in single-player that's just the one wallet → identical to before).
  const money = state.players.reduce((sum, p) => sum + p.money, 0);
  Net.host?.broadcastGameOver(share, state.day, state.kills, money);
  endRun(share, state.day, state.kills, money);
}

/** Apply the host's gameover event: bank our share + show the debrief on this client. */
export function clientGameOver(salvage: number, day: number, kills: number, money: number): void {
  endRun(salvage, day, kills, money);
}

/** Back to the title screen (so the player can spend SALVAGE before redeploying). */
export function toTitle(): void {
  hide("over");
  hide("shop");
  hide("hud");
  hide("lobby");
  hide("coop");
  renderArsenal();
  show("start");
}

/** Render the title-screen ARSENAL panel: SALVAGE balance + weapon unlocks. */
export function renderArsenal(): void {
  const meta = loadMeta();
  el("salvage-bal").textContent = String(meta.salvage);
  const rows = UNLOCKABLE.flatMap((u) => {
    const w = WEAPONS[u.id];
    if (!w) return [];
    const owned = !!meta.unlocked[u.id];
    return [{ u, w, owned, able: !owned && meta.salvage >= u.price }];
  });
  renderList(
    el("arsenal-list"),
    rows,
    ({ u, owned, able }) => `${u.id}:${owned}:${able}`,
    ({ u, w, owned, able }) => {
      const d = document.createElement("div");
      d.className = `arow${owned ? " owned" : able ? "" : " off"}`;
      d.innerHTML = owned
        ? `<div class='cname'>${w.name}</div><div class='atag'>UNLOCKED</div>`
        : `<div class='cname'>${w.name}</div><div class='aprice'>${u.price} ◆</div>`;
      if (!owned && able) d.onclick = () => unlockWeapon(u.id, u.price);
      return d;
    },
  );
}

function unlockWeapon(id: string, price: number): void {
  if (buyUnlock(id, price)) {
    Audio.ui(true);
    renderArsenal();
  } else {
    Audio.ui(false);
  }
}

export function togglePause(): void {
  if (Net.mode === "client") return; // MVP: only the host pauses the shared sim
  if (!state.running || state.inShop) return;
  state.paused = !state.paused;
  // the overlay itself is driven by state.paused in updateHUD (so a host pause shows on
  // every client via the snapshot) — no imperative show/hide here.
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
  if (barD < reach)
    return p.money >= CONFIG.siege.repairCost ? "[E] repair" : "[E] repair — no credits";

  for (const c of state.caches) {
    if (c.looted) continue;
    if (Math.hypot(c.x - p.x, c.y - p.y) < reach)
      return state.phase === "night"
        ? "stand still to search — risky! (draws the horde)"
        : "stand still to search";
  }
  return null;
}

/** Safe-room resupply: top up spare ammo, the battery, and medkits between waves. */
function resupply(): void {
  const refill = CONFIG.ammo.shopRefillMags;
  for (const p of state.players) {
    for (const id of WEAPON_ORDER) {
      const w = WEAPONS[id];
      if (!w || w.melee) continue;
      const cap = Math.round(w.reserveMax * p.reserveMul);
      p.reserve[id] = Math.min(cap, (p.reserve[id] ?? 0) + Math.round(w.mag * refill));
    }
    p.battery = Math.min(CONFIG.flashlight.batteryMax, p.battery + CONFIG.flashlight.shopBattery);
    p.medkits = Math.min(CONFIG.heal.maxMedkits, p.medkits + CONFIG.heal.shopMedkits);
  }
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
  if (state.running && Net.mode === "client") return;
  state = newState();
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
