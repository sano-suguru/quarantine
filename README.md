# QUARANTINE

A top-down **day/night siege survival-horror**, built on a custom WebGL2 engine. By **day**,
venture out to loot caches and repair the barricades around your shelter. By **night**, survive
the zombie horde with a finite flashlight, finite ammo, and your squad. Between nights you spend
**Scrap** (earned that run) on a card draft and fortifications; on death you bank **Salvage** to
permanently unlock weapons and cards for future runs. Playable solo or in **2–4 player online
co-op**.

## Stack

- **[Bun](https://bun.sh)** — package manager + script runner
- **[Vite](https://vite.dev)** — dev server (HMR) + production bundler
- **TypeScript** (`strict`) — game logic
- **[Biome](https://biomejs.dev)** — linter + formatter (one tool)
- **[Vitest](https://vitest.dev)** — unit tests for the pure/deterministic logic
- **[Lefthook](https://lefthook.dev)** — git hooks (pre-commit Biome, pre-push typecheck + test)
- **WebGL2** — single instanced draw call, no rendering library

## Getting started

```bash
bun install
bun run dev      # http://localhost:5173
```

If the Biome postinstall is blocked on first install, run `bun pm trust @biomejs/biome` once.

## Scripts

The ones you reach for most — see [`package.json`](./package.json) `scripts` for the full list
(coverage, formatting, sfx generation, dead-code check, …):

| Command | Description |
| --- | --- |
| `bun run dev` | Vite dev server with HMR (single-player + manual-SDP co-op) |
| `bun run dev:coop` | Game + local signaling relay together (room-code co-op) |
| `bun run signal` | Signaling relay only (`ws://127.0.0.1:8787`) |
| `bun run build` | Type-check then build to `dist/` |
| `bun run test` | Run the test suite (Vitest) |
| `bun run typecheck` | Type-check (`tsc --noEmit`) |
| `bun run lint` | Biome lint (`lint:fix` to autofix) |

## Controls

The **title and pause screens show the live bindings** — treat those (and `game/net/localInput.ts`
+ `game/main.ts`, where they're wired) as the source of truth. The essentials:

| Input | Action |
| --- | --- |
| `WASD` / Arrows | Move (the equipped weapon sets your speed — lighter is faster; there's no sprint) |
| Mouse | Aim |
| Click (hold) | Fire |
| `R` | Reload |
| `1` `2` `3` · `4` | Guns · knife |
| `F` | Toggle flashlight |
| `H` | Use a medkit |
| `E` (hold) | Repair a barricade / heal a downed ally |
| `Q` | Deploy a fortification (bought in the shop) |
| `O` | Options (aim assist, mute) |
| `M` | Mute · `Esc` / `P` Pause |

Searching a cache and reviving a downed ally happen **automatically** when you stand close — no key.
In the between-nights shop, `1` `2` `3`… take a draft card, `R` rerolls, and **Deploy** starts the day.

## Co-op multiplayer (2–4 players)

Online co-op is **host-as-peer** (one player's browser is the authoritative host) over WebRTC.
Play the deployed build at **<https://quarantine.snsgr.workers.dev/>**: everyone clicks **Co-op**,
then one player hosts and shares the room code while the others enter it and **Join**. The host
presses **Start Raid** to begin.

What to expect:

- **Use personal devices / home networks.** Some corporate, VPN, or SASE/SWG networks
  (e.g. NetSkope, Zscaler) block WebRTC even with the agent toggled off. A TURN relay rescues
  many restrictive networks, but **not all** — if a peer can't connect, try a personal network.
- **HTTPS only.** WebRTC needs a secure context; the deployed (https) build is the way to play
  online — a plain-http host won't work.
- **The host holds the session.** There's no host migration: if the host leaves or drops, the
  session ends for everyone.
- **Salvage banks on a clean game-over.** If the run ends because the host disconnected mid-game,
  that run's Salvage isn't banked.

Running your own co-op locally or self-hosting the relay: see
[`worker/README.md`](./worker/README.md).

## Project layout

The engine is data-driven: adding a weapon, enemy, upgrade, deployable, or tuning the
difficulty curve means editing a table under `game/data/` — not the engine.

```
index.html          markup, loads game/main.ts
game/
  main.ts           init + fixed-timestep game loop (imports style.css)
  game.ts           state singleton, flow, update/draw/HUD
  data/             weapons, enemies, waves, upgrades, deployables, …  ← extension points
  engine/           renderer (WebGL2), spatialHash, math, shaders/
  systems/          player, ai, bullets, wave, camera, …  (pure, take (state, dt))
  net/              co-op: host/client, transport, snapshot, signaling
```

See [CLAUDE.md](./CLAUDE.md) for architecture details.
