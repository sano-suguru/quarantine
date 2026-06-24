# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

QUARANTINE is a top-down, wave-survival zombie shooter built on a custom WebGL2 engine. The game is a fixed-timestep simulation rendered with a single instanced draw call. The codebase is **data-driven by design**: adding a weapon, enemy, upgrade, or tuning the difficulty curve means adding/editing a data entry under `src/data/`, not touching the engine or systems.

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

**Tests** use Vitest (`bun run test`, or `bun run test:watch`). By deliberate scope, only **pure, deterministic** code is tested — `waveDef()` (`src/data/waves.ts`), the math helpers (`src/engine/math.ts`), and `SpatialHash` (`src/engine/spatialHash.ts`). Tests are co-located as `*.test.ts`. The simulation "feel" (renderer, AI movement, camera, collision tuning) is intentionally **not** unit-tested — validate that by playtesting. `vite.config.ts` carries the Vitest config (`environment: "node"`, since no DOM is needed).

## Architecture

Entry: `index.html` (markup + CSS) loads `src/main.ts` as a module.

- **`src/main.ts`** — initializes `Renderer` + `Input`, wires UI buttons and the shop hotkeys, and runs the game loop. Fixed-timestep accumulator at `CONFIG.simHz` (60 Hz): `update(step)` runs in a `while(acc >= step)` loop; `draw()` and `updateHUD()` run once per rAF.

- **`src/game.ts`** — owns the single mutable `state` singleton and the game flow (`startGame` / `openShop` / `chooseUpgrade` / `gameOver`) plus `update()` / `draw()` / `updateHUD()`. `update()` calls the systems **in a fixed order** (player → AI → bullets → wave → camera) and is the only place that detects UI transitions: it calls `gameOver()` when `player.hp <= 0` and `openShop()` when `sysWave` returns `true` (wave cleared). Keep this orchestration here so the systems stay pure.

- **`src/systems/*`** — pure logic over `state`, each takes `(state, dt)`. They never import UI or trigger transitions directly (avoids the circular dependency the original single-file version had baked in). `sysWave` *returns* a cleared-flag rather than calling `openShop`; `sysAI` clamps hp to 0 rather than calling `gameOver`.

- **`src/engine/renderer.ts`** — WebGL2. All entities are pushed as instances via `sprite`/`circle`/`rect` between `begin()` and `flush(camX, camY)`. One instanced draw for everything plus a full-screen grid-shader background. `FLOATS = 10` per instance (pos, scale, rot, rgba, shape flag) — changing the instance layout means updating both the shader attributes and the `sprite()` writer. Shaders live in `src/engine/shaders/*.{vert,frag}` and are imported with `?raw` (see `shaders.d.ts` for the module type declarations).

- **`src/engine/spatialHash.ts`** — uniform grid (cell 64) rebuilt each frame in `sysAI`; used for both zombie-zombie separation and bullet-zombie collision queries.

- **`src/data/*`** — the extension points. `weapons.ts` (`WEAPONS` + `WEAPON_ORDER`, order drives the `1/2/3` hotkeys), `enemies.ts` (`ENEMY_TYPES`), `waves.ts` (`waveDef(n)` — the difficulty curve), `upgrades.ts` (`UPGRADES`, each `{name, desc, apply(state)}` mutates run-wide multipliers like `state.dmgMul`).

- **`src/types.ts`** — all shared interfaces (`State`, `Player`, `Zombie`, `Bullet`, `WeaponDef`, `EnemyType`, `Upgrade`, …). `State.hash` is typed via the structural `SpatialHashLike` so `state.ts` need not depend on the engine class.

- **`src/ui.ts`** — thin typed DOM helpers only (`el`, `show`, `hide`). UI is intentionally **vanilla** — no framework, since the canvas rAF loop and a virtual DOM are a poor fit.

### Conventions
- Arrays use **swap-and-pop** removal (`killZombie`, `sysBullets`) — index-based, order not preserved.
- Coordinates are world-space; camera/grid convert to clip space in the shaders. Y is flipped in the vertex shader (`-clip.y`).
- Tune gameplay through the `src/data/` tables and `CONFIG`, not the systems.
- Upgrades mutate `state`, so data types are intentionally mutable (no `as const`).
