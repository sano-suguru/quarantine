# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

QUARANTINE is a top-down **day/night siege survival-horror** built on a custom WebGL2 engine. The simulation is fixed-timestep and rendered with a single instanced draw call. The core loop: by **day** you explore POIs, loot caches, and repair barricades around your shelter; by **night** you survive a zombie horde; on death you bank **SALVAGE** to permanently unlock weapons across runs (meta-progression). The codebase is **data-driven by design** — adding a weapon, enemy, upgrade, pickup, or tuning the difficulty curve means adding/editing a data entry under `sim/data/` (or a constant in `sim/config.ts`), not touching the engine or systems.

## Design principles

Two non-negotiables that shape how to work here:

- **Feel-first, playtest-verified.** This is a horror game; fear and game-feel (the "juice") are the product. Anything touching feel — movement, firing, camera, audio/dread, lighting, netcode latency — is **not done until it's been played and felt**, not just compiled and tested. State results honestly; never claim a feel change works without it having been exercised.
- **Data-driven, zero special-case debt.** New content/behavior rides the existing data tables and config (`sim/data/`, `CONFIG`) and the established system seams — don't bolt on bespoke code paths or one-off branches. If something doesn't fit the existing mechanism, extend the mechanism rather than carve an exception.

## Toolchain

- **Bun** — package manager + script runner (`bun install`, `bun run <script>`).
- **Vite** — dev server (HMR) and production bundler. GLSL shaders are imported as strings via `?raw`.
- **TypeScript** — `strict` + `noUncheckedIndexedAccess`. `tsc --noEmit` is type-check only; Vite does the actual transpile/bundle.
- **Biome** — single tool for lint **and** format (replaces ESLint + Prettier). Config in `biome.json`.

## Commands

```bash
bun install            # install deps (run `bun pm trust @biomejs/biome` once if postinstall is blocked)
bun run dev            # Vite dev server at http://localhost:5173 (HMR). Single-player + manual-SDP co-op need nothing else.
bun run dev:coop       # game (Vite) + signaling relay (wrangler dev) together — needed only for ROOM-CODE co-op.
                       #   one-time: `cd worker && bun install`. Ctrl-C stops both.
bun run signal         # just the signaling relay (cd worker && wrangler dev → ws://127.0.0.1:8787)
bun run build          # tsc --noEmit && vite build  → dist/
bun run preview        # serve the production build
bun run typecheck      # tsc --noEmit
bun run lint           # biome check  (config-driven: game/, worker/, scripts/, configs)
bun run lint:fix       # biome check --write src index.html   (add --unsafe for template-literal/etc. fixes)
bun run format         # biome format --write src index.html
```

**Tests** use Vitest (`bun run test`, or `bun run test:watch`). By deliberate scope, only **pure, deterministic** code is tested — `waveDef()` (`game/data/waves.ts`), arsenal scaling (`game/data/arsenal.ts`), the math helpers (`game/engine/math.ts`), collision geometry (`game/engine/geometry.ts`), `SpatialHash` (`game/engine/spatialHash.ts`), `ammoTransfer` (`game/systems/ammo.ts`), `flashlightIntensity` (`game/systems/flashlight.ts`), and `integrityGrade` (`game/systems/integrity.ts`). Tests are co-located as `*.test.ts`. The simulation "feel" (renderer, AI movement, camera, collision tuning, audio) is intentionally **not** unit-tested — validate that by playtesting. `vite.config.ts` carries the Vitest config (`environment: "node"`, since no DOM is needed).

## Quality gates

Enforced **locally** via **Lefthook** git hooks (config in `lefthook.yml`; installed by `bun install` through the `prepare` script, or manually with `bunx lefthook install`), and **remotely** via **GitHub Actions CI**.

Local hooks (fast feedback):

- **pre-commit** — `biome check --write` on staged files. Safe fixes are auto-applied and re-staged; an unfixable lint error blocks the commit.
- **pre-push** — `bun run typecheck` + `bun run test`. A type error or failing test blocks the push.

CI (`.github/workflows/ci.yml`, runs on PRs and on push to `main`) is the merge gate — two required status checks protect `main`:

- **check** — `bun install --frozen-lockfile`, then `typecheck` + `lint` + `coverage` + `build`. `knip` (dead-code) also runs but is informational (`continue-on-error`), since data tables add exports that knip transiently flags.
- **worker** — type-checks `worker/` (its own package.json, excluded from the root tsc/build; biome covers it via config) with the root-pinned `tsc`.

A PR can't merge until both checks pass (`gh pr merge --auto` queues it to merge when they're green). To bypass a local hook in an emergency: `git commit --no-verify` (avoid) — CI still gates the merge.

## Architecture

Entry: `index.html` (markup + CSS) loads `game/main.ts` as a module.

- **`game/main.ts`** — initializes `Renderer` + `Input`, wires UI buttons and hotkeys (F flashlight, H medkit, M mute, P/Esc pause, Enter deploy/skip-day, shop navigation), and runs the game loop. Fixed-timestep accumulator at `CONFIG.simHz` (60 Hz): `update(step)` runs in a `while(acc >= step)` loop; `draw()` and `updateHUD()` run once per rAF.

- **`game/game.ts`** — owns the single mutable `state` singleton and the game flow (`startGame` / `openShop` / `shopDeploy` / `gameOver` / `toTitle` / `renderArsenal`) plus `update()` / `draw()` / `updateHUD()`. `update()` calls the systems **in a fixed order**: `sysPlayer → sysAI → (gameOver if hp ≤ 0) → sysBullets → sysPickups → sysFx → sysSiege → sysCamera → audioAmbience`. This is the only place that detects UI transitions: `gameOver()` on `player.hp <= 0`, and **`sysSiege`'s return value** drives the rest — `"night"` triggers the night announcement, `"dawn"` (wave cleared) calls `openShop()`. Keep this orchestration here so the systems stay pure.

- **`sim/config.ts`** — a single `CONFIG` tree holding **all tuning constants**: physics, feel/hitstop, camera, flashlight battery, healing, ammo, siege day/night durations and ambient light, cache loot, arsenal salvage/upgrade costs, and horror dread thresholds. Tune gameplay here, not in the systems.

- **`sim/state.ts`** — `newState()` factory building the complete run-state (player, zombies, bullets, pickups, particles, decals, walls, barricades, caches, phase/day tracking, owned weapons, weapon upgrade levels, spatial hash). Loads meta for weapon ownership and seeds reserve/mag per `WEAPON_ORDER`.

- **`game/meta.ts`** — cross-run persistence in `localStorage` (key `q_meta`): `loadMeta` / `saveMeta` / `addSalvage` / `buyUnlock`. Tracks the SALVAGE balance and weapon unlock flags that survive between runs.

- **`game/input.ts`** — `Input` singleton (keyboard `Set`, mouse position, firing state). `init()` wires DOM events; stays pure and never calls systems.

- **`sim/systems/*`** — pure logic over `state`, each takes `(state, dt)`. They never import UI or trigger transitions directly (avoids the circular dependency the original single-file version had baked in) — they return events instead. Note: `game/systems/stalkerFx.ts` and `game/systems/stalkerPhantom.ts` stayed in `game/` (they need the renderer). The set:
  - `player` — movement/aim/reload/weapon-switch/fire (or melee)/interact (E to repair or search).
  - `ai` (`sysAI`) — two passes: per-zombie steering + wall/barricade collision + melee attack, then a hard positional de-overlap via the spatial hash. Tracks `surrounded`/`lurking` counts that feed the audio dread.
  - `bullets` (`sysBullets` + `killZombie`) — advance bullets, spatial-hash collision, damage/knockback, kill + drop + bounty + hitstop/shake.
  - `pickups` (`sysPickups`, `spawnPickup`, `dropFromKill`) — life decay and auto-collect within grab radius.
  - `fx` (`sysFx` + `fxMuzzle`/`fxImpact`/`fxKill`/…) — particles, floating damage text, and blood decals, each capped.
  - `siege` (`sysSiege` + `startDay`/`startNight`) — the day/night loop; `sysSiege` returns `"night"` / `"dawn"` / `null` on the frame of transition.
  - `wave` (`sysWave`, `startWave`, `spawnZombie`) — spawns batches from the queue; `sysWave` returns `true` when the horde is cleared.
  - `camera` — exponential lerp toward the player and shake decay.
  - Pure helpers (unit-tested): `ammo` (`ammoTransfer`), `flashlight` (`flashlightIntensity`), `integrity` (`integrityGrade`), and `caches` (`restockCaches`/`lootCache`, loot emitted as normal pickups).

- **`sim/data/*`** — the extension points. Note the split between **definitions** and **run-scaling**:
  - `weapons.ts` — weapon definitions: `WEAPONS` (id → `WeaponDef`), `WEAPON_ORDER` (array order drives the `1/2/3…` hotkey slots), `STARTER_WEAPONS`, `UNLOCKABLE` (meta-unlock prices).
  - `arsenal.ts` — run-scoped layer over the definitions: `effWeapon(state, id)` (base stats + per-level damage/mag scaling), `storeItems(state)` (shop list), plus `scaledDmg`/`scaledMag`/`levelCost`.
  - `enemies.ts` (`ENEMY_TYPES`), `waves.ts` (`waveDef(n)` — the difficulty curve), `upgrades.ts` (`UPGRADES`, each `{name, desc, apply(state)}` mutates run-wide multipliers like `state.dmgMul`), `pickups.ts` (`PICKUP_TYPES`, each with an `apply(state)` callback), `map.ts` (`HOME` + `POIS`: walls, boardable openings, and cache spots).

- **`game/engine/renderer.ts`** — WebGL2. All entities are pushed as instances via `sprite`/`circle`/`rect`/`ring`/`tri`/`hex`/`glow`/`add` between `begin()` and `flush(camX, camY)`. One instanced draw for everything (normal + additive glow layers) plus a full-screen grid-shader background, with an aimed **flashlight cone** lighting model set per-frame via `setLight`/`setFlashlight` (central to the horror feel). `FLOATS = 10` per instance — layout `[x, y, sx, sy, rot, r, g, b, a, shape]` where `shape` indexes the `SHAPE` enum (rect/circle/glow/ring/tri/hex). Changing the instance layout means updating both the shader attributes and the writer. Shaders live in `game/engine/shaders/*.{vert,frag}` and are imported with `?raw` (see `shaders.d.ts`).

- **`sim/engine/spatialHash.ts`** — uniform grid (cell 64) rebuilt each frame in `sysAI`; used for zombie-zombie separation, bullet-zombie collision queries, and light culling.

- **`sim/engine/geometry.ts`** — pure collision helpers (`closestPointOnSegment`, `circlePushFromSegment`, `circlePush`, `segmentHitsSegment`) used for walls and barricades.

- **`game/engine/audio.ts`** — `Audio` singleton, **fully procedural** Web Audio (oscillators + noise + envelopes, no asset files), including the dread/heartbeat/groan ambience driven from `game.ts:audioAmbience`.

- **`sim/types.ts`** — all shared interfaces (`State`, `Player`, `Zombie`, `Bullet`, `WeaponDef`, `EnemyType`, `Upgrade`, …). `State.hash` is typed via the structural `SpatialHashLike` so `state.ts` need not depend on the engine class.

- **`game/ui.ts`** — thin typed DOM helpers only (`el`, `show`, `hide`). UI is intentionally **vanilla** — no framework, since the canvas rAF loop and a virtual DOM are a poor fit.

### Conventions
- Arrays use **swap-and-pop** removal (`killZombie`, `sysBullets`) — index-based, order not preserved.
- Coordinates are world-space; camera/grid convert to clip space in the shaders. Y is flipped in the vertex shader (`-clip.y`).
- Tune gameplay through the `sim/data/` tables and `CONFIG`, not the systems.
- Upgrades mutate `state`, so data types are intentionally mutable (no `as const`).
- The top-level `sim/` holds the pure simulation closure: no DOM, no WebGL, no audio — enforced by `sim/tsconfig.json` (`lib: ["ES2022"]`, `types: []`). `game/engine/` and `game/systems/stalker*.ts` are the client-side layer that stays in `game/`.

## Multiplayer (co-op)

2–4 player co-op PvE, **method C = host-as-peer (listen server)**. WebRTC DataChannel P2P; **one player's browser is the authoritative host** (no dedicated game server). Only the host runs `update()`; clients don't re-run the sim — they **predict their own player and interpolate snapshots**. Because clients never re-simulate, **no RNG seeding is needed**. Feel-first: own player/bullets are predicted, others/enemies interpolated, hit SFX/blood/kills re-derived by the client from snapshot diffs. Two DataChannels per peer: `snap` (unreliable/unordered, latest-wins world snapshots) and `rel` (reliable/ordered: input, hello, co-op events).

Co-op spans host-authoritative shop/economy, death/spectate/dawn-respawn, gameOver + salvage sync, and room-code auto-connect. Systems stay **net-agnostic** — they communicate via state + events, never importing net code.

- **`game/net/`** — the networking layer (kept out of `systems/`):
  - `transport.ts` — `PeerLink` (one `RTCPeerConnection` + the two channels) and manual-SDP helpers `createHostLink`/`createClientLink` (non-trickle ICE: wait for gathering, ship one SDP code). `resolveIceServers()` builds the ICE config: static STUN from `CONFIG.net.iceServers` plus, over https, **ephemeral TURN creds fetched from the Worker's `/turn`** (merged, cached per session). `waitIceComplete` early-resolves once the needed candidate type is gathered — a reflexive candidate STUN-only, or a **relay** candidate when TURN is configured — with a CONFIG-driven grace + hard cap (replaced a flat 3 s that truncated slow candidates). `?netlog`/`localStorage.netlog` prints `[net host]`/`[net client]` ICE diagnostics (candidate type/protocol only, never addresses).
  - `host.ts` — `Host`: holds N `PeerLink`s (hub & spoke), assigns pids, sends Hello + `addPlayer` on open, applies each peer's input/buy/deploy/nightStart, `broadcast(tick)` + `broadcastGameOver`.
  - `client.ts` — `Client`: buffers snapshots, interpolates remote entities at `now - interpDelay`, predicts the local player (`integrateMovement`) and reconciles on each snapshot, re-derives hit/kill/hurt fx + audio from snapshot diffs, predicts firing feel + ghost tracers.
  - `signaling.ts` — room-code auto-connect: `hostRoom`/`joinRoom` wrap the transport helpers and carry the SDP codes over a WebSocket relay. `roomUrl()` uses `wss://` + **`location.host`** when served over https (the single-Worker deploy is same-origin), and `ws://` + `CONFIG.net.signalUrl` over http (localhost dev only). Client failure surfacing: `joinRoom` resolves when the answer is sent, so `main.ts` wires `link.onOpen`/`onClose` + a `CONFIG.net.p2pOpenTimeoutMs` timeout to show a real "couldn't connect" instead of a silent wait.
  - `events.ts` — `CoopEvent` (client→host: `buy`/`deploy`/`nightStart`) and `HostEvent` (host→client: `gameover`). `net.ts` — `NetMsg` union + the `Net` mode/host/client singleton.
  - `localInput.ts` (the only DOM/Input boundary; returns empty input when the local player is dead), `ticker.ts` (Blob Web Worker clock so the host keeps simming + broadcasting while its tab is backgrounded), `ghost.ts` (pure `advanceGhosts` for visual-only predicted tracers).
- **`sim/snapshot.ts`** — binary `encode`/`decode` (int16-quantized positions, type indices, id-matched), `captureSnapshot`/`applySnapshot`, `lerpSnapshots`. **Full snapshots only — delta compression not implemented** (≤16KB even with ~60 zombies; revisit if bandwidth bites).
- **`sim/playerInput.ts`** — serializable per-player input (`PlayerInput` interface + `emptyInput()`). Lives in `sim/` so the sim can type-check inputs without a DOM dependency.
- **`sim/engine/players.ts`** — `players[]` helpers: `makePlayer`/`localPlayer`/`nearestPlayer`/`cameraTarget` (spectate a teammate while down)/`anyAlive`/`addPlayer`/`removePlayer`/`revivePlayer` (dawn respawn).
- **`worker/`** — Cloudflare Worker + Durable Object signaling relay (`room.ts`, `wrangler.toml`, `README.md`). Per-code `idFromName` routing (room codes upper-cased), relays offer/answer host↔client. **SQLite-backed DO class** (`new_sqlite_classes`) so it runs on the free Workers plan; **Hibernation deliberately NOT used** (it would discard the in-memory socket map between idle signaling messages). Host close → `hostgone`. Also: **serves the built game** via Static Assets (`[assets] directory = "../dist"`; non-asset paths fall through to the Worker `fetch`, so `/room/CODE` still hits the DO), and **`POST /turn`** mints ephemeral Cloudflare Realtime TURN creds (TURN key secret stays server-side) behind a same-origin guard and a **fail-closed monthly budget cap** (no native CF spend limit exists; usage summed via GraphQL `callsTurnUsageAdaptiveGroups`, cached). See `worker/README.md` for the secret/TURN/runbook details. Excluded from the main tsc/build (own `tsconfig.json`); biome covers it via config.

### Run modes
- `bun run dev` — game only (single-player + manual-SDP co-op need nothing else).
- `bun run dev:coop` — game (Vite) + signaling (`wrangler dev`) together via `concurrently`; needed for room-code co-op. One-time: `cd worker && bun install`.
- `bun run signal` — signaling relay only (`ws://127.0.0.1:8787`).

The three frame paths in `main.ts`: **single** runs `update()` in rAF; **host** runs `update()` + `broadcast` on the worker ticker (rAF only draws); **client** sends input + renders interpolated/predicted snapshots (no `update()`). Single-player must stay byte-for-byte unchanged when touching co-op code.

### Networking conventions
- Host-authoritative everything. Clients send intent (input + reliable co-op events); the host validates and applies once (idempotent guards on deploy/nightStart). Buy routes the buyer by the requesting peer's pid (`StoreItem.buy(s, buyer)`).
- Shared run state lives directly on `state` (money/kills/dmgMul/fireRateMul/reserveMul/owned/wlevel); per-player gear (ammo/reserve/mags/medkits/weapon/battery/speed) lives on `Player` and is synced in snapshots.
- Lobby (`wireCoop` in `main.ts` + `#lobby` in `index.html`): room code is primary; manual SDP is a `<details>` fallback that hides the room-code UI while open. Squad count comes from `host.connected`.
- Co-op networking config lives in `CONFIG.net`: interp/prediction params, `signalUrl` (**dev-only** now — prod derives the host from `location.host`), `iceServers` (static STUN; TURN is added at runtime from `/turn`), `iceGatherMaxMs`/`iceGatherGraceMs` (non-trickle gathering), `p2pOpenTimeoutMs` (client connect-failure timeout).

### Deploy
The signaling Worker **and the game** deploy together via **GitHub Actions only** (`.github/workflows/deploy-worker.yml`), never a local `wrangler deploy`. The workflow is `workflow_dispatch`-only: it sets up bun, runs `bun run build` (so `dist/` exists for the `[assets]` upload), then `wrangler-action`. It requires a GitHub remote plus `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repo secrets. The deployed host serves the game over https same-origin (so no `signalUrl` hardcoding). **NAT reality:** home↔home connects on STUN alone; symmetric NAT/CGNAT/mobile/corporate need the **TURN relay** (`/turn`, Cloudflare Realtime TURN, incl. TURNS-443) — configured by **Worker secrets** `TURN_KEY_ID`/`TURN_TOKEN`/`CF_ACCOUNT_ID`/`CF_ANALYTICS_TOKEN` (dashboard-set, persist across deploys; budget guard fails closed without them). Corporate SASE/SWG (Netskope/Zscaler) may block WebRTC even with the agent off; TURNS-443 rescues many but not all → personal device/network is the reliable path. **Method-C limitations to set expectations:** host disconnect ends the session for everyone (no host migration), and SALVAGE banks only at a clean game-over (a mid-run host drop forfeits it). See `worker/README.md` for TURN secrets, the budget cap, and the runbook.
