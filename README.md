# QUARANTINE

A top-down **day/night siege survival-horror**, built on a custom WebGL2 engine. By **day**,
explore POIs and loot caches to scavenge gear, and repair the barricades around your shelter.
By **night**, survive the zombie horde with a finite flashlight, finite ammo, and your squad.
On death you bank **SALVAGE** to permanently unlock weapons across runs. Playable solo or in
**2–4 player online co-op**.

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

| Command | Description |
| --- | --- |
| `bun run dev` | Vite dev server with HMR (single-player + manual-SDP co-op) |
| `bun run dev:coop` | Game + local signaling relay together (room-code co-op) |
| `bun run signal` | Signaling relay only (`ws://127.0.0.1:8787`) |
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
| `WASD` / Arrows | Move |
| Mouse | Aim |
| Click (hold) | Fire |
| `R` | Reload |
| `1` `2` `3` | Switch weapon |
| `Shift` | Sprint |
| `E` (hold) | Interact — repair a barricade / search a cache |
| `H` | Use a medkit |
| `F` | Toggle flashlight |
| `M` | Mute |
| `P` / `Esc` | Pause |
| `Enter` | Deploy / start the night early |

## Co-op multiplayer (2–4 players)

Online co-op is **host-as-peer** (one player's browser is the authoritative host) over WebRTC.
Play the deployed build at **<https://quarantine.snsgr.workers.dev/>**: one player
clicks **Host co-op** and shares the room code; the others click **Join co-op** and enter it.
The host presses **Deploy** to start.

What to expect:

- **Use personal devices / home networks.** Some corporate, VPN, or SASE/SWG networks
  (e.g. NetSkope, Zscaler) block WebRTC even with the agent toggled off. A TURN relay rescues
  many restrictive networks, but **not all** — if a peer can't connect, try a personal network.
- **HTTPS only.** WebRTC needs a secure context; the deployed (https) build is the way to play
  online — a plain-http host won't work.
- **The host holds the session.** There's no host migration: if the host leaves or drops, the
  session ends for everyone.
- **SALVAGE banks on a clean game-over.** If the run ends because the host disconnected mid-game,
  that run's SALVAGE isn't banked.

Running your own co-op locally or self-hosting the relay: see
[`worker/README.md`](./worker/README.md).

## Project layout

The engine is data-driven: adding a weapon, enemy, upgrade, or tuning the
difficulty curve means editing a table under `game/data/` — not the engine.

```
index.html          markup + CSS, loads game/main.ts
game/
  main.ts           init + fixed-timestep game loop
  game.ts           state singleton, flow, update/draw/HUD
  data/             weapons, enemies, waves, upgrades  ← extension points
  engine/           renderer (WebGL2), spatialHash, math, shaders/
  systems/          player, ai, bullets, wave, camera  (pure, take (state, dt))
```

See [CLAUDE.md](./CLAUDE.md) for architecture details.
