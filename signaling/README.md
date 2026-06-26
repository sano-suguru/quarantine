# QUARANTINE signaling

Room-code signaling relay for co-op (Cloudflare Worker + Durable Object). It only brokers
the WebRTC offer/answer between the host and joining clients — once the P2P DataChannel is
up, this server is no longer in the path. No game state, no persistent storage.

## Local development (no Cloudflare account needed)

```bash
cd signaling
bun install            # installs wrangler + workers-types
bunx wrangler dev      # serves ws://127.0.0.1:8787
```

The game's default `CONFIG.net.signalUrl` is `127.0.0.1:8787`, so `bun run dev` (the game)
in a few browser tabs can Host/Join by room code against this local relay.

## Deploy (via GitHub Actions — not local `wrangler deploy`)

Deployment is done by the **`.github/workflows/deploy-signaling.yml`** workflow, not by
running wrangler locally. Prerequisites before it can run:

1. Push this repo to a GitHub remote.
2. Create a Cloudflare API token with the **Edit Cloudflare Workers** permission.
3. Add repository **Secrets**: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Run the workflow manually (Actions → Deploy signaling → Run workflow / `workflow_dispatch`).

Until those exist the workflow is dormant (it has no push trigger, so committing this
directory does not fire a failing run).

After deploying, set `CONFIG.net.signalUrl` (in `src/config.ts`) to the deployed Worker
host (e.g. `quarantine-signaling.<account>.workers.dev`); the game picks `wss://`
automatically when served over HTTPS.

## Notes

- Free Workers plan: the `Room` DO class is SQLite-backed (`new_sqlite_classes` in
  `wrangler.toml`), which is what makes Durable Objects available without a paid plan. We
  never touch storage. Hibernation is intentionally **not** used (it would discard the live
  socket map between idle signaling messages).
- NAT: STUN-only connects most home↔home peers. Symmetric NAT / CGNAT / mobile may need a
  TURN server — add it to `CONFIG.net.iceServers` (no code change). Corporate SASE/SWG
  (Netskope/Zscaler) typically blocks WebRTC entirely; use a personal device/network.
