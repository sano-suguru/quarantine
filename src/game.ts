import { CONFIG } from "./config";
import { UPGRADES } from "./data/upgrades";
import { WEAPONS, WEAPON_ORDER } from "./data/weapons";
import { Audio } from "./engine/audio";
import { Renderer, SHAPE } from "./engine/renderer";
import { newState } from "./state";
import { sysAI } from "./systems/ai";
import { sysBullets } from "./systems/bullets";
import { sysCamera } from "./systems/camera";
import { sysFx } from "./systems/fx";
import { sysPlayer } from "./systems/player";
import { startWave, sysWave } from "./systems/wave";
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
  sysFx(state, sdt);
  const cleared = sysWave(state, sdt);
  sysCamera(state, sdt);
  audioAmbience(dt);
  if (cleared) openShop();
}

function audioAmbience(dt: number): void {
  const p = state.player;
  const hpf = p.hp / p.maxHp;
  const dread = Math.min(
    1,
    0.12 +
      state.surrounded / (CONFIG.horror.surroundCount * 1.6) +
      (hpf < CONFIG.horror.lowHp ? 0.35 : 0),
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
  R.setLight(p.x, p.y, CONFIG.horror.lightRadius);
  R.begin();

  // --- ground: blood decals ---
  for (const d of state.decals) {
    const a = Math.min(0.5, (d.life / d.maxLife) * 0.5);
    R.circle(d.x, d.y, d.r, d.color[0], d.color[1], d.color[2], a);
  }

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

/* ----------------------------- HUD ------------------------------ */
let lastWeapon = "";
export function updateHUD(): void {
  const p = state.player;
  const wd = weapon(p.weapon);
  const hpf = Math.max(0, p.hp) / p.maxHp;
  el("hpbar").style.width = `${100 * hpf}%`;
  el("hpbar").style.background = hpf < 0.3 ? "var(--blood)" : "var(--toxic)";
  el("hpnum").textContent = `${Math.max(0, Math.ceil(p.hp))} / ${p.maxHp}`;
  el("wave").textContent = String(state.wave.n);
  el("weapon-name").textContent = wd.name + (p.reloadT > 0 ? " · RELOADING" : "");
  el("ammo-val").textContent = String(p.ammo);
  el("mag-val").textContent = String(wd.mag);
  el("money").textContent = String(state.money);
  el("remaining").textContent = String(state.zombies.length + state.wave.queue.length);

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
function announceWave(n: number): void {
  const b = el("banner");
  el("banner-n").textContent = String(n);
  b.classList.remove("show");
  void b.offsetWidth; // reflow to restart animation
  b.classList.add("show");
  Audio.waveStart();
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
  startWave(state, 1);
  announceWave(1);
}

let shopChoices: Upgrade[] = [];
let shopSel = 0;

export function openShop(): void {
  state.paused = true;
  Audio.setDread(0.1);
  const pool = UPGRADES.slice();
  shopChoices = [];
  for (let i = 0; i < 3 && pool.length; i++)
    shopChoices.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0] as Upgrade);
  shopSel = 0;
  el("shop-wave").textContent = String(state.wave.n);
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
  const n = state.wave.n + 1;
  startWave(state, n);
  announceWave(n);
}

export function gameOver(): void {
  state.running = false;
  Audio.gameOver();
  Audio.stopDread();
  el("over-wave").textContent = String(state.wave.n);
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
