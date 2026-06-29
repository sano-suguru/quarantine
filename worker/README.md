# QUARANTINE worker

The co-op backend Worker (Cloudflare Worker + Durable Objects). It brokers WebRTC
offer/answer between the host and joining clients (signaling — once the P2P DataChannel is up,
it's out of the path), mints ephemeral TURN credentials (`/turn`), holds the public-room
registry (`/rooms`), and serves the built game via Static Assets. No game state in the relay
path, no persistent storage.

## Local development (no Cloudflare account needed)

```bash
cd worker
bun install            # installs wrangler + workers-types
bunx wrangler dev      # serves ws://127.0.0.1:8787
```

The game's default `CONFIG.net.signalUrl` is `127.0.0.1:8787`, so `bun run dev` (the game)
in a few browser tabs can Host/Join by room code against this local relay.

## Deploy (via GitHub Actions — not local `wrangler deploy`)

Deployment is done by the **`.github/workflows/deploy-worker.yml`** workflow, not by
running wrangler locally. Prerequisites before it can run:

1. Push this repo to a GitHub remote.
2. Create a Cloudflare API token with the **Edit Cloudflare Workers** permission.
3. Add repository **Secrets**: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Run the workflow manually (Actions → Deploy worker → Run workflow / `workflow_dispatch`).

Until those exist the workflow is dormant (it has no push trigger, so committing this
directory does not fire a failing run).

The workflow also **builds the game and serves it from this same Worker** via Static Assets
(`[assets] directory = "../dist"`), so the deploy step runs `bun run build` before
`wrangler-action`. Because the game and the relay share one origin, the client derives the
signaling host from `location.host` over HTTPS — **no need to hardcode the deployed host**.
`CONFIG.net.signalUrl` (in `game/config.ts`) is the **dev/localhost default only** (used over
plain HTTP against `bun run signal`).

## Notes

- Free Workers plan: the `Room` DO class is SQLite-backed (`new_sqlite_classes` in
  `wrangler.toml`), which is what makes Durable Objects available without a paid plan. We
  never touch storage. Hibernation is intentionally **not** used (it would discard the live
  socket map between idle signaling messages).
- NAT: STUN-only connects most home↔home peers. Symmetric NAT / CGNAT / mobile / corporate
  networks need a **TURN relay** — see below. Corporate SASE/SWG (Netskope/Zscaler) may block
  WebRTC even with the agent off; TURNS-over-443 rescues many but not all → personal
  device/network is the reliable path.

## TURN relay (`POST /turn`)

Peers behind symmetric NAT or UDP-blocking networks can't connect P2P on STUN alone, so the
Worker mints **ephemeral** ICE servers from **Cloudflare Realtime TURN**. The client fetches
`/turn` before connecting and merges the result into its `RTCConfiguration` (see
`game/net/transport.ts` `resolveIceServers`). The TURN key secret never leaves the Worker —
clients only ever receive short-lived credentials. The response includes
`turns:turn.cloudflare.com:443` (TLS/443), which gets through most UDP-blocking firewalls.

**Worker secrets** (set in the dashboard: Workers & Pages → `quarantine` → Settings →
Variables and Secrets, type **Secret**; they persist across GHA deploys). All four are required —
the budget guard fails **closed**, so TURN stays off until they're all present:

| Secret | Value |
| --- | --- |
| `TURN_KEY_ID` | Realtime → TURN → *Create TURN key* → **Turn Token ID** |
| `TURN_TOKEN` | …same key's **API Token** (shown once) |
| `CF_ACCOUNT_ID` | your Cloudflare **Account ID** |
| `CF_ANALYTICS_TOKEN` | an API token with **Account Analytics → Read** (used by the budget cap) |

Optional: `TURN_BUDGET_GB` overrides the default monthly cap.

**Hard budget cap (why it exists):** Cloudflare has **no native spend limit** for TURN, so the
Worker enforces one. `/turn` sums this month's TURN egress via the GraphQL Analytics API
(`callsTurnUsageAdaptiveGroups`, cached ~15 min) and **refuses to mint credentials once usage
crosses the budget** — kept well under the 1000 GB/mo free tier ($0.05/GB after). It also fails
**closed** if usage can't be verified, so there is no path to a surprise charge. A same-origin
guard rejects off-origin callers (cheap anti-abuse).

**Runbook — "co-op suddenly only works for some people / TURN stopped":**
- Most likely `CF_ANALYTICS_TOKEN` expired or was revoked → the cap can't be verified → `/turn`
  fails closed (STUN-only) for everyone. Use a **non-expiring** analytics token, or rotate it.
- Cap reaction lags ~1 h (analytics delay + cache); the buffer below the free tier absorbs it.
- **Kill switch:** delete the `TURN_TOKEN` secret → `/turn` instantly returns STUN-only.

**Diagnostics:** append `?netlog` to the game URL (or set `localStorage.netlog = "1"`) to print
`[net host]`/`[net client]` ICE traces to the console — candidate **type/protocol only, never
addresses/IPs**. Keep it that way if you extend it.
