# QUARANTINE worker

The authoritative co-op backend: a Cloudflare Worker that routes `/arena/:CODE` WebSocket
upgrades to the `Arena` Durable Object, which runs the sole authoritative simulation
(`stepSim`) and broadcasts binary snapshots to all connected clients over one WebSocket each.
It also serves the built game via Static Assets (same origin — no cross-origin issues).

The old WebRTC signaling relay (Room/Registry DOs, `/room/:CODE`, `/rooms`, `/turn`) was
removed in 2b-0. Method C is gone; the Arena DO is the only path.

## Local development (no Cloudflare account needed)

```bash
# From the repo root — starts the game (Vite) + the worker (wrangler dev) together:
bun run dev:coop

# Worker only:
bun run worker
```

`bun run worker` (and `dev:coop`) preflights port 8787 (`scripts/ensure-worker-port.ts`) and
passes `--port 8787` so a stale process squatting the port fails loudly with the offending PID
instead of silently binding a fallback. If you hit that error, `kill <pid>` (add `-9` if it
survives) and retry.

The Arena DO is available at `ws://127.0.0.1:8787/arena/CODE`. The game's `arenaUrl()` helper
in `game/net/signaling.ts` derives the URL from `CONFIG.net.devArenaHost` (localhost default)
or `location.host` (production).

## Deploy (via GitHub Actions — not local `wrangler deploy`)

Deployment is done by **`.github/workflows/deploy-worker.yml`** (`workflow_dispatch`). Before
it can run:

1. Push this repo to a GitHub remote.
2. Create a Cloudflare API token with the **Edit Cloudflare Workers** permission.
3. Add repository **Secrets**: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Run the workflow manually (Actions → Deploy worker → Run workflow).

The workflow runs `bun run build` first, then `wrangler-action`. The `[assets]` block
(`directory = "../dist"`) means the game and the Arena DO share one origin — no hardcoded
production host needed.

**Migration note:** the next deploy applies the `v4` migration (see `wrangler.toml`), which
runs `deleted_classes = ["Room", "Registry"]` against production DO state. Both classes were
in-memory-only; no persistent data is lost.

**Operational follow-up after the first deploy:** revoke the now-unused `TURN_KEY_ID`,
`TURN_TOKEN`, and `CF_ANALYTICS_TOKEN` secrets in the Cloudflare dashboard (Workers &
Pages → `quarantine` → Settings → Variables and Secrets).

## Notes

- **Standard WebSocket API, not Hibernation.** The Arena DO stays resident while its loop runs
  (`setInterval`). Hibernation would evict mid-loop.
- `server.binaryType = "arraybuffer"` is set before `accept()` in `arena.ts`. Required with
  `compatibility_date ≥ 2026-03-17` — without it CF delivers binary frames as Blob and silently
  breaks every input/snapshot frame.
- Free Workers plan: `Arena` is SQLite-backed (`new_sqlite_classes` in `wrangler.toml`), which
  is what makes DOs available without a paid plan. We never touch storage.
