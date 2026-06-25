import { CONFIG } from "./config";
import { PICKUP_TYPES } from "./data/pickups";
import { UPGRADES } from "./data/upgrades";
import { WEAPONS, WEAPON_ORDER } from "./data/weapons";
import { Audio } from "./engine/audio";
import { Renderer, SHAPE } from "./engine/renderer";
import { newState } from "./state";
import { sysAI } from "./systems/ai";
import { sysBullets } from "./systems/bullets";
import { sysCamera } from "./systems/camera";
import { flashlightIntensity } from "./systems/flashlight";
import { sysFx } from "./systems/fx";
import { sysPickups } from "./systems/pickups";
import { sysPlayer } from "./systems/player";
import { startDay, startNight, sysSiege } from "./systems/siege";
import type { State, Upgrade, WeaponDef } from "./types";
import { el, hide, show } from "./ui";

let state: State = newState();

export function getState(): State {
  return state;
}

const TOXIC: [number, number, number] = [0.49, 1.0, 0.31];

/* -------------------------- UPDATE / DRAW ----------------------- */
let hbT = 0; // heartbeat timer
let groanT = 2; // ambient groan timer

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
  sysAI(state, sdt);
  if (state.player.hp <= 0) {
    gameOver();
    return;
  }
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
  const p = state.player;
  const hpf = p.hp / p.maxHp;
  const wd = weapon(p.weapon);
  // running dry feeds the dread too — the fear of an empty gun
  const totalAmmo = p.ammo + (p.reserve[p.weapon] ?? 0);
  const lowAmmo = !wd.melee && wd.mag > 0 && totalAmmo < wd.mag * CONFIG.horror.lowAmmo;
  const dread = Math.min(
    1,
    0.12 +
      state.surrounded / (CONFIG.horror.surroundCount * 1.6) +
      // unseen threats in the dark weigh heavier than ones in your light
      state.lurking / (CONFIG.horror.surroundCount * 1.2) +
      (hpf < CONFIG.horror.lowHp ? 0.35 : 0) +
      (lowAmmo ? 0.2 : 0) +
      (state.phase === "night" ? 0.15 : 0),
  );
  Audio.setDread(dread);

  if (hpf < CONFIG.horror.lowHp) {
    hbT -= dt;
    if (hbT <= 0) {
      const strength = 1 - hpf / CONFIG.horror.lowHp; // closer to death = stronger
      Audio.heartbeat(0.6 + strength * 0.6);
      hbT = 0.9 - strength * 0.4;
    }
  } else {
    hbT = 0.3;
  }

  groanT -= dt;
  if (groanT <= 0 && state.zombies.length > 0) {
    Audio.groan((Math.random() * 2 - 1) * 0.8);
    groanT = Math.max(0.6, 3.5 - state.zombies.length * 0.06);
  }
}

export function draw(): void {
  const R = Renderer;
  const p = state.player;
  const c = state.cam;
  const sh = c.shake;
  const camX = c.x + (Math.random() * 2 - 1) * sh;
  const camY = c.y + (Math.random() * 2 - 1) * sh;
  // aimed flashlight: cone follows the mouse; flickers and dies with the battery
  const flc = CONFIG.flashlight;
  const intensity = flashlightIntensity(
    p.battery / flc.batteryMax,
    p.lightOn,
    flc.lowThreshold,
    flc.flickerDepth,
    Math.random(),
  );
  // daylight floods the arena; night sinks to near-black (flashlight essential)
  const ambient = state.phase === "day" ? CONFIG.siege.dayAmbient : CONFIG.siege.nightAmbient;
  R.setLight(p.x, p.y);
  R.setFlashlight(
    Math.cos(p.aim),
    Math.sin(p.aim),
    Math.cos(flc.halfAngle),
    flc.range,
    ambient,
    flc.personalRadius,
    flc.personalMax,
    intensity,
    flc.emissiveFloor,
  );
  R.begin();

  // --- ground: blood decals ---
  for (const d of state.decals) {
    const a = Math.min(0.5, (d.life / d.maxLife) * 0.5);
    R.circle(d.x, d.y, d.r, d.color[0], d.color[1], d.color[2], a);
  }

  // --- shelter: stone walls + boarded openings, and world loot caches ---
  drawShelter(R);
  drawCaches(R);

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
    const face = Math.atan2(p.y - z.y, p.x - z.x);
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

  // --- player ---
  const px = p.x + p.recoilX;
  const py = p.y + p.recoilY;
  R.glow(px, py, p.r * 3, TOXIC[0], TOXIC[1], TOXIC[2], 0.55);
  R.circle(px, py, p.r, TOXIC[0], TOXIC[1], TOXIC[2], 1);
  R.ring(px, py, p.r * 0.6, 0.05, 0.18, 0.05, 0.9);
  if (p.hitFlash > 0) R.glow(px, py, p.r * 3.4, 1, 0.2, 0.2, Math.min(0.9, p.hitFlash * 3));
  const bx = px + Math.cos(p.aim) * p.r * 0.9;
  const by = py + Math.sin(p.aim) * p.r * 0.9;
  R.rect(bx, by, p.r * 1.4, 6, p.aim, 0.85, 0.95, 0.8, 1);
  if (p.muzzle > 0) {
    const tx = px + Math.cos(p.aim) * p.r * 1.7;
    const ty = py + Math.sin(p.aim) * p.r * 1.7;
    R.glow(tx, ty, p.r * 1.6, 1, 0.9, 0.6, Math.min(1, p.muzzle * 18));
  }
  if (p.reloadT > 0) {
    const wd = weapon(p.weapon);
    const prog = 1 - p.reloadT / wd.reload;
    R.rect(p.x, p.y - p.r - 12, 34 * prog, 4, 0, 1, 0.75, 0.2, 1);
  }
  // healing: green aura + progress bar (you're rooted and exposed while it fills)
  if (p.healT > 0) {
    const prog = 1 - p.healT / CONFIG.heal.duration;
    R.glow(px, py, p.r * 3.4, 0.3, 1, 0.45, 0.4);
    R.rect(p.x, p.y - p.r - 12, 34 * prog, 4, 0, 0.3, 1, 0.45, 1);
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

  // --- floating damage numbers ---
  for (const t of state.texts) {
    const a = Math.min(1, t.life / t.maxLife);
    if (t.crit) R.number(t.x, t.y, t.value, 20, 1, 0.75, 0.2, a);
    else R.number(t.x, t.y, t.value, 13, 1, 1, 0.85, a * 0.9);
  }

  R.flush(camX, camY);
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
      const f = Math.min(1, c.searchT / CONFIG.cache.searchTime);
      R.rect(c.x, c.y - 20, 30, 4, 0, 0.05, 0.05, 0.05, 0.8);
      R.rect(c.x - (30 * (1 - f)) / 2, c.y - 20, 30 * f, 4, 0, 0.3, 1, 0.45, 1);
    }
  }
}

/* ----------------------------- HUD ------------------------------ */
let lastWeapon = "";
export function updateHUD(): void {
  const p = state.player;
  const wd = weapon(p.weapon);
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

  // day/night phase
  const phaseEl = el("phase");
  if (state.phase === "day") {
    phaseEl.textContent = `DAY ${state.day} · DUSK IN ${Math.ceil(state.phaseT)}s`;
    phaseEl.classList.remove("night");
  } else {
    phaseEl.textContent = `NIGHT ${state.day}`;
    phaseEl.classList.add("night");
  }

  // contextual interact prompt (repair barricade / search cache)
  const ip = interactPrompt();
  const promptEl = el("prompt");
  promptEl.textContent = ip ?? "";
  promptEl.classList.toggle("show", ip !== null);

  el("money").textContent = String(state.money);
  el("remaining").textContent =
    state.phase === "night" ? String(state.zombies.length + state.wave.queue.length) : "—";

  // weapon slot highlight
  if (p.weapon !== lastWeapon) {
    lastWeapon = p.weapon;
    for (let i = 0; i < WEAPON_ORDER.length; i++) {
      const slot = document.getElementById(`slot-${i}`);
      if (slot) slot.classList.toggle("active", WEAPON_ORDER[i] === p.weapon);
    }
  }

  // dread vignette intensity
  const hud = el("hud");
  hud.classList.toggle("low", hpf < CONFIG.horror.lowHp);

  // damage flash overlay
  const fl = el("flash");
  fl.style.opacity = String(Math.min(0.6, state.flashT));
  fl.style.background = `radial-gradient(circle at 50% 50%, transparent 40%, rgba(${Math.round(state.flashColor[0] * 255)},${Math.round(state.flashColor[1] * 255)},${Math.round(state.flashColor[2] * 255)},0.9) 100%)`;
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

export function startGame(): void {
  state = newState();
  state.running = true;
  lastWeapon = "";
  Audio.resume();
  hide("start");
  hide("over");
  hide("shop");
  show("hud");
  startDay(state);
  announce("DAY", state.day);
}

/** Player chooses to bring the night early, skipping the rest of the day. */
export function startNightNow(): void {
  if (!state.running || state.paused || state.phase !== "day") return;
  startNight(state);
  announce("NIGHT", state.day);
  Audio.waveStart();
}

let shopChoices: Upgrade[] = [];
let shopSel = 0;

export function openShop(): void {
  state.paused = true;
  Audio.setDread(0.1);
  resupply();
  const pool = UPGRADES.slice();
  shopChoices = [];
  for (let i = 0; i < 3 && pool.length; i++)
    shopChoices.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0] as Upgrade);
  shopSel = 0;
  el("shop-wave").textContent = String(state.day);
  renderShop();
  show("shop");
}

let shopEls: HTMLElement[] = [];

function renderShop(): void {
  const box = el("choices");
  box.innerHTML = "";
  shopEls = shopChoices.map((u, i) => {
    const d = document.createElement("div");
    d.className = `choice${i === shopSel ? " sel" : ""}`;
    const preview = u.preview ? u.preview(state) : "";
    d.innerHTML = `<div class='num'>[${i + 1}]</div><div class='cname'>${u.name}</div><div class='desc'>${u.desc}</div>${preview ? `<div class='prev'>${preview}</div>` : ""}`;
    d.onclick = () => chooseUpgrade(i);
    d.onmouseenter = () => {
      shopSel = i;
      highlightShop();
    };
    box.appendChild(d);
    return d;
  });
}

/** Update only the selection highlight — no DOM teardown, so clicks survive. */
function highlightShop(): void {
  shopEls.forEach((d, i) => d.classList.toggle("sel", i === shopSel));
}

export function shopMove(dir: number): void {
  if (!shopVisible()) return;
  shopSel = (shopSel + dir + shopChoices.length) % shopChoices.length;
  Audio.ui(false);
  highlightShop();
}

export function shopConfirm(): void {
  if (shopVisible()) chooseUpgrade(shopSel);
}

export function chooseUpgrade(i: number): void {
  const u = shopChoices[i];
  if (!u) return;
  Audio.ui(true);
  u.apply(state);
  hide("shop");
  state.paused = false;
  // survived the night → next day's scavenge phase
  state.day++;
  startDay(state);
  announce("DAY", state.day);
}

export function gameOver(): void {
  state.running = false;
  Audio.gameOver();
  Audio.stopDread();
  el("over-wave").textContent = String(state.day);
  el("over-kills").textContent = String(state.kills);
  el("over-money").textContent = String(state.money);
  hide("hud");
  show("over");
}

export function togglePause(): void {
  if (!state.running || shopVisible()) return;
  state.paused = !state.paused;
  if (state.paused) show("pause");
  else hide("pause");
}

export function shopVisible(): boolean {
  return !el("shop").classList.contains("hidden");
}

function weapon(id: string): WeaponDef {
  return WEAPONS[id] as WeaponDef;
}

/** Context interact hint for the HUD: repair a barricade (priority) or search a cache. */
function interactPrompt(): string | null {
  const p = state.player;
  const reach = CONFIG.siege.interactRadius;
  for (const b of state.barricades) {
    if (b.hp >= b.maxHp) continue;
    const mx = (b.x1 + b.x2) / 2;
    const my = (b.y1 + b.y2) / 2;
    if (Math.hypot(mx - p.x, my - p.y) < reach) {
      return state.money >= CONFIG.siege.repairCost ? "[E] repair" : "[E] repair — no credits";
    }
  }
  if (state.phase === "day") {
    for (const c of state.caches) {
      if (c.looted) continue;
      if (Math.hypot(c.x - p.x, c.y - p.y) < reach) return "[E] hold to search";
    }
  }
  return null;
}

/** Safe-room resupply: top up spare ammo, the battery, and medkits between waves. */
function resupply(): void {
  const p = state.player;
  const refill = CONFIG.ammo.shopRefillMags;
  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id];
    if (!w || w.melee) continue;
    const cap = Math.round(w.reserveMax * state.reserveMul);
    p.reserve[id] = Math.min(cap, (p.reserve[id] ?? 0) + Math.round(w.mag * refill));
  }
  p.battery = Math.min(CONFIG.flashlight.batteryMax, p.battery + CONFIG.flashlight.shopBattery);
  p.medkits = Math.min(CONFIG.heal.maxMedkits, p.medkits + CONFIG.heal.shopMedkits);
}

/** Toggle the flashlight (off = no battery drain, but near-blind). */
export function toggleFlashlight(): void {
  if (!state.running || state.paused) return;
  state.player.lightOn = !state.player.lightOn;
  Audio.click();
}

/** Use a carried medkit: a deliberate, rooted heal-over-time. */
export function useMedkit(): void {
  if (!state.running || state.paused) return;
  const p = state.player;
  if (p.medkits <= 0 || p.healT > 0 || p.hp >= p.maxHp) return;
  p.medkits--;
  p.healT = CONFIG.heal.duration;
  Audio.heal();
}
