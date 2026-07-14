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
bun run dev            # Vite game only at http://localhost:5173 (HMR). Boots to the title; Start can't connect without the worker (the game is a DO client) — use dev:coop to actually play.
bun run dev:coop       # game (Vite) + the worker (wrangler dev) together — the NORMAL dev command. The worker serves the authoritative Arena DO at ws://127.0.0.1:8787/arena/CODE. one-time: `cd worker && bun install`. Ctrl-C stops both.
bun run signal         # just the worker (cd worker && wrangler dev → ws://127.0.0.1:8787): the arena-only worker (Arena DO). The old WebRTC signaling relay was deleted in 2b-0.
bun run build          # tsc --noEmit && vite build  → dist/
bun run preview        # serve the production build
bun run typecheck      # tsc --noEmit
bun run lint           # biome check  (config-driven: game/, worker/, scripts/, configs)
bun run lint:fix       # biome check --write src index.html   (add --unsafe for template-literal/etc. fixes)
bun run format         # biome format --write src index.html
```

**Tests** use Vitest (`bun run test`, or `bun run test:watch`). By deliberate scope, only **pure, deterministic** code is tested — most of it now under `sim/`: `waveDef()` (`sim/data/waves.ts`), arsenal scaling (`sim/data/arsenal.ts`), math (`sim/engine/math.ts`), collision geometry (`sim/engine/geometry.ts`), `SpatialHash` (`sim/engine/spatialHash.ts`), `ammoTransfer` (`sim/systems/ammo.ts`), `flashlightIntensity` (`sim/systems/flashlight.ts`), `integrityGrade` (`sim/systems/integrity.ts`); plus the DO-server pure surface — `pickSlot`/`makeNonce`/`rejoinMatches` (`sim/net/roster.ts`), wire framing (`sim/net/wire.ts`), `sysSiege` (`sim/systems/siege.ts`), `stepSim` returns (`sim/step.ts`), `siegeEdgeCue` (`sim/systems/siegeEdge.ts`), the per-player shop apply/draft logic (`sim/systems/shop.ts`), `reconnectDelay` (`sim/net/reconnect.ts`), and the `CycleBlob` serialize/deserialize round-trip (`sim/net/persist.ts`). Tests are co-located as `*.test.ts`. The simulation "feel" (renderer, AI movement, camera, collision tuning, audio) is intentionally **not** unit-tested — validate that by playtesting. `vite.config.ts` carries the Vitest config (`environment: "node"`, since no DOM is needed).

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

- **`game/main.ts`** — initializes `Renderer` + `Input`, wires UI buttons and hotkeys (F flashlight, H medkit, M mute, P/Esc pause, E interact / open the fortress-workbench shop by day, Enter/Done to close the shop, shop navigation), and runs the rAF loop. **The browser is a DO client — it does NOT run the sim.** Start connects to the Arena DO (`createArenaLink(arenaUrl(code))`); the rAF frame samples input (rate-limited send), predicts the local player + interpolates the world from buffered snapshots (`Net.client.render`), advances client-side `sysFx`/`sysCamera` + `decayFlash`, then `draw()` + `updateHUD()`. It also **drives arena auto-reconnect**: a link `onClose` (primary) or the snapshot-starvation watchdog (backstop) → `Client.suspend` → backoff redial → `Client.rebind` (replays the `{pid,nonce}` rejoin token); a `currentLink` identity guard prevents parallel reconnect loops.

- **`game/game.ts`** — owns the client-side `state` singleton (rebuilt from snapshots) + client flow (`startClientGame` / client-local shop overlay open-close / `toTitle` / `renderArsenal` / `clientBanked` dawn-payout) + `draw()` / `updateHUD()` / `audioAmbience` / the client-owned screen-flash (`bumpFlash`/`decayFlash`). **It no longer runs the sim** — the authoritative step is `sim/step.ts` `stepSim`, run by the Arena DO (game.ts's `update()` was deleted in the DO cutover). The **fixed system order** now lives in `stepSim`: `sysPlayer → sysAssist → sysRespawn → sysAI → sysStalker → sysDeployables → sysBullets → sysPickups → sysSiege` — but the gameplay systems are **skipped while `phase` is `breached`/`resetting`** (the soft-reset freeze; `sysSiege` still runs to drive the reset clock). `stepSim` returns `"night"`/`"dawn"`/`"breached"`/`"reset"`/`null` (no `"wipe"`/game-over — an all-down party keeps running; respawn timers + the night clock carry to dawn); the **DO acts on `"dawn"`** (day++, `startDay`, draft roll, SALVAGE bank, straggler revive) **and on `"reset"`** (`resetArena` — communal Day-1 rebuild after a breach). Keep this orchestration in `sim/` so it stays headless.

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
  - `siege` (`sysSiege` + `startDay`/`startNight` + `seedRoamers`/`rearmThaw` + `resetArena` + `isFortressBreached`/`enterBreached`) — the day/night/breached/resetting machine; `sysSiege` returns `"night"`/`"dawn"`/`"breached"`/`"reset"`/`null` on the frame of transition. Breach = interior (HOME-rect) zombie count over `breachSustain`. `rearmThaw` re-arms the phase's spawner on persistence thaw WITHOUT `startDay`/`startNight` (which would clobber the restored `phaseT`/caches).
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

## Multiplayer (co-op) — DO-authoritative

**Authority runs on a Cloudflare Durable Object.** There is **no single-player mode**: every player is a **WebSocket client of one always-live Arena DO** that runs the sole authoritative sim (`sim/step.ts` `stepSim`) on a fixed-dt `setInterval` loop. Clients **predict their own player + interpolate snapshots**; they never run the sim. (There is no host-as-peer / WebRTC path — it was removed; see git history for `game/net/{host,transport,ticker}.ts` if you ever need its shape.) The arena is a **living, persistent world**: a day/night cycle that advances only while occupied, a per-player non-pausing fortress shop (`state.inShop` does not exist — shop-open is client-local), death → spectate → timed respawn, auto-reconnect, a `breached → resetting → day1` soft-reset when the fortress is overrun, and communal-cycle persistence across restarts.

Feel-first: own player/bullets predicted, others/enemies interpolated. **Derive-first fx — the wire carries ZERO `fxEvents`:** the client re-derives combat cues from snapshot diffs (`game/net/client.ts` `effects()`), siege transitions from the synced `phase` edge (`sim/systems/siegeEdge.ts` `siegeEdgeCue`), `lightDie` from the synced battery, and the full-screen damage flash / hurt shake from the local player's `hitFlash` edge (client-owned, per-viewer — not on `State`, not snapshotted). **The 2b② soft-reset is derive-first too:** the client hard-clears its interp buffer on the synced `resetting → day` phase edge (`sim/systems/siegeEdge.ts` `isArenaResetEdge`), so the Day-1 entity-id churn doesn't misfire as a mass-kill/spawn burst — **no `arenaReset` wire event was needed**. The event-capable snapshot format stays plumbed but unused. Systems stay **net-agnostic** — state + events, never importing net code.

- **`sim/step.ts`** — `stepSim(state, dt): "night"|"dawn"|"breached"|"reset"|null` — the headless authoritative step the DO runs. Returns the discrete siege outcome; the **DO acts on `"dawn"`** (day++/`startDay`/draft roll/SALVAGE bank/revive) **and `"reset"`** (`resetArena`, the Day-1 rebuild) — the world reactions that used to live in `game.ts`. No game-over (an all-down party keeps running). `breached`/`resetting` freeze the gameplay systems. **Excludes the cosmetic `sysFx`/`sysCamera`** (the client runs those itself).
- **`sim/net/`** (pure, shared by client + DO): `roster.ts` (`pickSlot` 0-based + `makeNonce` + `rejoinMatches`), `wire.ts` (1-byte-tag framing — snap binary + rel JSON multiplexed on **one** stream), `protocol.ts` (`PROTOCOL_VERSION`), `reconnect.ts` (`reconnectDelay` backoff), `persist.ts` (`CycleBlob` + `serializeCycle`/`applyCycle` — the communal-only cycle blob the DO freezes to / thaws from storage).
- **`worker/arena.ts`** — the `Arena` DO: one binary WebSocket per client at `/arena/:CODE`; runs the `stepSim` loop + broadcasts `frameSnap(encodeSnapshot)` at `CONFIG.net.sendHz`; `pickSlot`/nonce-rejoin/`graceMs` lifecycle ported from the old host.ts **minus any host player** (pids `0..N-1`). **Persistence:** a `constructor(ctx,_env)` `blockConcurrencyWhile`-loads the persisted `CycleBlob` on cold start; `persist()` writes it (fire-and-forget KV, skipping the `breached`/`resetting` beat) at each `dawn`/`night`/`reset` boundary + in `stop()` before nulling state; `ensureRunning` reconstructs from it (`applyCycle`+`rearmThaw`) or starts a fresh Day-1. So an empty arena stops the loop → **hibernates (duration billing stops)**, and a restart/eviction resumes from the last boundary instead of Day 1. **Standard WebSocket API, NOT Hibernation** (the Hibernation WS API is deliberately not adopted — an empty arena has no clients to keep attached). ⚠ **`server.binaryType = "arraybuffer"` MUST be set before `accept()`** — CF changelog 2026-04-21: with a compat date ≥ 2026-03-17 the standard WS API delivers binary frames as **Blob** by default, which would silently break every input/join frame. ⚠ the `join` handler commits a slot **`await`-free** (`pickSlot`→`decided` with no `await` between) — the only guard against a double-claim race (DO message handlers are sequential).
- **`game/net/`** (client): `wsLink.ts` (`createArenaLink` — a `PeerLink`-shaped adapter over the WebSocket, framing via `sim/net/wire`), `link.ts` (`PeerLink` interface), `client.ts` (`Client`: predict/interpolate/reconcile + derive fx + `siegeEdgeCue` + `suspend`/`rebind`/`onIdentity`/`onResumed` for auto-reconnect, driven by `main.ts`), `net.ts` (`Net` singleton, mode is only `"client"`), `signaling.ts` (`arenaUrl` dial), `localInput.ts`, `ghost.ts`.
- **`sim/snapshot.ts`** — binary `encode`/`decode` (int16 positions, id-matched), `applySnapshot`/`lerpSnapshots`. `phase` occupies **two** flag bits (4 `SiegePhase` values). Full snapshots only (delta compression is a later scaling concern). **`sim/playerInput.ts`** (`PlayerInput` + `emptyInput()`), **`sim/engine/players.ts`** (`makePlayer`/`localPlayer`/`anyAlive`/`addPlayer`/`removePlayer`/…).

**Invariants:** the DO **never globally pauses** — `state.paused` is never set server-side, and there is no `state.inShop` (shop-open is client-local UI; the DO gates purchasing on `phase === "day"`). `stepSim` returns discrete outcomes and the DO drives the world reactions; the `breached`/`resetting` beat freezes the sim by **gating the gameplay systems in `stepSim`, never by setting `paused`**. `PROTOCOL_VERSION` is **20** (the `hello` `v`-gate rejects stale clients — bump it on any wire-layout change). Reconcile constants in `CONFIG.net`: `interpDelayMs 150`/`smoothCorrect 0.15`/`snapTeleportThresh 120` (DO-hop tuned); client input send rate-limited to `inputHz` (latest-wins); `maxPlayers 12`. Reconnect (`CONFIG.net.reconnect`): `graceMs 20000` = how long the DO holds a dropped body `absent` for in-place re-attach. The client does **not** police grace — it just redials with `backoffMs`; the **DO** decides in-place-vs-fresh at rejoin time (`hello.resumed` reports which). Solo-drop in-place holds because grace (20s) ≪ the CF DO eviction floor (70–140s) — see the DO-capabilities memory before raising `graceMs`.

### Run / deploy
- `bun run dev:coop` — game (Vite) **+ the worker** (`wrangler dev`, which serves the Arena DO at `ws://127.0.0.1:8787/arena/CODE`). This is the normal dev command now — the game can't play without the DO. Connect: Start → `arenaUrl` → `.../arena/MAIN` (or `?arena=CODE`). One-time: `cd worker && bun install`.
- `bun run dev` — game only; boots to the title but Start fails to connect without the worker (surfaces "couldn't reach the arena").
- `bun run signal` — the worker alone (`cd worker && wrangler dev` → `ws://127.0.0.1:8787`).
- Deploy: worker + game together via **GitHub Actions only** (`deploy-worker.yml`, `workflow_dispatch`; needs `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`). DO placement is fixed at creation via `locationHint` (Japan → `apac-ne`). WebTransport / unreliable datagrams are **unavailable** on CF DO server-side (verified) — TCP WebSocket is the only transport.

### Not yet built (don't mistake for live)
- **Per-player progression persistence** across freeze/thaw/restart — only the *communal* cycle persists; per-player run-power (money/wlevel/gear) resets on join. Needs account identity, which doesn't exist yet.
- **"Drop carried SCRAP on death"** penalty (a game-model idea, not implemented).
- **~32-player scale** (density/interest-management, delta snapshots — snapshots are full-only today).
- **CrazyGames SDK + leaderboards + ads** (the timed-respawn seam is where a rewarded instant-respawn would plug in; the breach transition is where DO-side score submission would go).

Design docs for the DO-server work (game model, authority relocation, gameplay loop, persistence) live under `docs/superpowers/specs/` and `docs/superpowers/plans/`.
