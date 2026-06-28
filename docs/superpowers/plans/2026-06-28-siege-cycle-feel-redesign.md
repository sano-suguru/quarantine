# Siege Cycle & Feel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the day/night siege into a clock-driven cycle (timed dawn, continuous bounded spawn), make day zombies sluggish and night zombies ferocious, give blood pools depth and direction, and split the overloaded "Deploy" wording.

**Architecture:** Extend existing seams, no special-case branches. `sysSiege`'s night branch becomes a symmetric `phaseT` countdown (like the day branch); `sysWave` is demoted from "phase terminator" to a continuous, capped spawner. AI reads a data-driven `PHASE_MODS` table as factors in its existing multiplier chain. Ambient light and the HUD clock are pure functions of `phase`+`phaseT`+`day`. All tuning lives in `CONFIG`/data tables.

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess), Bun, Vite, Vitest (node env), Biome. WebGL2 custom engine. Vanilla DOM HUD.

## Global Constraints

- **Data-driven, zero special-case debt.** New behavior rides `CONFIG`/`src/data/*` and existing system seams — never bolt-on branches (CLAUDE.md).
- **Feel-first, playtest-verified.** Feel changes (#2/#3/#4) are NOT done until played and felt. **Playtest cadence (per user): playtests are DEFERRED to the end, not run per task.** During implementation, each task stops at its automated gate (typecheck/lint/test/build) + commit. **Skip every per-task "Playtest (feel gate)" step** — those observations are collected and performed once in the final consolidated playtest (Task 11). Nothing is declared "done"/"working" on feel grounds until Task 11 passes.
- **Tests cover pure/deterministic code only.** Unit-test pure helpers (`waveDef`, new clock/ambient/phase-mod helpers); do NOT fabricate unit tests for systems/renderer/AI/fx — those are playtest-gated. Co-locate tests as `*.test.ts`.
- **Single-player must stay behavior-correct; co-op is host-authoritative.** Systems never import net code.
- **Gates:** `bun run typecheck`, `bun run lint`, `bun run test`, `bun run build` must pass. Co-op wire changes require bumping `PROTOCOL_VERSION` (`src/net/net.ts`).
- **Commits:** end messages with the two trailer lines used in this repo (see existing history). Work on branch `feat/siege-cycle-feel-redesign`.

---

## Task 1: Rename the overloaded "Deploy" wording

**Files:**
- Modify: `index.html` (lines 158, 375, 414, 425, 437, 439, 501)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (pure UI strings; element ids unchanged).

- [ ] **Step 1: Rename the title-screen start button**

In `index.html:425`, change:
```html
      <button type="button" class="btn" id="startBtn">Deploy</button>
```
to:
```html
      <button type="button" class="btn" id="startBtn">Enter the Quarantine</button>
```

- [ ] **Step 2: Rename the shop "advance to next day" button**

In `index.html:439`, change:
```html
  <button type="button" class="btn" id="deployBtn">Deploy</button>
```
to:
```html
  <button type="button" class="btn" id="deployBtn">Face the Day</button>
```

- [ ] **Step 3: Rename the arsenal hint copy**

In `index.html:437`, change the trailing `then deploy`:
```html
      <p>Credits <b id="shop-credits" style="color:var(--amber)">0</b> &middot; upgrade your kit, then deploy</p>
```
to:
```html
      <p>Credits <b id="shop-credits" style="color:var(--amber)">0</b> &middot; upgrade your kit, then face the day</p>
```

- [ ] **Step 4: Rename the deploy-bar label (place barricade)**

In `index.html:375`, change:
```html
      <div id="deploybar" class="hidden"><div class="stat-label">Deploy [Q]</div>
```
to:
```html
      <div id="deploybar" class="hidden"><div class="stat-label">Fortify [Q]</div>
```

- [ ] **Step 5: Rename the Q control hint (leave the Enter hint for Task 9)**

In `index.html:414`, change `Q deploy (buy in shop)` only:
```html
      <span><b>Q</b> deploy (buy in shop)</span><span><b>Enter</b> start night early</span>
```
to:
```html
      <span><b>Q</b> fortify (buy in shop)</span><span><b>Enter</b> start night early</span>
```
(The `Enter start night early` span is removed in Task 9 when the feature is removed.)

- [ ] **Step 6: Rename the co-op lobby start button**

In `index.html:501`, change:
```html
    <button type="button" class="btn" id="lobby-deploy" style="display:none;">Deploy raid</button>
```
to:
```html
    <button type="button" class="btn" id="lobby-deploy" style="display:none;">Start Raid</button>
```

- [ ] **Step 7: Update the stale CSS comment**

In `index.html:158`, the comment references `(Deploy)` as the primary button. Change `the solid fill of the primary (Deploy),` to `the solid fill of the primary button,`.

- [ ] **Step 8: Verify lint/build, then visually confirm**

Run:
```bash
bun run lint && bun run build
```
Expected: both pass. Then `bun run dev`, open http://localhost:5173, and confirm the title button reads "Enter the Quarantine", the shop button reads "Face the Day", the HUD deploy bar reads "Fortify [Q]", and the co-op lobby button reads "Start Raid".

- [ ] **Step 9: Commit**

```bash
git add index.html
git commit -m "feat(ui): split the overloaded \"Deploy\" wording into distinct verbs"
```

---

## Task 2: Layered, directional blood pools

**Files:**
- Modify: `src/config.ts` (add `fx` block before the closing of `CONFIG`)
- Modify: `src/systems/fx.ts:191-203` (`bloodPool`), and callers at `fx.ts:124` (`fxKill`), `fx.ts:167` (`fxHurt`), `fx.ts:78` (`fxImpact`/`bloodSpeck` path)
- Modify: `src/systems/ai.ts:160` (the `fxHurt` call already passes no direction — unchanged) — no change needed; listed for awareness only.

**Interfaces:**
- Consumes: `CONFIG.fx.blood` (new).
- Produces: `bloodPool(state, x, y, big, dir?)` — `dir` is the splatter direction in radians (optional; omit = radial).

- [ ] **Step 1: Add a `fx.blood` config block**

In `src/config.ts`, add a top-level `fx` block (place it right after the `audio: { ... },` block near line 60 so feel/visual tuning sits together):
```ts
  // blood decals: a pool is a cluster of layered blobs, not one flat disc. Center blobs are
  // darker; satellites bias along the hit direction to read as a splatter, not a stamp.
  fx: {
    blood: {
      maxDecals: 480, // a pool now costs several decals; raised so pools don't churn the FIFO
      satellites: 4, // small blobs flung around each base blob
      baseRadiusBig: [16, 26] as [number, number],
      baseRadiusSmall: [8, 14] as [number, number],
      satRadius: [3, 9] as [number, number],
      satSpread: 22, // world-units satellites scatter from the base
      splatterBias: 28, // extra world-units satellites travel along `dir` (the splatter tail)
      centerColor: [0.16, 0.02, 0.03] as [number, number, number], // dark, near-clotted
      edgeColor: [0.34, 0.04, 0.05] as [number, number, number], // brighter fresh red
      life: [26, 40] as [number, number], // seconds before the decal fades out
      maxAlpha: 0.6, // fresh-pool peak alpha (drawn fade is life/maxLife * maxAlpha)
    },
  },
```

- [ ] **Step 2: Rewrite `bloodPool` as a directional multi-blob cluster**

In `src/systems/fx.ts`, replace the `MAX_DECALS` constant (line 6) and the `bloodPool` function (lines 191-203). First delete line 6:
```ts
const MAX_DECALS = 360;
```
Then replace `bloodPool` (191-203) with:
```ts
function bloodPool(state: State, x: number, y: number, big: boolean, dir?: number): void {
  const cfg = CONFIG.fx.blood;
  const dx = dir === undefined ? 0 : Math.cos(dir);
  const dy = dir === undefined ? 0 : Math.sin(dir);
  const baseR = big ? cfg.baseRadiusBig : cfg.baseRadiusSmall;
  pushDecal(state, x, y, rand(baseR[0], baseR[1]), cfg.centerColor, cfg.life);
  for (let i = 0; i < cfg.satellites; i++) {
    const sx = x + rand(-cfg.satSpread, cfg.satSpread) + dx * rand(0, cfg.splatterBias);
    const sy = y + rand(-cfg.satSpread, cfg.satSpread) + dy * rand(0, cfg.splatterBias);
    // outer satellites blend toward the brighter edge color
    const t = rand(0, 1);
    const color: RGB = [
      cfg.centerColor[0] + (cfg.edgeColor[0] - cfg.centerColor[0]) * t,
      cfg.centerColor[1] + (cfg.edgeColor[1] - cfg.centerColor[1]) * t,
      cfg.centerColor[2] + (cfg.edgeColor[2] - cfg.centerColor[2]) * t,
    ];
    pushDecal(state, sx, sy, rand(cfg.satRadius[0], cfg.satRadius[1]), color, cfg.life);
  }
}

function pushDecal(state: State, x: number, y: number, r: number, color: RGB, lifeRange: [number, number]): void {
  if (state.decals.length >= CONFIG.fx.blood.maxDecals) state.decals.shift();
  const life = rand(lifeRange[0], lifeRange[1]);
  state.decals.push({ x, y, r, rot: rand(0, 6.28), color: [color[0], color[1], color[2]], life, maxLife: life });
}
```
Add the import of `CONFIG` at the top of `fx.ts` (it currently imports only `rand` and types):
```ts
import { CONFIG } from "../config";
```

- [ ] **Step 3: Pass the hit direction from the kill and hurt callers**

In `src/systems/fx.ts:124` (inside `fxKill`), the kill burst has no direction handy — keep it radial:
```ts
  bloodPool(state, x, y, big);
```
(unchanged — a death is an omnidirectional burst).

In `src/systems/fx.ts:61` change `fxImpact` so the speck pool trails along the bullet direction. Replace the body's final line `bloodSpeck(state, x, y, color, 3);` (line 78) with a small directional pool plus the speck particles:
```ts
  bloodSpeck(state, x, y, color, 3);
  bloodPool(state, x, y, false, dir);
```

- [ ] **Step 4: Update the alpha cap in the draw loop**

In `src/game.ts:408-410`, the decal draw clamps alpha to `0.5`. Change it to read the config peak:
```ts
  for (const d of state.decals) {
    const a = Math.min(CONFIG.fx.blood.maxAlpha, (d.life / d.maxLife) * CONFIG.fx.blood.maxAlpha);
    R.circle(d.x, d.y, d.r, d.color[0], d.color[1], d.color[2], a);
  }
```

- [ ] **Step 5: Typecheck and build**

Run:
```bash
bun run typecheck && bun run build
```
Expected: both pass (no unit test — blood is visual/feel).

- [ ] **Step 6: Playtest the blood (feel gate)**

`bun run dev`, start a game, kill several zombies, take a hit. Confirm pools look like layered clusters with a directional splatter tail on bullet impacts, not flat uniform discs; confirm darker centers/brighter edges read; confirm at night under the flashlight blood does not glow like a light source. Adjust `CONFIG.fx.blood` values if needed and re-observe. **State the result honestly.**

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/systems/fx.ts src/game.ts
git commit -m "feat(feel): layered directional blood pools (CONFIG.fx.blood)"
```

---

## Task 3: Sluggish-day / ferocious-night AI (data-driven `PHASE_MODS`)

**Files:**
- Create: `src/data/phaseMods.ts`
- Create: `src/data/phaseMods.test.ts`
- Modify: `src/systems/ai.ts` (apply the mods — lines 16, 60, 103-115, 128)

**Interfaces:**
- Consumes: `SiegePhase` from `src/types.ts`.
- Produces: `phaseMods(phase: SiegePhase, day: number): { speedMul: number; senseMul: number; lunge: boolean; wanderMul: number; autoAggro: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `src/data/phaseMods.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { phaseMods } from "./phaseMods";

describe("phaseMods", () => {
  it("day zombies are sluggish, short-sighted, non-lunging, non-aggro", () => {
    const m = phaseMods("day", 1);
    expect(m.speedMul).toBeLessThan(1);
    expect(m.senseMul).toBeLessThan(1);
    expect(m.lunge).toBe(false);
    expect(m.autoAggro).toBe(false);
    expect(m.wanderMul).toBeGreaterThan(1);
  });

  it("night zombies are at least base-speed, wide-sensed, lunging, auto-aggro", () => {
    const m = phaseMods("night", 1);
    expect(m.speedMul).toBeGreaterThanOrEqual(1);
    expect(m.senseMul).toBeGreaterThanOrEqual(1);
    expect(m.lunge).toBe(true);
    expect(m.autoAggro).toBe(true);
  });

  it("night ferocity ramps with the day number", () => {
    expect(phaseMods("night", 6).speedMul).toBeGreaterThan(phaseMods("night", 1).speedMul);
  });

  it("day ferocity does not ramp with the day number", () => {
    expect(phaseMods("day", 6).speedMul).toBe(phaseMods("day", 1).speedMul);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
bun run test -- phaseMods
```
Expected: FAIL — `phaseMods` not found / module missing.

- [ ] **Step 3: Implement `phaseMods`**

Create `src/data/phaseMods.ts`:
```ts
import type { SiegePhase } from "../types";

/**
 * Day/night behaviour modifiers applied as FACTORS in sysAI's existing multiplier chain —
 * not special-case branches. Day = sluggish, short-sighted shamblers you can slip past while
 * looting; night = ferocious, wide-sensed, lunging, latched-on. Night ferocity ramps with the
 * day number (survivability comes from the dawn clock + barricades, not weakened enemies).
 */
export interface PhaseMod {
  speedMul: number;
  senseMul: number;
  lunge: boolean;
  wanderMul: number;
  autoAggro: boolean;
}

export function phaseMods(phase: SiegePhase, day: number): PhaseMod {
  if (phase === "day") {
    return { speedMul: 0.6, senseMul: 0.45, lunge: false, wanderMul: 1.6, autoAggro: false };
  }
  // night: at/above base, ramping with the day number
  return {
    speedMul: 1 + Math.min(0.4, (day - 1) * 0.04),
    senseMul: 1.15,
    lunge: true,
    wanderMul: 1,
    autoAggro: true,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
bun run test -- phaseMods
```
Expected: PASS (4 tests).

- [ ] **Step 5: Apply the mods in `sysAI` (factors, not branches)**

In `src/systems/ai.ts`:

Add the import near the top (after the existing imports, line 8 area):
```ts
import { phaseMods } from "../data/phaseMods";
```

Replace the `night` line (16):
```ts
  const night = state.phase === "night";
```
with:
```ts
  const mod = phaseMods(state.phase, state.day);
```

Replace the aggro latch (line 60):
```ts
      if (night || dist <= z.sense) z.chasing = true;
```
with:
```ts
      if (mod.autoAggro || dist <= z.sense * mod.senseMul) z.chasing = true;
```

Gate lunge by the mod (line 103):
```ts
    if (chasing && z.lunge > 0) {
```
becomes:
```ts
    if (chasing && z.lunge > 0 && mod.lunge) {
```

Scale wander when wandering. The wander drift line (76):
```ts
      z.wanderDir += rand(-1, 1) * z.wander * 3 * dt;
```
becomes:
```ts
      z.wanderDir += rand(-1, 1) * z.wander * mod.wanderMul * 3 * dt;
```

Add the speed factor (line 128):
```ts
    const spd = z.speed * emerge * roamMul * lungeMul * (1 + lureMul);
```
becomes:
```ts
    const spd = z.speed * mod.speedMul * emerge * roamMul * lungeMul * (1 + lureMul);
```

- [ ] **Step 6: Typecheck, lint, full test, build**

Run:
```bash
bun run typecheck && bun run lint && bun run test && bun run build
```
Expected: all pass.

- [ ] **Step 7: Playtest day vs night (feel gate — final tuning happens with Task 9)**

`bun run dev`. By day, confirm zombies are visibly slow and oblivious (you can out-walk and slip past them while looting). By night (use the current Enter trigger — still present until Task 9), confirm they are clearly faster, sense you from farther, lunge, and latch on. **State the result honestly;** note any tuning intent for the combined #3/#4 playtest in Task 9.

- [ ] **Step 8: Commit**

```bash
git add src/data/phaseMods.ts src/data/phaseMods.test.ts src/systems/ai.ts
git commit -m "feat(ai): data-driven day/night ferocity via PHASE_MODS"
```

---

## Task 4: Night-duration config + helper

**Files:**
- Modify: `src/config.ts` (`siege` block, near line 134)
- Modify: `src/systems/siege.ts` (add `nightDuration`)
- Create: `src/systems/siege.test.ts`

**Interfaces:**
- Consumes: `CONFIG.siege.{nightDurationBase,nightDurationPerDay,nightDurationMax,nightMaxZombies,duskFrac,dawnFrac}` (new).
- Produces: `nightDuration(day: number): number`.

- [ ] **Step 1: Add the new siege config keys**

In `src/config.ts`, inside the `siege: { ... }` block (after `spawnRing: 680,` at line 144), add:
```ts
    // night is a timed hold, not a wipe-out: dawn arrives by the clock. Length ramps with the day.
    nightDurationBase: 55, // seconds of night on day 1
    nightDurationPerDay: 8, // each later day adds this many seconds of night
    nightDurationMax: 150, // clamp so very late nights stay finite
    nightMaxZombies: 90, // living-zombie cap during night: bounds perf/snapshot AND is the "cornered" wall
    duskFrac: 0.25, // fraction of the day over which light crossfades down to night (sunset)
    dawnFrac: 0.2, // fraction of the night over which light crossfades up to day (predawn)
```

- [ ] **Step 2: Write the failing test**

Create `src/systems/siege.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { nightDuration } from "./siege";

describe("nightDuration", () => {
  it("day 1 is the base duration", () => {
    expect(nightDuration(1)).toBe(55);
  });
  it("ramps with the day number", () => {
    expect(nightDuration(2)).toBe(63); // 55 + 1*8
    expect(nightDuration(5)).toBe(87); // 55 + 4*8
  });
  it("clamps to the max", () => {
    expect(nightDuration(100)).toBe(150);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
bun run test -- siege
```
Expected: FAIL — `nightDuration` is not exported.

- [ ] **Step 4: Implement `nightDuration`**

In `src/systems/siege.ts`, add after the imports:
```ts
/** Seconds of night for a given day. Night is a timed hold; dawn comes by the clock. */
export function nightDuration(day: number): number {
  const s = CONFIG.siege;
  return Math.min(s.nightDurationMax, s.nightDurationBase + (day - 1) * s.nightDurationPerDay);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
bun run test -- siege
```
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/systems/siege.ts src/systems/siege.test.ts
git commit -m "feat(siege): night-duration config + ramp helper"
```

---

## Task 5: Continuous, capped night spawner

**Files:**
- Modify: `src/types.ts:360-374` (`WaveDefinition`, `Wave`)
- Modify: `src/data/waves.ts` (`waveDef`)
- Modify: `src/data/waves.test.ts` (new shape)
- Modify: `src/systems/wave.ts` (`startWave`, `sysWave`, add `pickWeighted`)
- Modify: `src/state.ts:74` (wave init)
- Modify: `src/game.ts:849` (HUD remaining) and `src/net/snapshot.ts` (drop `waveQueue`)

**Interfaces:**
- Consumes: `nightDuration` (Task 4), `CONFIG.siege.nightMaxZombies`.
- Produces: `WaveDefinition { weights: {type,w}[]; batch; interval; hpScale; spdScale }`; `Wave { n; phase; t; def; spawnT }` (no `queue`); `sysWave(state, dt): void`.

- [ ] **Step 1: Update the `WaveDefinition` and `Wave` types**

In `src/types.ts`, replace lines 360-374:
```ts
export interface WaveDefinition {
  spawn: string[];
  hpScale: number;
  spdScale: number;
  interval: number;
}

interface Wave {
  n: number;
  phase: WavePhase;
  t: number;
  queue: string[];
  def: WaveDefinition | null;
  spawnT: number;
}
```
with:
```ts
export interface WaveDefinition {
  /** composition weights sampled per spawn pulse */
  weights: { type: string; w: number }[];
  /** zombies spawned per pulse */
  batch: number;
  /** seconds between pulses */
  interval: number;
  hpScale: number;
  spdScale: number;
}

interface Wave {
  n: number;
  phase: WavePhase;
  t: number;
  def: WaveDefinition | null;
  spawnT: number;
}
```

- [ ] **Step 2: Rewrite the `waveDef` tests for the new shape**

Replace the entire body of `src/data/waves.test.ts` with:
```ts
import { describe, expect, it } from "vitest";
import { waveDef } from "./waves";

const weight = (d: ReturnType<typeof waveDef>, type: string): number =>
  d.weights.find((e) => e.type === type)?.w ?? 0;

describe("waveDef", () => {
  it("wave 1 is walkers only", () => {
    const d = waveDef(1);
    expect(weight(d, "walker")).toBeCloseTo(8.4, 5); // 6 + 1*2.4
    expect(weight(d, "runner")).toBe(0);
    expect(weight(d, "brute")).toBe(0);
  });

  it("introduces runner weight at wave 2 and brute weight at wave 4", () => {
    expect(weight(waveDef(2), "runner")).toBeCloseTo(1.6, 5); // (2-1)*1.6
    expect(weight(waveDef(2), "brute")).toBe(0);
    expect(weight(waveDef(4), "brute")).toBe(1); // floor(4/3)
  });

  it("batch grows with the day number and squad size", () => {
    expect(waveDef(1).batch).toBe(1); // round((1 + floor(1/3)) * 1)
    expect(waveDef(6).batch).toBe(3); // round((1 + floor(6/3)) * 1) = 3
    expect(waveDef(1, 3).batch).toBe(2); // round(1 * (1 + 2*0.5)) = round(2)
  });

  it("interval tightens with the day number, clamped to a floor", () => {
    expect(waveDef(1).interval).toBeCloseTo(1.26, 5); // 1.3 - 1*0.04
    expect(waveDef(30).interval).toBe(0.45); // clamped
  });

  it("scales hp and speed with the day number", () => {
    const d = waveDef(10);
    expect(d.hpScale).toBeCloseTo(1.6, 5); // 1 + 10*0.06
    expect(d.spdScale).toBeCloseTo(1.15, 5); // 1 + 10*0.015
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:
```bash
bun run test -- waves
```
Expected: FAIL — `d.weights`/`d.batch` undefined (old `waveDef` still returns `spawn`).

- [ ] **Step 4: Rewrite `waveDef`**

Replace the body of `src/data/waves.ts` (`waveDef`, lines 10-23) with:
```ts
export function waveDef(n: number, players = 1): WaveDefinition {
  const mul = 1 + (Math.max(1, players) - 1) * CONFIG.econ.waveCountPerPlayer;
  const weights: { type: string; w: number }[] = [{ type: "walker", w: 6 + n * 2.4 }];
  if (n >= 2) weights.push({ type: "runner", w: (n - 1) * 1.6 });
  if (n >= 4) weights.push({ type: "brute", w: Math.floor(n / 3) });
  const batch = Math.max(1, Math.round((1 + Math.floor(n / 3)) * mul));
  const interval = Math.max(0.45, 1.3 - n * 0.04);
  const hpScale = 1 + n * 0.06;
  const spdScale = 1 + n * 0.015;
  return { weights, batch, interval, hpScale, spdScale };
}
```
Update the doc comment above it to describe rate/composition (it currently describes the finite roster). Keep the `WaveDefinition` import.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
bun run test -- waves
```
Expected: PASS (5 tests).

- [ ] **Step 6: Make `startWave`/`sysWave` a continuous capped spawner**

In `src/systems/wave.ts`:

Replace `startWave` (lines 100-105):
```ts
export function startWave(state: State, n: number): void {
  const players = state.players.filter((p) => !p.absent).length || 1;
  const def = waveDef(n, players);
  state.wave = { n, phase: "active", t: 0, def, spawnT: 0 };
}
```

Replace `sysWave` (lines 107-125) with a void, capped, continuous spawner plus a weighted picker:
```ts
/** Spawn pulses on cadence up to the living-zombie cap. The night ends on the siege clock
 *  (sysSiege), NOT when the horde is cleared — so this keeps pressure coming until dawn. */
export function sysWave(state: State, dt: number): void {
  const def = state.wave.def;
  if (!def) return;
  if (state.zombies.length >= CONFIG.siege.nightMaxZombies) return;
  state.wave.spawnT -= dt;
  if (state.wave.spawnT <= 0) {
    const room = CONFIG.siege.nightMaxZombies - state.zombies.length;
    const batch = Math.min(def.batch, room);
    for (let i = 0; i < batch; i++) spawnZombie(state, pickWeighted(def.weights), def.hpScale, def.spdScale);
    state.wave.spawnT = def.interval;
  }
}

function pickWeighted(weights: { type: string; w: number }[]): string {
  let total = 0;
  for (const e of weights) total += e.w;
  let r = rand(0, total);
  for (const e of weights) {
    r -= e.w;
    if (r <= 0) return e.type;
  }
  return weights[0]?.type ?? "walker";
}
```
(`rand` is already imported in `wave.ts`.)

- [ ] **Step 7: Update the wave init in `state.ts`**

In `src/state.ts:74`, change:
```ts
    wave: { n: 0, phase: "prep", t: 0, queue: [], def: null, spawnT: 0 },
```
to:
```ts
    wave: { n: 0, phase: "prep", t: 0, def: null, spawnT: 0 },
```

- [ ] **Step 8: Drop the dead `waveQueue` from the snapshot**

In `src/net/snapshot.ts`, remove the `waveQueue` field from all five sites:
- Delete the interface field (line 117): `waveQueue: number; // remaining queued spawns (count only — HUD uses it)`
- Delete the capture line (150): `waveQueue: state.wave.queue.length,`
- Delete the apply line (280): `state.wave.queue.length = snap.waveQueue; // length only (contents unused on client)`
- Delete the binary write (510): `w.u16(snap.waveQueue);`
- Delete the binary read (627): `const waveQueue = r.u16();`
- Remove `waveQueue,` from the decoded object (783).

- [ ] **Step 9: Update the HUD "remaining" to live zombie count**

In `src/game.ts:848-849`, change:
```ts
  el("remaining").textContent =
    state.phase === "night" ? String(state.zombies.length + state.wave.queue.length) : "—";
```
to:
```ts
  el("remaining").textContent = state.phase === "night" ? String(state.zombies.length) : "—";
```

- [ ] **Step 10: Typecheck, lint, test, build**

Run:
```bash
bun run typecheck && bun run lint && bun run test && bun run build
```
Expected: all pass. (Typecheck will fail loudly anywhere `wave.queue` is still referenced — fix any stragglers it reports.)

- [ ] **Step 11: Commit**

```bash
git add src/types.ts src/data/waves.ts src/data/waves.test.ts src/systems/wave.ts src/state.ts src/net/snapshot.ts src/game.ts
git commit -m "feat(wave): continuous capped night spawner (replaces finite roster)"
```

---

## Task 6: Symmetric timed-night `sysSiege` (clock-driven dawn)

**Files:**
- Modify: `src/systems/siege.ts` (`startNight`, `sysSiege`)

**Interfaces:**
- Consumes: `nightDuration` (Task 4), `sysWave(state, dt): void` (Task 5).
- Produces: `sysSiege` unchanged signature `(state, dt) => "night" | "dawn" | null`; `startNight` now sets `state.phaseT`.

- [ ] **Step 1: Set the night clock in `startNight`**

In `src/systems/siege.ts`, replace `startNight` (lines 24-27):
```ts
export function startNight(state: State): void {
  state.phase = "night";
  startWave(state, state.day);
}
```
with:
```ts
export function startNight(state: State): void {
  state.phase = "night";
  state.phaseT = nightDuration(state.day);
  startWave(state, state.day);
}
```

- [ ] **Step 2: Make the night branch a symmetric countdown**

In `src/systems/siege.ts`, replace the `sysSiege` night branch (lines 42-43):
```ts
  // night
  return sysWave(state, dt) ? "dawn" : null;
```
with:
```ts
  // night: spawns keep coming (capped); dawn arrives on the clock, not on a wipe-out
  sysWave(state, dt);
  state.phaseT -= dt;
  if (state.phaseT <= 0) return "dawn";
  return null;
```
Update the `sysSiege` doc comment (lines 29-32) to say the night branch is now timer-driven (returns "dawn" when the night clock elapses, regardless of remaining zombies).

- [ ] **Step 3: Clear the surviving horde when dawn breaks**

Night now ends with zombies still alive, so dawn must sweep them (sunrise burns the horde away — and the shop must open to a clean field). `startDay` (`siege.ts:12-21`) does NOT reset `state.zombies` (verified — it only sets phase/phaseT, restocks caches, and seeds roamers). Clear them in the dawn handler. In `src/game.ts:123-126`, change:
```ts
  } else if (ev === "dawn") {
    Audio.dawn();
    openShop();
  }
```
to:
```ts
  } else if (ev === "dawn") {
    Audio.dawn();
    state.zombies.length = 0; // sunrise sweeps the surviving horde — the shop opens to a clean field
    openShop();
  }
```

- [ ] **Step 4: Typecheck, lint, test, build**

Run:
```bash
bun run typecheck && bun run lint && bun run test && bun run build
```
Expected: all pass.

- [ ] **Step 5: Playtest the clock dawn (feel gate)**

`bun run dev`. Let the day timer run out → night starts automatically. During night, confirm spawns keep coming and the crowd grows toward the cap; do NOT kill everything — confirm that **dawn arrives on its own** after `nightDuration` seconds and the shop opens. Confirm morning starts clean (no leftover horde). **State the result honestly.**

- [ ] **Step 6: Commit**

```bash
git add src/systems/siege.ts src/game.ts
git commit -m "feat(siege): clock-driven dawn (night ends on timer, not wipe-out)"
```

---

## Task 7: Ambient light follows the clock (dusk/dawn gradient)

**Files:**
- Modify: `src/systems/siege.ts` (add `ambientForClock`)
- Modify: `src/systems/siege.test.ts` (extend)
- Modify: `src/game.ts:307` and `src/game.ts:382` (use the helper)

**Interfaces:**
- Consumes: `nightDuration` (Task 4), `CONFIG.siege.{dayAmbient,nightAmbient,duskFrac,dawnFrac,dayDuration}`.
- Produces: `ambientForClock(phase: SiegePhase, phaseT: number, day: number): number`.

- [ ] **Step 1: Write the failing test (extend siege.test.ts)**

First grow the existing top import line in `src/systems/siege.test.ts` to (avoids a duplicate-import lint flag):
```ts
import { ambientForClock, nightDuration } from "./siege";
```
Then append this block to the file (no new import statement):
```ts
describe("ambientForClock", () => {
  it("is full daylight mid-day", () => {
    expect(ambientForClock("day", 35, 1)).toBeCloseTo(0.45, 5); // phaseT == dayDuration
  });
  it("is near-black mid-night", () => {
    expect(ambientForClock("night", nightDuration(1), 1)).toBeCloseTo(0.04, 5);
  });
  it("crossfades down toward dusk (late day darker than mid-day)", () => {
    const mid = ambientForClock("day", 35, 1);
    const dusk = ambientForClock("day", 1, 1); // almost dusk
    expect(dusk).toBeLessThan(mid);
    expect(dusk).toBeGreaterThanOrEqual(0.04);
  });
  it("lifts toward dawn (end of night brighter than mid-night)", () => {
    const midNight = ambientForClock("night", nightDuration(1), 1);
    const predawn = ambientForClock("night", 1, 1); // almost dawn
    expect(predawn).toBeGreaterThan(midNight);
  });
});
```
- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
bun run test -- siege
```
Expected: FAIL — `ambientForClock` not exported.

- [ ] **Step 3: Implement `ambientForClock`**

In `src/systems/siege.ts`, add (it needs `SiegePhase` — add to the type import from `../types`):
```ts
/** Ambient light as a function of the clock: flat by day/night, crossfading over dusk/dawn. */
export function ambientForClock(phase: State["phase"], phaseT: number, day: number): number {
  const s = CONFIG.siege;
  const lerp = (k: number): number => s.nightAmbient + (s.dayAmbient - s.nightAmbient) * k;
  if (phase === "day") {
    const window = s.dayDuration * s.duskFrac;
    return phaseT < window ? lerp(phaseT / window) : s.dayAmbient; // sunset over the last duskFrac
  }
  const window = nightDuration(day) * s.dawnFrac;
  return phaseT < window ? lerp(1 - phaseT / window) : s.nightAmbient; // predawn lift
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
bun run test -- siege
```
Expected: PASS.

- [ ] **Step 5: Wire both draw call sites to the helper**

In `src/game.ts`, add `ambientForClock` to the import from `./systems/siege` (line 22):
```ts
import { ambientForClock, startDay, startNight, sysSiege } from "./systems/siege";
```
Replace `src/game.ts:307`:
```ts
  const ambient = state.phase === "day" ? CONFIG.siege.dayAmbient : CONFIG.siege.nightAmbient;
```
with:
```ts
  const ambient = ambientForClock(state.phase, state.phaseT, state.day);
```
Replace the identical line at `src/game.ts:382` with the same call.

- [ ] **Step 6: Typecheck, lint, test, build**

Run:
```bash
bun run typecheck && bun run lint && bun run test && bun run build
```
Expected: all pass.

- [ ] **Step 7: Playtest the gradient (feel gate)**

`bun run dev`. Watch the transition: late day should visibly darken into dusk, and the final stretch of night should lift toward a predawn glow before the shop opens. **State the result honestly.**

- [ ] **Step 8: Commit**

```bash
git add src/systems/siege.ts src/systems/siege.test.ts src/game.ts
git commit -m "feat(feel): clock-driven dusk/dawn ambient gradient"
```

---

## Task 8: Clock HUD readout + day/night dial

**Files:**
- Modify: `src/systems/siege.ts` (add `clockLabel`)
- Modify: `src/systems/siege.test.ts` (extend)
- Modify: `src/game.ts:831-839` (`updateHUD` phase block)
- Modify: `index.html` (add `#clock-dial` element near `#phase` ~line 370, and its CSS ~line 104)

**Interfaces:**
- Consumes: `nightDuration` (Task 4).
- Produces: `clockLabel(phase, phaseT, day): string` (HH:MM), and `clockFrac(phase, phaseT, day): number` (0→1 progress through the phase).

- [ ] **Step 1: Write the failing test (extend siege.test.ts)**

First grow the top import line in `src/systems/siege.test.ts` to include all four (avoids duplicate-import lint):
```ts
import { ambientForClock, clockFrac, clockLabel, nightDuration } from "./siege";
```
Then append this block (no new import statement):
```ts
describe("clockLabel / clockFrac", () => {
  it("day starts at 06:00 and ends at 18:00", () => {
    expect(clockLabel("day", 35, 1)).toBe("06:00"); // phaseT == dayDuration → start
    expect(clockLabel("day", 0, 1)).toBe("18:00"); // phaseT == 0 → dusk
  });
  it("night starts at 18:00 and ends at 06:00", () => {
    expect(clockLabel("night", nightDuration(1), 1)).toBe("18:00");
    expect(clockLabel("night", 0, 1)).toBe("06:00");
  });
  it("frac runs 0 at phase start to 1 at phase end", () => {
    expect(clockFrac("day", 35, 1)).toBeCloseTo(0, 5);
    expect(clockFrac("day", 0, 1)).toBeCloseTo(1, 5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
bun run test -- siege
```
Expected: FAIL — `clockLabel`/`clockFrac` not exported.

- [ ] **Step 3: Implement `clockFrac` and `clockLabel`**

In `src/systems/siege.ts`, add (import `clamp` from `../engine/math`):
```ts
/** 0 at the start of the current phase → 1 at its end. */
export function clockFrac(phase: State["phase"], phaseT: number, day: number): number {
  const dur = phase === "day" ? CONFIG.siege.dayDuration : nightDuration(day);
  return clamp(1 - phaseT / dur, 0, 1);
}

/** In-game time of day: day spans 06:00→18:00, night spans 18:00→06:00. */
export function clockLabel(phase: State["phase"], phaseT: number, day: number): string {
  const startH = phase === "day" ? 6 : 18;
  const t = startH + clockFrac(phase, phaseT, day) * 12; // hours into the 12h span
  const hh = Math.floor(t) % 24;
  const mm = Math.floor((t - Math.floor(t)) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
bun run test -- siege
```
Expected: PASS.

- [ ] **Step 5: Add the dial element + CSS in index.html**

In `index.html`, replace the phase line (370):
```html
      <div id="phase">DAY 1</div>
```
with:
```html
      <div id="phase">DAY 1 · 06:00</div>
      <div id="clock-dial" aria-hidden="true"></div>
```
Add CSS near the `#phase` rule (~line 104). After the existing `#phase.night{...}` rule add:
```css
  #clock-dial{width:34px;height:34px;border-radius:50%;margin-top:6px;
    background:conic-gradient(var(--amber) calc(var(--frac,0)*360deg), rgba(255,255,255,.08) 0);
    box-shadow:inset 0 0 0 2px rgba(0,0,0,.5);transition:background .2s linear;}
  #phase.night ~ #clock-dial{background:conic-gradient(var(--blood) calc(var(--frac,0)*360deg), rgba(255,255,255,.06) 0);}
```
(If `#clock-dial` is not a sibling directly after `#phase` in the DOM, drop the `~` selector and instead toggle a `.night` class on `#clock-dial` in Step 6.)

- [ ] **Step 6: Drive the clock + dial in `updateHUD`**

In `src/game.ts`, add `clockFrac` and `clockLabel` to the `./systems/siege` import. Replace the phase block (831-839):
```ts
  // day/night phase
  const phaseEl = el("phase");
  if (state.phase === "day") {
    phaseEl.textContent = `DAY ${state.day} · DUSK IN ${Math.ceil(state.phaseT)}s`;
    phaseEl.classList.remove("night");
  } else {
    phaseEl.textContent = `NIGHT ${state.day}`;
    phaseEl.classList.add("night");
  }
```
with:
```ts
  // day/night phase — an in-game clock; the dial fills toward dusk (day) / dawn (night)
  const phaseEl = el("phase");
  const label = clockLabel(state.phase, state.phaseT, state.day);
  phaseEl.textContent = `${state.phase === "day" ? "DAY" : "NIGHT"} ${state.day} · ${label}`;
  phaseEl.classList.toggle("night", state.phase === "night");
  el("clock-dial").style.setProperty("--frac", String(clockFrac(state.phase, state.phaseT, state.day)));
```

- [ ] **Step 7: Typecheck, lint, test, build**

Run:
```bash
bun run typecheck && bun run lint && bun run test && bun run build
```
Expected: all pass.

- [ ] **Step 8: Playtest the clock UI (feel gate)**

`bun run dev`. Confirm the HUD shows a moving time-of-day (e.g. `DAY 1 · 14:20`) and the dial fills smoothly toward dusk by day and toward dawn by night, reading as "this much until morning". **State the result honestly.**

- [ ] **Step 9: Commit**

```bash
git add src/systems/siege.ts src/systems/siege.test.ts src/game.ts index.html
git commit -m "feat(ui): in-game clock readout + day/night dial"
```

---

## Task 9: Remove "summon night early" (key + co-op event)

**Files:**
- Modify: `src/main.ts:18` (import), `src/main.ts:244` (Enter binding)
- Modify: `src/game.ts` (`startNightNow` ~932-941, export)
- Modify: `src/net/events.ts:16` (`nightStart` variant)
- Modify: `src/net/client.ts:251-253` (`requestNight`)
- Modify: `src/net/host.ts:4` (import), `src/net/host.ts:105-106` (handler)
- Modify: `src/net/net.ts:19` (`PROTOCOL_VERSION`)
- Modify: `index.html:414` (remove the Enter hint span)

**Interfaces:**
- Consumes: nothing new.
- Produces: removal only. Day→night is now fully automatic via `sysSiege` (host-authoritative).

- [ ] **Step 1: Remove the Enter key binding**

In `src/main.ts:244`, delete the line:
```ts
    if (e.code === "Enter" && state.running) startNightNow();
```
Remove `startNightNow` from the `./game` import at `src/main.ts:18`.

- [ ] **Step 2: Remove `startNightNow` from game.ts**

In `src/game.ts`, delete the entire `startNightNow` function (lines 932-941) and its doc comment above it. (After Task 6, `startNight` is only called by `sysSiege`; verify no other references with `rg -n "startNightNow" src` — expect zero after this and Step 4.)

- [ ] **Step 3: Remove the client request path**

In `src/net/client.ts`, delete the `requestNight()` method (lines 251-253):
```ts
  requestNight(): void {
    this.link.sendRel({ t: "nightStart" });
  }
```

- [ ] **Step 4: Remove the host handler and the event variant**

In `src/net/host.ts`, delete the handler branch (lines 105-106):
```ts
      } else if (msg.t === "nightStart") {
        startNightNow(); // idempotent (no-op unless we're in the day phase)
```
and remove `startNightNow` from the `../game` import at `src/net/host.ts:4`.

In `src/net/events.ts`, delete the `nightStart` variant (line 16):
```ts
  | { t: "nightStart" } // bring the night early (day phase only)
```

- [ ] **Step 5: Bump the protocol version**

In `src/net/net.ts:19`, change:
```ts
export const PROTOCOL_VERSION = 7;
```
to:
```ts
export const PROTOCOL_VERSION = 8;
```

- [ ] **Step 6: Remove the Enter control hint**

In `index.html:414`, change:
```html
      <span><b>Q</b> fortify (buy in shop)</span><span><b>Enter</b> start night early</span>
```
to:
```html
      <span><b>Q</b> fortify (buy in shop)</span>
```

- [ ] **Step 7: Typecheck, lint, test, build**

Run:
```bash
bun run typecheck && bun run lint && bun run test && bun run build && rg -n "startNightNow|nightStart" src
```
Expected: all gates pass; the `rg` finds zero matches.

- [ ] **Step 8: Playtest single-player (feel gate)**

`bun run dev`. Confirm Enter no longer forces night; day flows to night purely on the clock. Re-run the combined **#3 + #4 tuning playtest**: night should feel ferocious and the crowd should accumulate toward the cap so kiting collapses, yet dawn arrives by the clock as relief. Tune `CONFIG.siege` (`nightDuration*`, `nightMaxZombies`) and `src/data/phaseMods.ts` as needed and re-observe. **State the result honestly.**

- [ ] **Step 9: Commit**

```bash
git add src/main.ts src/game.ts src/net/events.ts src/net/client.ts src/net/host.ts src/net/net.ts index.html
git commit -m "feat(siege): remove manual \"summon night\" — cycle is fully clock-driven"
```

---

## Task 10: Consolidated final playtest (the deferred feel gate)

**Files:** none (verification + tuning only). This is the single playtest pass for the whole redesign. Tune `CONFIG.siege.*`, `CONFIG.fx.blood`, and `src/data/phaseMods.ts` as needed and re-observe; commit any tuning changes separately.

- [ ] **Step 1: Final automated gate**

Run:
```bash
bun run typecheck && bun run lint && bun run test && bun run build
```
Expected: all pass.

- [ ] **Step 2: Single-player feel pass**

`bun run dev`, play through at least day 1 → night 1 → dawn → day 2, and confirm each:
- **#1 wording** — title "Enter the Quarantine", shop "Face the Day", HUD "Fortify [Q]"; no stray "Deploy".
- **#3 day** — zombies are visibly slow, short-sighted, drifting; you can out-walk and slip past them while looting.
- **#4 dusk** — the day clock advances (HUD time + dial), light crossfades into dusk, and night begins automatically with **no Enter** (Enter does nothing now).
- **#3 night** — clearly ferocious: faster, wider sense, runners lunge, aggro latches on.
- **#4 night/dawn** — spawns keep coming and the crowd grows toward the cap; kiting collapses (you get cornered); **dawn arrives on the clock** even with zombies alive; sunrise sweeps the horde and the shop opens clean.
- **#4 ambient** — predawn light lift reads on screen before the shop.
- **#2 blood** — pools are layered clusters with a directional splatter on bullet impacts (not flat discs); darker centers / brighter edges; no glowing-light-source look under the night flashlight.

State the result honestly; tune and re-observe if any item is off.

- [ ] **Step 3: Two-client co-op smoke test**

Run `bun run dev:coop` (one-time: `cd signaling && bun install`). Host a room in one browser, join from a second. Confirm: clock + dial in sync on the client; day→night→dawn fire for both with no Enter; blood/ferocity/timed-dawn match single-player; no protocol-mismatch errors in the console (both version 8).

- [ ] **Step 4: Commit any tuning changes**

```bash
git add -A && git commit -m "tune(siege): playtest tuning pass for the cycle/feel redesign"
```
(Skip if no tuning was needed.)

---

## Self-review notes (spec coverage)

- **#1 wording** → Task 1 (+ Enter hint removal in Task 9). ✓
- **#2 blood** → Task 2 (`CONFIG.fx.blood`, multi-blob directional). ✓
- **#3 day/night AI** → Task 3 (`PHASE_MODS` data table, factors in the existing chain). ✓
- **#4 clock cycle** → Tasks 4 (duration), 5 (continuous capped spawn), 6 (timed dawn), 7 (ambient gradient), 8 (clock HUD), 9 (remove manual night + co-op). ✓
- **Co-op clock sync** → free: `phase`/`phaseT`/`day` already in the snapshot (snapshot.ts:145-147,503-507); verified in Task 10. ✓
- **Added beyond spec (justified, not a band-aid):** `nightMaxZombies` cap — continuous spawn is otherwise unbounded and would blow zombie count, perf, and snapshot size; the cap also IS the "cornered" pressure wall. Dawn-time zombie clear in Task 6 Step 3 — morning must start clean now that night ends with the horde alive.
- **Accepted trade-off:** time-based dawn enables theoretical kiting; the accumulating capped spawn makes it self-defeating, so no dedicated anti-kite code.
