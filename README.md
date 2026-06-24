# QUARANTINE

A top-down, wave-survival zombie shooter prototype, built on a custom WebGL2 engine.
Hold the line, bank credits between waves, pick a field upgrade, repeat.

## Stack

- **[Bun](https://bun.sh)** — package manager + script runner
- **[Vite](https://vite.dev)** — dev server (HMR) + production bundler
- **TypeScript** (`strict`) — game logic
- **[Biome](https://biomejs.dev)** — linter + formatter (one tool)
- **[Vitest](https://vitest.dev)** — unit tests for the pure/deterministic logic
- **WebGL2** — single instanced draw call, no rendering library

## Getting started

```bash
bun install
bun run dev      # http://localhost:5173
```

If the Biome postinstall is blocked on first install, run `bun pm trust @biomejs/biome` once.

## Scripts

| Command | Description |
| --- | --- |
| `bun run dev` | Vite dev server with HMR |
| `bun run build` | Type-check then build to `dist/` |
| `bun run preview` | Serve the production build |
| `bun run test` | Run the test suite (Vitest) |
| `bun run test:watch` | Vitest in watch mode |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | Biome lint |
| `bun run lint:fix` | Biome lint with autofix (`--unsafe` for more) |
| `bun run format` | Biome format |

## Controls

| Input | Action |
| --- | --- |
| `WASD` | Move |
| Mouse | Aim |
| Click (hold) | Fire |
| `R` | Reload |
| `1` `2` `3` | Switch weapon |
| `Shift` | Sprint |

## Project layout

The engine is data-driven: adding a weapon, enemy, upgrade, or tuning the
difficulty curve means editing a table under `src/data/` — not the engine.

```
index.html          markup + CSS, loads src/main.ts
src/
  main.ts           init + fixed-timestep game loop
  game.ts           state singleton, flow, update/draw/HUD
  data/             weapons, enemies, waves, upgrades  ← extension points
  engine/           renderer (WebGL2), spatialHash, math, shaders/
  systems/          player, ai, bullets, wave, camera  (pure, take (state, dt))
```

See [CLAUDE.md](./CLAUDE.md) for architecture details.
