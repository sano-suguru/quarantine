# QUARANTINE repository instructions

QUARANTINE is a TypeScript/WebGL2 top-down day/night siege survival-horror game. Favor feel-first, data-driven changes: tune gameplay through `game/config.ts` and `game/data/` tables before touching systems or engine code.

## Commands

Use Bun (`packageManager: bun@1.3.14`).

| Task | Command |
| --- | --- |
| Install dependencies | `bun install` |
| Start game dev server | `bun run dev` |
| Start game + local arena worker | `bun run dev:coop` |
| Start arena worker only | `bun run signal` |
| Type-check root game + scripts | `bun run typecheck` |
| Run all tests | `bun run test` |
| Run one test file | `bun run test -- game/data/waves.test.ts` |
| Run one test by name | `bun run test -- game/data/waves.test.ts -t "waveDef"` |
| Lint | `bun run lint` |
| Autofix lint/format issues | `bun run lint:fix` |
| Format | `bun run format` |
| Build production bundle | `bun run build` |
| Coverage | `bun run coverage` |

If Biome postinstall is blocked after install, run `bun pm trust @biomejs/biome` once. Worker-local dependencies live under `worker/`; for worker-only dev use `cd worker && bun install && bunx wrangler dev`.

## MCP servers

Workspace MCP configuration lives in `.vscode/mcp.json`. It includes a pinned official Playwright MCP server for browser automation against the Vite dev server; start `bun run dev` first, then use it for UI smoke checks, screenshots, and manual playtest support. Review and trust local MCP servers before starting them because they execute commands on the machine. Update the pin deliberately after reviewing upstream release notes.

## Architecture

- `index.html` loads `game/main.ts`, which initializes renderer/input/UI bindings and runs the fixed-timestep loop at `CONFIG.simHz`.
- `game/game.ts` owns the mutable `state` singleton, game flow, HUD/draw orchestration, and the only UI-phase transitions. Its update order is intentional: player, AI, death check, bullets, pickups, FX, siege, camera, ambience.
- `game/state.ts` constructs complete run state, including players, entities, walls/barricades/caches, meta-owned weapons, and spatial hash state.
- `game/systems/` contains simulation systems over `(state, dt)`. Keep systems UI-free and net-agnostic; return events instead of triggering transitions directly.
- `game/data/` is the content and tuning extension seam: weapons, arsenal scaling, enemies, waves, upgrades, pickups, deployables, phase mods, and map data. Add content here when possible.
- `game/config.ts` holds cross-cutting constants for physics, feel, camera, flashlight, healing, ammo, siege timing, loot, arsenal costs, and networking.
- `game/engine/` contains WebGL2 rendering, procedural audio, math/geometry helpers, lights, sprite assets, players, and `SpatialHash`. Renderer instances share the `[x, y, sx, sy, rot, r, g, b, a, shape]` layout.
- `game/net/` implements 2-4 player co-op. The host is authoritative and runs the sim; clients send intent, predict local player feel, and interpolate snapshots.
- `worker/` is the Cloudflare Worker/Durable Object authoritative arena server and static game host. `index.ts` routes `/arena/:CODE` WebSocket upgrades to the `Arena` DO, which runs the sole authoritative sim loop. It has its own package/lock/tsconfig and is type-checked separately in CI.

## Project-specific conventions

- Preserve single-player behavior when touching co-op. The three runtime paths are: single-player updates in `requestAnimationFrame`; host updates and broadcasts on the worker ticker; client sends input and renders interpolated/predicted snapshots without running `update()`.
- Shared run economy/progression state lives on `state`; per-player gear/ammo/health/flashlight state lives on `Player` and is synced in snapshots.
- Co-op clients send intent only (`input`, `buy`, `deploy`, `nightStart`). The host validates and applies actions once; keep buy/deploy/night-start paths idempotent.
- Tests deliberately focus on pure, deterministic logic. Rendering, audio, AI movement feel, camera feel, and other experiential changes require playtesting; do not claim feel changes are done from type-checks alone.
- Arrays commonly use swap-and-pop removal; entity order is not stable.
- TypeScript is strict with `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `verbatimModuleSyntax`, and `isolatedModules`. Avoid casts that bypass these constraints.
- Biome is the formatter/linter: 2-space indent, double quotes, semicolons, trailing commas, 100-column line width, import types required.
- Local hooks: pre-commit runs Biome on staged files and re-stages safe fixes; pre-push runs typecheck and tests. CI additionally runs coverage, build, and informational `knip`; worker CI runs `bunx tsc --noEmit --project worker/tsconfig.json`.
- Deploy the Worker/game via `.github/workflows/deploy-worker.yml` only. Do not use local `wrangler deploy` for normal deployment.
- Input/control source of truth is the live UI plus `game/main.ts` and `game/net/localInput.ts`; update those together when changing controls.
