# DO Authoritative Server — Design Spec (Sub-project 2a)

- **Date:** 2026-07-11
- **Sub-project:** 2 of the **CrazyGames large-PvE-co-op rearchitecture epic**. This spec covers **2a — the thin vertical slice that relocates simulation authority from a peer browser to a Cloudflare Durable Object and proves feel at MVP 8–12 players.** The persistent-arena lifecycle machinery is split out to **2b** (see §Scope). Requirements derive from sub-project 1 (`2026-07-11-large-pve-coop-game-model-design.md`).
- **Status:** Worked through brainstorming; every platform fact verified against Cloudflare docs (not memory). Pending user review before planning.

## What this is

Sub-project 1 locked the game model: one unified **DO-authoritative arena**, no solo/multiplayer split, the in-browser `update()` authority removed. This spec picks the **implementation mechanisms** that model deferred — transport, sim extraction, server loop, reconcile retune — and deliberately scopes them to the **feel gate**, the project's #1 risk and single point of failure. Get authority + feel proven with the least scaffolding; layer persistence and scale afterward.

## Goal

Relocate the authoritative simulation from the **host browser** (method C: WebRTC P2P listen server) to a **Cloudflare Durable Object**. Every player — alone or in a crowd — is a **WebSocket client of one DO** that runs the sole authoritative `update()`. Prove, by playtest, that prediction + edge placement hold QUARANTINE's feel at **8–12 players** over the DO's extra network hop.

## Locked decisions

### 1. Migration = big-bang replace

Method C is removed wholesale, not run in parallel:

- **Delete:** `host.ts` (host-as-peer), `transport.ts` WebRTC (`PeerLink`, manual SDP), the signaling **SDP relay** + **room-code = `idFromName` = host** routing, and the `single`/`host` **local `update()` authority** in `main.ts`.
- **The DO is the sole authority.** It has **no local player** — the host-as-peer model (host = pid 0, `localPlayer`, local-zero latency) is gone. All players are clients (`pids 0..N-1`), all pay one network hop. This is exactly the §Solo-feel condition sub-project 1 flagged.
- **`main.ts`'s three frame paths collapse to one client path.** No mode owns a local sim; everyone predicts + interpolates against the DO. The browser **Web Worker ticker** (`net/ticker.ts`, which kept a *browser* host simming while backgrounded) is deleted — the DO carries the loop server-side.

**Two pre-conditions big-bang forces (both accepted):**

- **Capture the method-C client baseline before deleting C.** The `?netlog` `netStats` (RTT / jitter / loss / freeze) plus a qualitative feel note become the **comparison bar** for the TCP feel gate. Big-bang removes the same-build A/B, so we record the baseline while it still exists.
- **A local DO dev harness is mandatory.** Single-player is dark throughout development (no local authority until the DO path works end-to-end), so the DO must be runnable locally (`wrangler dev` / in-process WS) to iterate without edge deploys. Real edge placement + RTT measurement come after the path is functional.

### 2. Headless sim extraction = root-cause clean extraction

The sim is **not import-clean today** (verified): 8 systems (`ai`, `bullets`, `pickups`, `player`, `feel`, `stalker`, `stalkerFx`, `stalkerPhantom`) `import { Audio }`, and `data/enemies.ts` imports `SHAPE` from the WebGL `renderer`. Pointing a tsconfig at the sim would not compile. The fix severs the coupling at the source — a detector would be symptomatic.

**The audio/fx seam.** Today audio has **two paths**: (1) host/single — systems call `Audio.*` directly; (2) client — `net/client.ts` `effects()` re-derives audio/fx from snapshot diffs. In the DO model every player is a client and the DO has no speakers (audio is per-listener perception). So:

> Systems mutate `state` only — including the effect-trace fields that already exist (`flash`, `hitFlash`, `muzzle`, `healT`, id disappearance). **All** audio/fx is derived per-client from snapshot diffs (`effects()`) + local prediction. The host-only direct-`Audio`-in-systems path is **deleted, not ported**; every player unifies on the diff-derivation path that already exists for clients.

Benefits beyond enabling the DO: the **dual audio path collapses to one**, removing host/client audio divergence (existing debt). `feel.ts` splits — the state mutation (recoil/muzzle/shake numbers) stays pure in the sim; the audio cue attaches on the client (prediction) side.

**Structure — a first-class `sim/` module.** The pure simulation becomes a **top-level `sim/`** (not under `game/`, because it is the shared truth of both `game/` = browser client and `worker/` = DO server; nesting it under `game/` would mislabel it as client-owned):

- Contents: `state`, `systems/*`, `data/*`, `config`, `types`, the pure engine helpers (`math`, `geometry`, `spatialHash`, `players`, `steering`, `navfield`, `lights`, `fragment`), `snapshot`, and the extracted `update()` core. `SHAPE` (a plain enum) relocates into `sim/`; `renderer` imports it from there. `audio`/`renderer`/`input`/UI stay in `game/`.
- **`sim/` has its own `tsconfig.json` with `lib: ["ES2022"]` — no DOM, no `@cloudflare/workers-types`.** Both the root game build and the `worker/` build reference it (TS project references / relative import). The boundary is **compiler-enforced at the sim's own compile**, not bolted onto a consumer: any stray DOM/WebAudio/renderer import fails `sim/`'s typecheck in the pre-push hook and CI.
- **Three-peer architecture:** `sim/` (pure shared truth) · `game/` (client: render / audio / input / HUD + prediction) · `worker/` (DO: authority loop + transport). The DO and the client both depend on `sim/`; neither depends on the other. One sim = server authority and client prediction can never drift.

**Definition of done for the extraction:** `sim/` and `worker/` typecheck under the no-DOM `lib`. This surfaces every hidden DOM edge (including in "pure-looking" files) without relying on review vigilance.

### 3. Transport = single binary WebSocket per client

**Forced by the platform, verified:** Cloudflare Workers/Durable Objects do **not** support server-side **WebTransport** termination (no docs; the DO's only bidirectional real-time transport is WebSocket). So the three-way transport fork collapses — WebTransport unreliable datagrams (the closest analog to today's WebRTC `snap`) is **off the table**, and "app-layer sequencing" is a mitigation layered on WebSocket, not an alternative to it.

- **One binary WebSocket per client**, multiplexing input (client→server), snapshots (server→client), and reliable events (join / buy / deploy / …) behind a **1-byte type tag**. Today's `rel` (reliable/ordered) + `snap` (unreliable/unordered) **dual channel collapses to one ordered reliable stream** — a simplification, since TCP is uniformly reliable + ordered and the WebRTC channel-role bookkeeping disappears.
- **Reuse `snapshot.ts`** binary quantized encoding (int16 coords, byte angles, type indices). Its compactness + idempotent latest-wins semantics are exactly what make a TCP stream tolerable.
- **Client latest-wins collapse on read.** TCP never delivers a stale snapshot (ordered), but after a loss-induced stall it delivers a burst; the client jumps to the **newest** and discards the intermediates (interpolation already targets `now − interpDelay`, so this is natural).
- **HOL-blocking mitigation is app-layer:** small snapshots + moderate broadcast rate (short retransmit windows), interpolation buffer sized for TCP jitter (§4).

**Recorded risk (the binding platform constraint):** CF DO has **no unreliable-datagram escape**. If the feel gate fails on TCP head-of-line blocking and buffering can't tune it out, the response is the contingency ladder (§Contingency), up to and including a transport/provider change. The method-C baseline (pre-condition §1) is the measuring stick for how much TCP ordering actually costs.

### 4. DO tick / broadcast / reconcile

- **Stepping model = fixed-dt, one-tick-one-step.** `setInterval(~1000/simHz)`; each callback runs `update()` **exactly once** with a fixed `dt = 1/simHz`. No wall-clock accumulator server-side — this avoids Workers' coarsened/possibly-frozen clock entirely (no wall-clock `dt` read), and if `setInterval` fires late or coalesces the sim runs slightly slow in wall-time but stays internally consistent, which is invisible in an authoritative + interpolated co-op (no rollback). The **client keeps its browser accumulator** for its own local-prediction cadence (unchanged).
- **Sim rate = 60 Hz target.** Movement / fire-rate / hitstop are all tuned as 60 Hz fixed-step; changing `dt` changes feel. Validate DO CPU for 8–12 players + horde at the server spike. **30 Hz is a costed CPU fallback only** (accepting a feel re-tune).
- **Broadcast rate = decoupled from sim** (already `sendHz 30` vs `simHz 60`). MVP start **~20 Hz**, guided by Cloudflare's batching advice (50–100 ms) and the ~500–1,000 msg/s per-DO fan-out budget; interpolation covers the gap. Squeezing broadcast toward 32 players is sub-project 3's job.
- **Reconcile = architecture unchanged, constants retuned.** Keep `predX/predY`, `smoothCorrect`, `snapTeleportThresh`, `interpDelayMs`, and ghost tracers. Retune the constants for the DO's ~1.5–2× hop + TCP jitter: `interpDelayMs` 100 → ~150 start; `smoothCorrect`/`snapTeleportThresh` widened so larger, jitterier corrections stay smooth. Exact numbers are **feel-tuned at the gate**, not fixed here (per sub-project 1). Auto-controls (PR #50) reduce sensitivity here — the latency-critical twitch-aim is already gone.

### 5. Scope = thin slice to the feel gate (2a), persistence deferred (2b)

**In 2a (this spec):**
- Headless sim running in the DO; `sim/` extraction (§2).
- Single binary WebSocket transport (§3); DO tick/broadcast/reconcile (§4).
- Client prediction + interpolation against the DO; `?netlog` `netStats` retained as the feel-gate instrument.
- **Minimal connection lifecycle:** join, input, snapshot, disconnect + grace-hold/reclaim. The DO inherits `host.ts`'s `pickSlot` / nonce-rejoin / `graceMs` logic — **minus the pid-0 host player** (all slots are clients).
- **Single-arena routing:** reuse the room-code → DO `getByName` path (`idFromName`). One arena, enough to prove authority + feel.

**Deferred to 2b (own spec):** the persistent-arena lifecycle — occupied-clock freeze/thaw, the `breached → resetting → day1` soft-reset state machine, empty-arena hibernate — plus always-open per-player shop and drop-in at arbitrary sim time.

**Deferred further:** matchmaking **pool** (multi-arena selection — a scaling/SDK-boundary concern; the `net/registry.ts` fill-first selection evolves into it), density curve + interest management (sub-project 3), leaderboard submission + SDK + ads (sub-project 4).

Rationale: the feel gate is the #1 risk and a single point of failure. Reaching it with minimal scaffolding keeps a failed gate cheap, and keeps this spec focused.

## Feel-gate contingency ladder

If the feel gate fails, responses cheapest → most drastic (all platform facts verified):

1. **DO placement near players** — `locationHint` / regional arenas. Verified: DO placement is fixed at creation and single-homed (no dynamic relocation yet), and Cloudflare's canonical example is a `GameSession` DO with a region hint. **Solo/low-pop is best-served by default** (the DO spawns near the first — and only — player). A globally-mixed single arena can't satisfy everyone; the answer is **regional matchmaking**, not an architecture change. Likely sufficient on its own.
2. **Reconcile + interpolation-buffer retune** (planned anyway) — `interpDelay↑`, widen `smoothCorrect`/`snapTeleportThresh`. Auto-controls tolerate more delay.
3. **Snapshot size / rate tuning** — shorten TCP retransmit windows to blunt HOL.
4. **Low-occupancy client authority** — the sub-project-1 pre-committed contingency, made **cheap by the `sim/` extraction**: the pure sim is browser-runnable, so at ≤1–2 players the client can run `sim/` locally as authority with the DO as a persistence/leaderboard backend — a **re-wire, not a rebuild** (big-bang deleted host-as-peer *networking*, not the ability to run the sim locally). Cost: partially reintroduces a solo path (in tension with "no split") → **risk-response only**, not the default.
5. **Transport / provider change** — the floor, only if TCP HOL is fatal **and** unfixable by buffering. CF's lack of an unreliable-datagram path is the binding constraint; the escape is a WebTransport/UDP-capable server.

## Verified platform facts (Cloudflare docs, 2026-07-11)

- **DO real-time transport = WebSocket only** (Standard + Hibernation APIs). No server-side WebTransport (searches return nothing) → no unreliable datagrams.
- **A live loop is non-hibernatable:** `setInterval`/`setTimeout` (and Standard WebSocket use) block hibernation, so an occupied arena bills continuously; empty arenas stop the loop and hibernate. (Detail carried by 2b; matches `cloudflare-do-game-server-capabilities` memory.)
- **Batching guidance:** for high-frequency game-state updates, batch every 50–100 ms / 50–100 messages; each WebSocket read costs a kernel↔runtime context switch.
- **Location hints exist** (`wnam/enam/weur/eeur/apac/apac-ne/apac-se/oc/…`); best-effort, honored only on the **first** `get()`, and DOs do not relocate after creation.
- **Workers server clock** may be coarsened/frozen during synchronous execution (not confirmed in docs) → the fixed-dt stepping model (§4) is robust regardless; confirm empirically on the local harness.

## Testing

Per CLAUDE.md, only pure deterministic code is unit-tested; feel is a **playtest gate**. The extracted `sim/` is pure, so its existing co-located tests move with it. New pure surface to test: the DO connection-lifecycle helpers (the `pickSlot`-equivalent) and snapshot round-trip (already covered). Transport/DO integration is validated on the local harness + the feel-gate playtest, not unit tests.

## Non-goals (2a)

- Persistent-arena lifecycle, soft-reset state machine, hibernate/thaw (**2b**).
- Matchmaking pool, density scaling, interest management (**sub-project 3**).
- Leaderboard submission, SDK, ads (**sub-project 4**).
- Keeping method C alive as a parallel mode or a fallback (big-bang; the contingency is client authority, not method C).
- Delta-compressed / partial snapshots (full snapshots stay until sub-project 3).

## Open questions / gate items

- **Feel gate:** does prediction + edge placement clear the RTT budget at 8–12 over one TCP hop? (#1 risk.) Measured against the method-C baseline.
- **TCP HOL under real loss:** does latest-wins collapse + interp buffering keep it invisible, or does §Contingency escalate?
- **DO CPU ceiling:** 60 Hz sim for 8–12 + horde within per-DO budget, or does §4's 30 Hz fallback trigger?
- **Workers clock behavior:** confirm the fixed-dt loop paces correctly on the local harness and on the edge.
- **`sim/` extraction surface:** the full set of DOM edges the no-DOM `lib` surfaces (esp. `players`/`snapshot`/`data` transitive imports).
