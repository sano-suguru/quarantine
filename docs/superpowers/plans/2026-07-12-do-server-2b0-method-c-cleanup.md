# 2b-0 Method-C Corpse Removal + `deleted_classes` Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the dead method-C infrastructure — the WebRTC signaling worker (`Room` DO), the public-room registry (`Registry` DO), the TURN endpoint, and the WebRTC/registry-era client config — including the production `deleted_classes` migration, leaving an arena-only worker.

**Architecture:** Two independent tasks. Task 1 restructures `worker/` (extract the Worker entry out of `room.ts` into a new `index.ts`, delete `Room`/`Registry`/TURN, edit `wrangler.toml`/`tsconfig.json`). Task 2 removes the dead `CONFIG.net` fields + `IceServerConfig` and renames two live-but-misnamed fields. This is pure dead-code removal — no behavior change to the live `/arena` path — so tasks are **verify-driven** (typecheck / lint / harness smoke as the gate), not TDD.

**Tech Stack:** Cloudflare Workers + Durable Objects (standard WebSocket API), Wrangler v4, TypeScript (strict), Bun, Biome, Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-12-do-server-2b0-method-c-cleanup-design.md`. This plan implements it; do not re-scope.
- **No behavior change** to the live `/arena/:CODE` WebSocket path. Everything removed is provably dead (rubber-duck-verified: referenced only by `config.ts` itself + the files being deleted).
- **Migration history is append-only.** Keep `wrangler.toml` migrations `v1`/`v2`/`v3` verbatim; only append `v4`. Never edit or remove an existing migration tag.
- **The migration fires only on a manual `deploy-worker.yml` run**, never on merge. This PR does not deploy.
- **Do NOT touch `sim/net/wire.ts` `unframe`** — it has no unknown-tag guard to remove (two-way `snap`/`else`→`rel` branch; the `else` path is load-bearing on both `wsLink.ts` and `arena.ts`).
- **Do NOT delete** `CoopEvent` (shop commands, live in `client.ts`), `hello.v?`/`hello.nonce?`, the `client.ts` reconnect hooks, or the `CONFIG.net.reconnect` block — all are live or ① scaffold; several break the build if removed.
- Quality gates: `bun run typecheck`, `bun run lint` (`biome check --error-on-warnings`), `bun run test`, and the worker check `bunx tsc --noEmit --project worker/tsconfig.json` must all pass before the final commit.

---

### Task 1: Extract arena-only `worker/index.ts`; delete `Room`/`Registry`/TURN; migration + tsconfig

**Files:**
- Create: `worker/index.ts`
- Modify: `worker/wrangler.toml`, `worker/tsconfig.json`, `worker/README.md`
- Delete: `worker/room.ts`, `worker/registry.ts`, `worker/.dev.vars` (gitignored — see Step 6)

**Interfaces:**
- Consumes: `worker/arena.ts` `export class Arena` (unchanged; imports only `../sim/*`, takes no `Env`).
- Produces: `worker/index.ts` as the wrangler `main`, exporting `default { fetch }` (routes `/arena/:CODE`) and re-exporting `class Arena`. `Env = { ARENA: DurableObjectNamespace }`.

- [ ] **Step 1: Create `worker/index.ts`** — the arena-only Worker entry, modeled on `room.ts`'s router but keeping only the arena branch.

```ts
// worker/index.ts
// Worker entry for QUARANTINE. Routes /arena/:CODE WebSocket upgrades to the authoritative
// Arena Durable Object; everything else 404s (static assets are served by the [assets] block
// in wrangler.toml, which matches before this fetch runs). The old WebRTC signaling relay
// (Room/Registry DOs + TURN) was deleted in 2b-0 — method C is gone.
export { Arena } from "./arena";

export interface Env {
  // Authoritative game-arena DO (one arena = one DO, idFromName = room code).
  ARENA: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const arenaMatch = url.pathname.match(/^\/arena\/([^/]+)$/);
    if (arenaMatch) {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      // room codes are case-insensitive: normalize so "raid" and "RAID" hit one DO
      const code = decodeURIComponent(arenaMatch[1] as string).toUpperCase();
      return env.ARENA.get(env.ARENA.idFromName(code)).fetch(req);
    }
    return new Response("not found", { status: 404 });
  },
};
```

Note: **no `locationHint`** — the route matches `room.ts:53-56` verbatim (placement is a ① concern; see the spec's "Placement timing" note).

- [ ] **Step 2: Update `worker/wrangler.toml`** — point `main` at `index.ts`, drop the `ROOM`/`REGISTRY` bindings, keep `ARENA`, keep migrations `v1`/`v2`/`v3` verbatim, append `v4`.

Change line 2 from `main = "room.ts"` to:

```toml
main = "index.ts"
```

Delete the `ROOM` binding block (lines ~12-15) and the `REGISTRY` binding block (lines ~17-21), leaving only the `ARENA` binding. Then append after the existing `[[migrations]] tag = "v3"` block:

```toml
# 2b-0: method C removed. Delete the dead signaling-relay DO classes. Both were in-memory-only
# (no stored data of consequence). History is append-only — v1/v2/v3 stay verbatim above.
[[migrations]]
tag = "v4"
deleted_classes = ["Room", "Registry"]
```

Leave the `[dev]`, `compatibility_date`, and `[assets]` blocks unchanged (the `[dev] port = 8787` comment mentions the old relay dial — fold that comment fix into Step 7's README/comment pass if quick, else leave; it's not load-bearing).

- [ ] **Step 3: Update `worker/tsconfig.json`** — change the `include` array so the worker check type-checks the new main, not the deleted file.

Change line 12 from `"include": ["room.ts", "arena.ts"]` to:

```json
  "include": ["index.ts", "arena.ts"]
```

- [ ] **Step 4: Delete `worker/room.ts` and `worker/registry.ts`**

```bash
git rm worker/room.ts worker/registry.ts
```

- [ ] **Step 5: Verify the worker type-checks**

Run:
```bash
cd worker && bun install --frozen-lockfile && cd .. && bunx tsc --noEmit --project worker/tsconfig.json
```
Expected: no output, exit 0. (If it errors with "Cannot find name 'Registry'/'Room'" or "class Arena not found", a reference to a deleted class or a missing `Arena` re-export remains — fix before continuing.)

- [ ] **Step 6: Delete the gitignored `.dev.vars`**

`worker/.dev.vars` holds only the now-unused `TURN_*` / analytics secrets and is **gitignored** (not tracked), so it won't appear in the diff — just remove it from disk so a stale copy doesn't linger:
```bash
rm -f worker/.dev.vars
```
(Operational follow-up, documented in the PR body, not a code step: revoke the corresponding `TURN_KEY_ID`/`TURN_TOKEN`/analytics secrets in the Cloudflare dashboard after the arena-only worker deploys.)

- [ ] **Step 7: Rewrite `worker/README.md` + fix the stale agent-instruction line** for the arena-only worker.

Read `worker/README.md`, then remove the WebRTC-signaling / TURN / public-room-registry sections and any `CONFIG.net.signalUrl` reference (rename it to `devArenaHost` if still mentioned). Keep/adjust: what the worker is now (the authoritative `Arena` DO served at `/arena/:CODE` over one binary WebSocket per client), the `bun run signal` / `bun run dev:coop` local-dev commands, and the manual `deploy-worker.yml` deploy note (including that the `v4` migration deletes `Room`/`Registry` on the next deploy). Match the existing doc's tone/length.

Also update `.github/copilot-instructions.md:41` (rubber-duck C1) — it currently describes the worker as *"signaling backend, TURN credential endpoint, public-room registry, and static game host"*, all now deleted. Change that clause to describe the worker as the authoritative Arena Durable Object server + static game host (mirror how CLAUDE.md's post-#52 architecture section frames it). One-line edit; it's an agent-facing instruction file, so leaving it stale would misdirect the ① implementer — the spec's codebase-honesty goal covers it.

- [ ] **Step 8: Harness smoke test** — confirm the arena still serves and the dead routes 404.

Start the worker (leave it running in one shell):
```bash
bun run signal
```
In another shell:
```bash
# arena route without the WS upgrade header → 426 (route matched, upgrade required)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/arena/TEST      # expect 426
# dead routes → 404
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/room/TEST        # expect 404
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/rooms            # expect 404
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8787/turn     # expect 404
```
Expected: `426`, `404`, `404`, `404`. Then stop the worker (Ctrl-C). (Optional deeper check: `bun run dev:coop`, open the game, Start → the arena connects and a player spawns/moves — no feel change expected.)

- [ ] **Step 9: Commit**

```bash
# room.ts/registry.ts deletions were already staged by Step 4's `git rm`.
git add worker/index.ts worker/wrangler.toml worker/tsconfig.json worker/README.md .github/copilot-instructions.md
git commit -m "refactor(worker): arena-only entry — delete method-C signaling relay + TURN

Extract the Worker router out of room.ts into index.ts (new main), keeping only
/arena/:CODE. Delete the Room + Registry DOs and the TURN endpoint (all dead
post-2a big-bang). wrangler.toml: main→index.ts, drop ROOM/REGISTRY bindings,
append v4 deleted_classes. Migration applies on the next manual deploy only.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0165mBZ5AdBijatR8TPa39cY"
```

---

### Task 2: Remove dead `CONFIG.net` fields + `IceServerConfig`; rename two live fields

**Files:**
- Modify: `sim/config.ts`, `sim/types.ts`, `game/net/signaling.ts`, `game/main.ts`, `scripts/ensure-signal-port.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `CONFIG.net.devArenaHost` (was `signalUrl`) and `CONFIG.net.arenaOpenTimeoutMs` (was `p2pOpenTimeoutMs`). The eight WebRTC/registry fields and the `IceServerConfig` type no longer exist.

- [ ] **Step 1: Edit `sim/config.ts`** — delete the dead fields, rename the two live ones, drop the now-unused import.

Remove the import of `IceServerConfig` at line 1 (`import type { IceServerConfig } from "./types";`) — it becomes unused after this step.

In the `net: { ... }` block, **delete** these fields and their comments entirely: `iceServers`, `iceGatherMaxMs`, `iceGatherGraceMs`, `roomAnswerTimeoutMs`, `registryFetchTimeoutMs`, `registryPollMs`, `registryMetaMs`, `quickMatchTimeoutMs`.

**Rename** and re-comment the two live fields:
- `signalUrl: "127.0.0.1:8787"` → `devArenaHost: "127.0.0.1:8787"`, with a comment like: `// local dev arena host:port (ws/wss scheme chosen from location.protocol at connect). Prod uses the deployed Worker origin (location.host), so this only applies to local dev.`
- `p2pOpenTimeoutMs: 15000` → `arenaOpenTimeoutMs: 15000`, with a comment like: `// if the arena WebSocket never opens, surface a connect failure (main.ts).`

Keep `interpDelayMs`, `smoothCorrect`, `snapTeleportThresh`, `maxExtrapolateMs`, `ghostLife`, the whole `reconnect` block, `maxPlayers`, `inputHz` unchanged.

- [ ] **Step 2: Edit `sim/types.ts`** — delete the orphaned `IceServerConfig` interface.

Read the interface around `sim/types.ts:600-607`, delete the `export interface IceServerConfig { ... }` block and its doc comment (which references the already-deleted `game/net/transport.ts`).

- [ ] **Step 3: Update the rename consumers**

- `game/net/signaling.ts:7`: change `const host = https ? location.host : CONFIG.net.signalUrl;` → `CONFIG.net.devArenaHost`.
- `game/main.ts:116`: change the `CONFIG.net.p2pOpenTimeoutMs` reference → `CONFIG.net.arenaOpenTimeoutMs`.
- `scripts/ensure-signal-port.ts:4` (comment): update the `CONFIG.net.signalUrl` reference in the comment → `CONFIG.net.devArenaHost` (comment-only; the script's port-preflight logic is unchanged and stays valid — it now preflights the Arena dev port, not a signaling relay).

- [ ] **Step 4: Grep-sweep for any missed reference**

Run:
```bash
grep -rn "signalUrl\|p2pOpenTimeoutMs\|iceServers\|iceGather\|roomAnswerTimeoutMs\|registryFetchTimeoutMs\|registryPollMs\|registryMetaMs\|quickMatchTimeoutMs\|IceServerConfig" game/ sim/ scripts/ worker/ | grep -v node_modules
```
Expected: **no output** (the definitions are renamed/deleted and all consumers updated). Any hit is a missed site — fix it.

- [ ] **Step 5: Full verification suite**

Run:
```bash
bun run typecheck && bun run lint && bun run test && bunx tsc --noEmit --project worker/tsconfig.json
```
Expected: all pass (typecheck exit 0; biome clean; vitest all green; worker tsc exit 0). `bun run test` covers the golden snapshot byte test — the wire format is unchanged, so it must still pass without a `PROTOCOL_VERSION` bump.

- [ ] **Step 6: Commit**

```bash
git add sim/config.ts sim/types.ts game/net/signaling.ts game/main.ts scripts/ensure-signal-port.ts
git commit -m "refactor(net): drop dead WebRTC/registry config + IceServerConfig; rename live fields

Delete the eight method-C/feature-D CONFIG.net fields (ICE, registry, quick-match
timeouts) and the orphaned IceServerConfig type. Rename the two 2a-repurposed
fields for honesty: signalUrl→devArenaHost, p2pOpenTimeoutMs→arenaOpenTimeoutMs.
Kept: CoopEvent shop commands, hello.v?/nonce?, reconnect block — live ① scaffold.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0165mBZ5AdBijatR8TPa39cY"
```

---

## Self-Review

**Spec coverage:**
- §A worker restructure + DO deletion → Task 1 Steps 1-4, 7.
- §A `worker/tsconfig.json` include (rubber-duck C1) → Task 1 Step 3.
- §A `index.ts` must re-export `Arena` (rubber-duck M2) → Task 1 Step 1 + verified Step 5.
- §A no `locationHint` (rubber-duck C2) → Task 1 Step 1 note.
- §B migration append `v4` + prerequisite binding removal → Task 1 Step 2.
- §B orphaned-secret revocation (rubber-duck H2) → Task 1 Step 6 note + PR body.
- §C dead `CONFIG.net` fields + `IceServerConfig` → Task 2 Steps 1-2.
- §C renames + comment sweep incl. `ensure-signal-port.ts` (rubber-duck M4) → Task 2 Step 3.
- §C do-not-touch `unframe` (rubber-duck H1) → Global Constraints (no task; correctly a non-action).
- "Deliberately kept" scaffold → Global Constraints (no deletions).
- Testing (typecheck/lint/test/worker-tsc/harness smoke) → Task 1 Steps 5, 8; Task 2 Step 5.

**Placeholder scan:** none — every code/edit step shows the exact content or exact line reference; deletions list exact field/file names.

**Type consistency:** `devArenaHost`/`arenaOpenTimeoutMs` are used consistently across Task 2 Steps 1 (def) and 3 (consumers) and the Step 4 grep. `Env = { ARENA }` and `export { Arena }` consistent across Task 1 Step 1 and the verify in Step 5.

**Note on task independence:** Task 1 (worker) and Task 2 (client config) are independent and could run in either order; Task 2's Step 5 worker-tsc check assumes Task 1's tsconfig edit is already in — run Task 1 first.
