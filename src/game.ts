import { UPGRADES } from "./data/upgrades";
import { WEAPONS } from "./data/weapons";
import { Renderer } from "./engine/renderer";
import { newState } from "./state";
import { sysAI } from "./systems/ai";
import { sysBullets } from "./systems/bullets";
import { sysCamera } from "./systems/camera";
import { sysPlayer } from "./systems/player";
import { startWave, sysWave } from "./systems/wave";
import type { State, Upgrade, WeaponDef } from "./types";
import { el, hide, show } from "./ui";

let state: State = newState();

export function getState(): State {
  return state;
}

/* -------------------------- UPDATE / DRAW ----------------------- */
export function update(dt: number): void {
  if (!state.running || state.paused) return;
  state.time += dt;
  sysPlayer(state, dt);
  sysAI(state, dt);
  if (state.player.hp <= 0) {
    gameOver();
    return;
  }
  sysBullets(state, dt);
  const cleared = sysWave(state, dt);
  sysCamera(state, dt);
  if (cleared) openShop();
}

export function draw(): void {
  const R = Renderer;
  const p = state.player;
  const c = state.cam;
  const sh = c.shake;
  const camX = c.x + (Math.random() * 2 - 1) * sh;
  const camY = c.y + (Math.random() * 2 - 1) * sh;
  R.begin();

  for (const z of state.zombies) {
    R.circle(z.x, z.y, z.r, z.color[0], z.color[1], z.color[2], 1);
    const f = z.hp / z.maxHp;
    if (f < 1) R.circle(z.x, z.y, z.r * 0.45, 0.6 + 0.4 * (1 - f), 0.15, 0.15, 0.6);
  }
  for (const b of state.bullets) R.circle(b.x, b.y, b.r, 1.0, 0.85, 0.4, 1);

  R.circle(p.x, p.y, p.r, 0.49, 1.0, 0.31, 1);
  const bx = p.x + Math.cos(p.aim) * p.r * 0.8;
  const by = p.y + Math.sin(p.aim) * p.r * 0.8;
  R.rect(bx, by, p.r * 1.3, 6, p.aim, 0.85, 0.95, 0.8, 1);
  if (p.reloadT > 0) {
    const wd = weapon(p.weapon);
    const prog = 1 - p.reloadT / wd.reload;
    R.rect(p.x, p.y - p.r - 10, 30 * prog, 4, 0, 1, 0.7, 0.2, 1);
  }
  R.flush(camX, camY);
}

/* ----------------------------- HUD ------------------------------ */
export function updateHUD(): void {
  const p = state.player;
  const wd = weapon(p.weapon);
  el("hpbar").style.width = `${(100 * Math.max(0, p.hp)) / p.maxHp}%`;
  el("hpbar").style.background = p.hp / p.maxHp < 0.3 ? "var(--blood)" : "var(--toxic)";
  el("wave").textContent = String(state.wave.n);
  el("weapon-name").textContent = wd.name + (p.reloadT > 0 ? " · RELOADING" : "");
  el("ammo-val").textContent = String(p.ammo);
  el("money").textContent = String(state.money);
  el("remaining").textContent = String(state.zombies.length + state.wave.queue.length);
}

/* --------------------------- FLOW / UI -------------------------- */
export function startGame(): void {
  state = newState();
  state.running = true;
  hide("start");
  hide("over");
  hide("shop");
  show("hud");
  startWave(state, 1);
}

let shopChoices: Upgrade[] = [];

export function openShop(): void {
  state.paused = true;
  const pool = UPGRADES.slice();
  shopChoices = [];
  for (let i = 0; i < 3 && pool.length; i++)
    shopChoices.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0] as Upgrade);
  el("shop-wave").textContent = String(state.wave.n);
  const box = el("choices");
  box.innerHTML = "";
  shopChoices.forEach((u, i) => {
    const d = document.createElement("div");
    d.className = "choice";
    d.innerHTML = `<div class='num'>[${i + 1}]</div><div class='name'>${u.name}</div><div class='desc'>${u.desc}</div>`;
    d.onclick = () => chooseUpgrade(i);
    box.appendChild(d);
  });
  show("shop");
}

export function chooseUpgrade(i: number): void {
  const u = shopChoices[i];
  if (!u) return;
  u.apply(state);
  hide("shop");
  state.paused = false;
  startWave(state, state.wave.n + 1);
}

export function gameOver(): void {
  state.running = false;
  el("over-wave").textContent = String(state.wave.n);
  el("over-kills").textContent = String(state.kills);
  el("over-money").textContent = String(state.money);
  hide("hud");
  show("over");
}

export function shopVisible(): boolean {
  return !el("shop").classList.contains("hidden");
}

function weapon(id: string): WeaponDef {
  return WEAPONS[id] as WeaponDef;
}
