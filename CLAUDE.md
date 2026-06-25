# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

QUARANTINE is a top-down **day/night siege survival-horror** built on a custom WebGL2 engine. The simulation is fixed-timestep and rendered with a single instanced draw call. The core loop: by **day** you explore POIs, loot caches, and repair barricades around your shelter; by **night** you survive a zombie horde; on death you bank **SALVAGE** to permanently unlock weapons across runs (meta-progression). The codebase is **data-driven by design** — adding a weapon, enemy, upgrade, pickup, or tuning the difficulty curve means adding/editing a data entry under `src/data/` (or a constant in `src/config.ts`), not touching the engine or systems.

## Toolchain

- **Bun** — package manager + script runner (`bun install`, `bun run <script>`).
- **Vite** — dev server (HMR) and production bundler. GLSL shaders are imported as strings via `?raw`.
- **TypeScript** — `strict` + `noUncheckedIndexedAccess`. `tsc --noEmit` is type-check only; Vite does the actual transpile/bundle.
- **Biome** — single tool for lint **and** format (replaces ESLint + Prettier). Config in `biome.json`.

## Commands

```bash
bun install            # install deps (run `bun pm trust @biomejs/biome` once if postinstall is blocked)
bun run dev            # Vite dev server at http://localhost:5173 (HMR)
bun run build          # tsc --noEmit && vite build  → dist/
bun run preview        # serve the production build
bun run typecheck      # tsc --noEmit
bun run lint           # biome check src
bun run lint:fix       # biome check --write src   (add --unsafe for template-literal/etc. fixes)
bun run format         # biome format --write src index.html
```

**Tests** use Vitest (`bun run test`, or `bun run test:watch`). By deliberate scope, only **pure, deterministic** code is tested — `waveDef()` (`src/data/waves.ts`), arsenal scaling (`src/data/arsenal.ts`), the math helpers (`src/engine/math.ts`), collision geometry (`src/engine/geometry.ts`), `SpatialHash` (`src/engine/spatialHash.ts`), `ammoTransfer` (`src/systems/ammo.ts`), and `flashlightIntensity` (`src/systems/flashlight.ts`). Tests are co-located as `*.test.ts`. The simulation "feel" (renderer, AI movement, camera, collision tuning, audio) is intentionally **not** unit-tested — validate that by playtesting. `vite.config.ts` carries the Vitest config (`environment: "node"`, since no DOM is needed).

## Quality gates

Enforced locally via **Lefthook** git hooks (config in `lefthook.yml`; installed by `bun install` through the `prepare` script, or manually with `bunx lefthook install`):

- **pre-commit** — `biome check --write` on staged files. Safe fixes are auto-applied and re-staged; an unfixable lint error blocks the commit.
- **pre-push** — `bun run typecheck` + `bun run test`. A type error or failing test blocks the push.

There is no CI yet (deferred until a remote exists). To bypass a hook in an emergency: `git commit --no-verify` (avoid).

## Architecture

Entry: `index.html` (markup + CSS) loads `src/main.ts` as a module.

- **`src/main.ts`** — initializes `Renderer` + `Input`, wires UI buttons and hotkeys (F flashlight, H medkit, M mute, P/Esc pause, Enter deploy/skip-day, shop navigation), and runs the game loop. Fixed-timestep accumulator at `CONFIG.simHz` (60 Hz): `update(step)` runs in a `while(acc >= step)` loop; `draw()` and `updateHUD()` run once per rAF.

- **`src/game.ts`** — owns the single mutable `state` singleton and the game flow (`startGame` / `openShop` / `shopDeploy` / `gameOver` / `toTitle` / `renderArsenal`) plus `update()` / `draw()` / `updateHUD()`. `update()` calls the systems **in a fixed order**: `sysPlayer → sysAI → (gameOver if hp ≤ 0) → sysBullets → sysPickups → sysFx → sysSiege → sysCamera → audioAmbience`. This is the only place that detects UI transitions: `gameOver()` on `player.hp <= 0`, and **`sysSiege`'s return value** drives the rest — `"night"` triggers the night announcement, `"dawn"` (wave cleared) calls `openShop()`. Keep this orchestration here so the systems stay pure.

- **`src/config.ts`** — a single `CONFIG` tree holding **all tuning constants**: physics, feel/hitstop, camera, flashlight battery, healing, ammo, siege day/night durations and ambient light, cache loot, arsenal salvage/upgrade costs, and horror dread thresholds. Tune gameplay here, not in the systems.

- **`src/state.ts`** — `newState()` factory building the complete run-state (player, zombies, bullets, pickups, particles, decals, walls, barricades, caches, phase/day tracking, owned weapons, weapon upgrade levels, spatial hash). Loads meta for weapon ownership and seeds reserve/mag per `WEAPON_ORDER`.

- **`src/meta.ts`** — cross-run persistence in `localStorage` (key `q_meta`): `loadMeta` / `saveMeta` / `addSalvage` / `buyUnlock`. Tracks the SALVAGE balance and weapon unlock flags that survive between runs.

- **`src/input.ts`** — `Input` singleton (keyboard `Set`, mouse position, firing state). `init()` wires DOM events; stays pure and never calls systems.

- **`src/systems/*`** — pure logic over `state`, each takes `(state, dt)`. They never import UI or trigger transitions directly (avoids the circular dependency the original single-file version had baked in) — they return events instead. The set:
  - `player` — movement/aim/reload/weapon-switch/fire (or melee)/interact (E to repair or search).
  - `ai` (`sysAI`) — two passes: per-zombie steering + wall/barricade collision + melee attack, then a hard positional de-overlap via the spatial hash. Tracks `surrounded`/`lurking` counts that feed the audio dread.
  - `bullets` (`sysBullets` + `killZombie`) — advance bullets, spatial-hash collision, damage/knockback, kill + drop + bounty + hitstop/shake.
  - `pickups` (`sysPickups`, `spawnPickup`, `dropFromKill`) — life decay and auto-collect within grab radius.
  - `fx` (`sysFx` + `fxMuzzle`/`fxImpact`/`fxKill`/…) — particles, floating damage text, and blood decals, each capped.
  - `siege` (`sysSiege` + `startDay`/`startNight`) — the day/night loop; `sysSiege` returns `"night"` / `"dawn"` / `null` on the frame of transition.
  - `wave` (`sysWave`, `startWave`, `spawnZombie`) — spawns batches from the queue; `sysWave` returns `true` when the horde is cleared.
  - `camera` — exponential lerp toward the player and shake decay.
  - Pure helpers (unit-tested): `ammo` (`ammoTransfer`), `flashlight` (`flashlightIntensity`), and `caches` (`restockCaches`/`lootCache`, loot emitted as normal pickups).

- **`src/data/*`** — the extension points. Note the split between **definitions** and **run-scaling**:
  - `weapons.ts` — weapon definitions: `WEAPONS` (id → `WeaponDef`), `WEAPON_ORDER` (array order drives the `1/2/3…` hotkey slots), `STARTER_WEAPONS`, `UNLOCKABLE` (meta-unlock prices).
  - `arsenal.ts` — run-scoped layer over the definitions: `effWeapon(state, id)` (base stats + per-level damage/mag scaling), `storeItems(state)` (shop list), plus `scaledDmg`/`scaledMag`/`levelCost`.
  - `enemies.ts` (`ENEMY_TYPES`), `waves.ts` (`waveDef(n)` — the difficulty curve), `upgrades.ts` (`UPGRADES`, each `{name, desc, apply(state)}` mutates run-wide multipliers like `state.dmgMul`), `pickups.ts` (`PICKUP_TYPES`, each with an `apply(state)` callback), `map.ts` (`HOME` + `POIS`: walls, boardable openings, and cache spots).

- **`src/engine/renderer.ts`** — WebGL2. All entities are pushed as instances via `sprite`/`circle`/`rect`/`ring`/`tri`/`hex`/`glow`/`add` between `begin()` and `flush(camX, camY)`. One instanced draw for everything (normal + additive glow layers) plus a full-screen grid-shader background, with an aimed **flashlight cone** lighting model set per-frame via `setLight`/`setFlashlight` (central to the horror feel). `FLOATS = 10` per instance — layout `[x, y, sx, sy, rot, r, g, b, a, shape]` where `shape` indexes the `SHAPE` enum (rect/circle/glow/ring/tri/hex). Changing the instance layout means updating both the shader attributes and the writer. Shaders live in `src/engine/shaders/*.{vert,frag}` and are imported with `?raw` (see `shaders.d.ts`).

- **`src/engine/spatialHash.ts`** — uniform grid (cell 64) rebuilt each frame in `sysAI`; used for zombie-zombie separation, bullet-zombie collision queries, and light culling.

- **`src/engine/geometry.ts`** — pure collision helpers (`closestPointOnSegment`, `circlePushFromSegment`, `circlePush`, `segmentHitsSegment`) used for walls and barricades.

- **`src/engine/audio.ts`** — `Audio` singleton, **fully procedural** Web Audio (oscillators + noise + envelopes, no asset files), including the dread/heartbeat/groan ambience driven from `game.ts:audioAmbience`.

- **`src/types.ts`** — all shared interfaces (`State`, `Player`, `Zombie`, `Bullet`, `WeaponDef`, `EnemyType`, `Upgrade`, …). `State.hash` is typed via the structural `SpatialHashLike` so `state.ts` need not depend on the engine class.

- **`src/ui.ts`** — thin typed DOM helpers only (`el`, `show`, `hide`). UI is intentionally **vanilla** — no framework, since the canvas rAF loop and a virtual DOM are a poor fit.

### Conventions
- Arrays use **swap-and-pop** removal (`killZombie`, `sysBullets`) — index-based, order not preserved.
- Coordinates are world-space; camera/grid convert to clip space in the shaders. Y is flipped in the vertex shader (`-clip.y`).
- Tune gameplay through the `src/data/` tables and `CONFIG`, not the systems.
- Upgrades mutate `state`, so data types are intentionally mutable (no `as const`).
