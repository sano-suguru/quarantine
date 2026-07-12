# DO Server — 2b-0: Method-C Corpse Removal + `deleted_classes` Migration — Design Spec

- **Date:** 2026-07-12
- **Sub-project:** 2b of the **CrazyGames large-PvE-co-op rearchitecture epic**, **phase 0 (housekeeping)**. 2b (persistent-arena lifecycle) was decomposed into **① gameplay-loop restoration → ② persistence/lifecycle**, with this **2b-0** clearing the dead method-C infrastructure first so ① builds on a clean worker. 2a (PR #51 `c32c61d`, PR #52 `181ea06`) relocated authority to the `Arena` DO and deleted method C's *client* code, but left the WebRTC **signaling worker** (`Room`/`Registry` DOs, TURN) intact-but-dead because deleting DO classes needs a production `deleted_classes` migration.
- **Status:** Brainstormed + grounded in the real worker/client code and verified Cloudflare migration docs, then **rubber-ducked** (findings folded in: `worker/tsconfig.json` include, `index.ts` must re-export `Arena`, dropped the invented `locationHint` carry-over, corrected the nonexistent `unframe` guard, added orphaned-secret revocation, widened the rename sweep). Pending user review before planning.

## Goal

Delete the dead method-C infrastructure — the WebRTC signaling relay (`Room` DO), the public-room registry (`Registry` DO), the TURN credential endpoint, and the WebRTC/registry-era client config — including the production `deleted_classes` migration that safely removes the two DO classes. After this PR the worker exposes exactly one route (`/arena/:CODE`) plus static assets, and no dead WebRTC scaffolding remains except what ① genuinely reuses.

This is pure dead-code removal + a migration. No behavior change to the live arena path.

## Why now

- **Honesty of the codebase.** Nothing dials `/room`, `/rooms`, or `/turn` — the client is entirely on the `/arena` WebSocket path (2a big-bang). The relay is a corpse that reads as live infrastructure.
- **De-risk the migration in isolation.** Cloudflare's guidance (verified): *"To limit the blast radius of Durable Object migration deployments, migrations should be deployed independently of other code changes."* A focused PR whose only production-affecting change is the class deletion honors that.
- **Clear the deck for ①.** ① restructures the arena connection lifecycle (drop-in, reconnect, per-player shop). Doing it over a worker still carrying `Room`/`Registry`/TURN means reasoning around dead branches.

## Deployment reality (verified, shapes the migration)

`workers_list` (Cloudflare account, 2026-07-12): the `quarantine` worker exists, **last modified 2026-07-01**. The `Arena` class (migration `v3`) merged **2026-07-12** (PR #52) and the deploy is **manual (`workflow_dispatch`)** and has **not** run since. Therefore **production currently has migrations `v1` (`Room`) + `v2` (`Registry`) applied, and has never seen `Arena` (`v3`)** — production is still serving the *old method-C relay*.

Consequences:
- The next manual `deploy-worker.yml` run will apply the un-applied `v3` (create `Arena`) **and** the new `v4` (delete `Room`/`Registry`) atomically, in tag order. This is fine — wrangler applies all un-applied tags in sequence in one deploy.
- Because the migration only takes effect on a **manual** deploy, merging this PR fires **no** migration. The class deletion happens when someone explicitly triggers the deploy — a deliberate, low-surprise step documented in the PR body.
- Moving production from the method-C relay to the arena-only worker is the intended end state.

## Scope — three parts

### A. Worker restructure + DO deletion

`worker/room.ts` is currently the Worker `main` *and* holds the `fetch` router, the `Room` DO, **and** the TURN logic — three concerns in one file. The cleanup untangles them:

- **Extract the Worker entry into a new `worker/index.ts` (the new `main`)** that keeps only:
  - the `/arena/:CODE` → `env.ARENA.get(env.ARENA.idFromName(code)).fetch(req)` route — **verbatim as today** (`room.ts:55`). It carries **no `locationHint`** today, and this PR adds none: 2b-0 is pure dead-code removal with no behavior change (see §"Placement timing" below — this is flagged for ①, not done here).
  - the WebSocket-upgrade guard and the 404 fallthrough (static assets are served by the `[assets]` block; **no** `not_found_handling`/SPA mode, per the existing wrangler comment).
  - **`index.ts` MUST `export { Arena } from "./arena"`** (drop the `Registry` re-export). wrangler resolves the DO `class_name = "Arena"` against the exports of the `main` module; if `index.ts` is `main` but doesn't re-export `Arena`, the deploy fails with a "class Arena not found" error. This is a hard acceptance criterion. (`arena.ts` imports nothing from `room.ts`/`registry.ts` and takes no `Env`, so it is otherwise unaffected.)
- **Update `worker/tsconfig.json`** — its `include` is currently `["room.ts", "arena.ts"]` (`worker/tsconfig.json:12`); change to `["index.ts", "arena.ts"]`, else the `worker` CI check type-checks a deleted file and skips the new main (breaks the required status check).
- **Delete:**
  - `Room` DO (the SDP relay + its `/room/:CODE` route + registry register/deregister calls),
  - `worker/registry.ts` (`Registry` DO) + the `/rooms` route,
  - the TURN endpoint (`/turn`, `turnIceServers`, the budget-cap Cache-API logic, the `Account Analytics` GraphQL call) + `worker/.dev.vars` (holds only the now-unused `TURN_*` secrets),
  - the `Env` fields `ROOM`, `REGISTRY`, `TURN_KEY_ID`, `TURN_TOKEN` (+ the budget var) — leaving `Env = { ARENA }`.
- **`worker/wrangler.toml`:**
  - `main = "index.ts"`,
  - remove the `ROOM` and `REGISTRY` `durable_objects.bindings` (keep `ARENA`),
  - **keep** the historical `[[migrations]]` `v1`/`v2`/`v3` verbatim (migration history is append-only; removing applied tags breaks the chain),
  - **append** `[[migrations]] tag = "v4"  deleted_classes = ["Room", "Registry"]`.
- Update `worker/README.md` to describe the arena-only worker (drop the signaling/TURN sections).

### B. The migration (the only production-affecting change — verified)

Per Cloudflare's Durable Objects migration docs (verified 2026-07-12):
- A Delete migration removes all DO instances of the class **and their stored data**. Both `Room` and `Registry` are documented **in-memory-only** ("we don't use storage") — no data loss of consequence.
- Prerequisites the docs require, all satisfied by part A: remove the binding, remove the class references from code, add the `deleted_classes` entry, deploy.
- Rollback note (verified): once a migration is deployed it cannot be rolled back to a version prior to it. Acceptable — we are deleting disposable relay DOs, and production isn't yet serving arena traffic.
- **Prerequisite ordering (CF docs):** the `ROOM`/`REGISTRY` `durable_objects.bindings` must be removed *before/with* the `v4` deploy — §A removes them in the same wrangler.toml edit, so this is satisfied; noting it because the docs require "remove the binding" as step 1 of a Delete migration.
- The PR body will spell out the deploy step (trigger `deploy-worker.yml`; the `CLOUDFLARE_*` secrets must exist) and that the migration fires only then.

### Placement timing (flag for ①, not done here)

DO `locationHint` is honored only on the **first** `get()` for a given name, and placement is fixed thereafter (2a §Contingency; verified). The 2b-0 deploy is the first time `Arena` is created in production. 2b-0 deliberately adds no `locationHint` (no-behavior-change housekeeping), so any arena code first accessed in production between 2b-0 and ① gets **default (near-first-requester) placement, permanently**. This is fine during development (we control which codes are touched, no real players yet). **① must set `locationHint: "apac-ne"` on `idFromName().get()` before real players connect** — recorded here so the placement decision isn't silently lost with the route extraction.

### C. Client-side dead config + naming honesty

Narrower than the roadmap's shorthand ("inert client.ts hooks / NetMsg residue") — grounding shows most of that is **live ① scaffold, not dead** (see §"What is deliberately kept").

- **Delete the genuinely-dead `CONFIG.net` fields** (each referenced only by `config.ts` itself and the `room.ts` being deleted): `iceServers`, `iceGatherMaxMs`, `iceGatherGraceMs`, `roomAnswerTimeoutMs`, `registryFetchTimeoutMs`, `registryPollMs`, `registryMetaMs`, `quickMatchTimeoutMs`; and the now-orphaned **`IceServerConfig`** interface in `sim/types.ts`.
- **Rename two live-but-misnamed fields for honesty** (they were repurposed at the 2a cutover and still carry WebRTC-era names/comments):
  - `signalUrl` → `devArenaHost` (it is the local dev arena `host:port` used by `signaling.ts arenaUrl`, not a signaling URL),
  - `p2pOpenTimeoutMs` → `arenaOpenTimeoutMs` (it is the arena-connect timeout at `main.ts:116`, not a P2P open timeout).
  - **Rename sweep** must also update the comment references, not just the definitions: `scripts/ensure-signal-port.ts` (comment cites `CONFIG.net.signalUrl`) and any `signalUrl` mention inside `worker/README.md`. Grep the renamed symbols repo-wide at plan time.
- **Do NOT touch `unframe`** — the roadmap/CLAUDE.md phrase "unframe unknown-tag guard" is **inaccurate**: `sim/net/wire.ts:26–34` `unframe` is a two-way branch (`snap` tag → snap, `else` → rel) with **no** unknown-tag guard, and the `else`→rel path is load-bearing on both callers (`wsLink.ts:28`, `arena.ts:148`). There is nothing to remove. (The stale CLAUDE.md line is corrected in the ① CLAUDE.md pass.)

## What is deliberately kept (correcting the roadmap's over-scope)

Grounding the roadmap's "inert client.ts hooks / NetMsg residue" against the code shows these are **not** dead — they are ①'s scaffold or live gates, so deleting them now is churn (delete → re-add in ①):

- **`CoopEvent` (`buy`/`place`/`deploy`/`draftTake`/`draftReroll`)** — actively sent by `client.ts:402–414` (the shop/draft methods). This is exactly the per-player-shop command set ① revives; the DO simply doesn't handle it yet (`arena.ts:168` defers it to 2b). Keep.
- **`hello.v?`** — the **live** protocol-version gate (`client.ts:116`); the 2a Phase-2 spec explicitly requires preserving the Hello version check so a persistent DO refuses a stale-build client. Keep (its comment about "manual-SDP" can be corrected, but the field stays).
- **`hello.nonce?` + `client.ts` reconnect hooks (`suspend`/`rebind`/`onIdentity`, `hooks.rejoin`) + the `CONFIG.net.reconnect` block** — inert *today* but the exact machinery ① wires for **arena reconnect** (2a left mid-drop → title; the DO already holds the body for `graceMs`). `graceMs` is additionally read server-side by `arena.ts`. Keep.
- **`join`/`rejoin`, `roomfull`, `gameover`** on the wire — all live (`arena.ts`) or ①/② scaffold. Keep.

## Non-goals (2b-0)

- `cam.shake`/`flashT` → per-viewer fx events (2a carry-forward ②) — folds into **①** (rides the fx seam that shop/respawn cues touch).
- *Building* arena reconnect — **①** (the hooks stay as scaffold here).
- Any gameplay-loop, day/night, shop, death/respawn, persistence, hibernate — **①/②**.
- Collapsing/rewriting the historical migration tags — not allowed (append-only).
- Matchmaking pool / room browser as a *new* design — **sub-project 3** (the deleted `Registry` is not its precursor; the arena-pool design is separate).

## Testing

Per CLAUDE.md, only pure deterministic code is unit-tested; the worker path is validated on the harness.

- **Unit:** no new pure surface. `sim/net/wire.ts` framing tests stay **unchanged** (`unframe` is untouched — see §C).
- **Typecheck:** `bun run typecheck` (game+sim) and the `worker` CI check (`worker/tsconfig.json`) must stay green with `Env = { ARENA }` and the new `index.ts` main.
- **Harness smoke (`bun run dev:coop`):** the arena is still reachable at `ws://127.0.0.1:8787/arena/CODE` and a client spawns/moves; `/room/CODE`, `/rooms`, `/turn` now return 404. No feel change to assert (dead-code removal).
- **Lint:** `bun run lint` (biome covers `worker/`).

## Rollout

1. Merge the PR (CI: `check` + `worker` green). **No migration fires on merge.**
2. When ready to move production to the arena-only worker, trigger `deploy-worker.yml`. This applies `v3` + `v4` atomically and deletes the `Room`/`Registry` DO instances. Deploy the migration independently of unrelated code changes (CF guidance) — this PR is already migration-focused, so a deploy off `main` right after merge satisfies that.
3. **Revoke orphaned secrets.** Deleting `/turn` orphans the live TURN/analytics Worker secrets (`TURN_KEY_ID`, `TURN_TOKEN`, and the analytics token) — no `Env` field references them anymore. After the arena-only worker deploys, delete these secrets in the Cloudflare dashboard (and from any local `.dev.vars` mirror / password manager) so they don't linger as an unused credential surface. Operational, not a code change.

## Open questions / risks

- **Residual dials:** confirm no client path still references `signalUrl`-as-signaling, `/room`, `/rooms`, `/turn`, or the deleted config fields beyond the rename sites (grep sweep at plan time; `main.ts` is arena-only post-2a — rubber-duck confirmed the deleted config fields are referenced only by `config.ts` itself + the deleted `room.ts`).
- **`bun run signal` naming:** the `signal` script + `scripts/ensure-signal-port.ts` are named around a "signaling relay" that no longer exists, but remain *functionally* valid (they preflight port 8787 for `wrangler dev`, which now serves the Arena). Retain them as-is (renaming to `dev:worker` is ① churn); just fix the stale comment in the rename sweep.
- **Deploy secrets:** `deploy-worker.yml` needs `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`; the migration can only be applied once those exist. This is an operational note, not a code blocker.
- **`.dev.vars` removal:** confirm nothing else in local dev reads `worker/.dev.vars` (only TURN used it).
