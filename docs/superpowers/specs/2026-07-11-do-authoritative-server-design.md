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

**The fx/audio seam = a sim event buffer.** Two per-client concerns leak into the sim today (verified): systems call `Audio.*` **and** `fx*()` (particles / decals / damage-text / dust / sparks / muzzle — e.g. `bullets.ts` `fxKill`, `ai.ts` `fxImpact`, `player.ts` `fxDust`). Both are per-listener / per-viewer perception; the DO has neither speakers nor a screen. And **single-player gets its cues only from these direct calls** — it never runs `effects()` (that is client-side snapshot-diffing), so merely deleting the calls would leave SP silent and blank, breaking the byte-for-byte invariant the Phase-1 sequencing depends on.

The fix routes every cue through a **discrete event buffer on `state`** (this is CLAUDE.md's stated "systems return events" intent, made real):

> Systems mutate authoritative `state` **and push domain events** — `kill{x,y,dir,type}`, `hit`, `hurt`, `muzzle`, `pickup`, `nightfall`, `dawn`, … — into a per-tick buffer (`state.fxEvents`). They import **no** `Audio`/`renderer`. A client-side **`drainFxEvents(state)`** turns the buffer into audio + particles + camera shake/flash. Position/pose stays diff-interpolated as today; the buffer carries only **discrete cues**.

One mechanism serves all three consumers:
- **Single-player** drains its own buffer each frame → byte-for-byte identical cues (same frame), and the sim is clean.
- **The DO** runs the systems (the buffer fills) but never drains to hardware; it **serializes the tick's events into the snapshot** and clears the buffer.
- **Networked clients** drain the events carried in the snapshot — **exact, not guessed.** This is what robustly solves the cues snapshot-diffing could not (rubber-duck finding ②): siege-transition one-shots (`nightfall`/`dawn`, the NIGHT/DAY banner) and kill-frame **shake/flash/gore** — which live in `state.cam.shake`/`flashT` and are never snapshotted — become explicit events every client replays identically, rather than being re-derived approximately from position diffs.

`feel.ts` splits the same way: recoil/muzzle/shake **numbers** stay pure state mutation; the `Audio.shot`/`melee` cue becomes a `muzzle` event. The old dual path (host direct-call vs client `effects()` diffing) **collapses into the single buffer→drain path**, removing the existing host/client fx divergence. Note `stalkerFx`/`sysFx`/`sysCamera` are already client-only (driven from `draw()` / the client frame path, not `update()`), so they stay in `game/`; the DO's `update()` excludes them.

**Structure — a first-class `sim/` module.** The pure simulation becomes a **top-level `sim/`** (not under `game/`, because it is the shared truth of both `game/` = browser client and `worker/` = DO server; nesting it under `game/` would mislabel it as client-owned):

- Contents: `state`, `systems/*`, `data/*`, `config`, `types`, the pure engine helpers (`math`, `geometry`, `spatialHash`, `players`, `steering`, `navfield`, `lights`, `fragment`), `snapshot`, and the extracted `update()` core. `SHAPE` (a plain enum) relocates into `sim/`; `renderer` imports it from there. `audio`/`renderer`/`input`/UI stay in `game/`.
- **`sim/` has its own `tsconfig.json` with `lib: ["ES2022"]` — no DOM, no `@cloudflare/workers-types`.** Both the root game build and the `worker/` build reference it (TS project references / relative import). The boundary is **compiler-enforced at the sim's own compile**, not bolted onto a consumer: any stray DOM/WebAudio/renderer import fails `sim/`'s typecheck in the pre-push hook and CI.
- **Three-peer architecture:** `sim/` (pure shared truth) · `game/` (client: render / audio / input / HUD + prediction) · `worker/` (DO: authority loop + transport). The DO and the client both depend on `sim/`; neither depends on the other. One sim = server authority and client prediction can never drift.

**Extraction work (non-trivial — do not under-scope):**
- **Introduce the event buffer.** Add `state.fxEvents` (a typed discrete-cue list) + the `FxEvent` union in `sim/` types, and a client-side `drainFxEvents(state)` in `game/` that maps each event to the existing `Audio.*`/`fx*()`/shake/flash. Convert **every** `Audio.*` and `fx*()` call site inside the sim systems (`player`, `assist`, `ai`, `stalker`, `deployables`, `bullets`, `pickups`, `feel`; plus the `waveStart`/`dawn` transitions in `update()`) into a buffer push. `stalkerFx`/`sysFx`/`sysCamera` stay client-side and are untouched.
- **`update()` takes `state` explicitly** — `update(state, dt)`. Today `game.ts` `update()` reads a module-level `getState()` singleton. The DO holds its own `State` instance; passing it in also fixes the local dev harness (multiple arenas in one process) where a module singleton would collide. (On the edge, per-DO V8 isolates separate the singleton anyway, but the explicit signature is the clean form.)
- **Lift `audioAmbience` out of the sim core.** `update()` calls `audioAmbience(dt)` inline (an `Audio` side-effect inside the sim loop) — the sim core is audio-polluted at the source. Move that call to the client's `clientAmbience` path; the DO's `update()` must be free of it.
- **Relocate `SHAPE`** (a plain enum) into `sim/`; `renderer` imports it from there (today `data/enemies.ts` imports `SHAPE` from `renderer`).

**Definition of done for the extraction:** `sim/` and `worker/` typecheck under the no-DOM `lib`. This surfaces every hidden DOM edge (including in "pure-looking" files) without relying on review vigilance.

### 3. Transport = single binary WebSocket per client

**Forced by the platform, verified:** Cloudflare Workers/Durable Objects do **not** support server-side **WebTransport** termination (no docs; the DO's only bidirectional real-time transport is WebSocket). So the three-way transport fork collapses — WebTransport unreliable datagrams (the closest analog to today's WebRTC `snap`) is **off the table**, and "app-layer sequencing" is a mitigation layered on WebSocket, not an alternative to it.

- **One binary WebSocket per client**, multiplexing input (client→server), snapshots (server→client), and reliable events (join / buy / deploy / …) behind a **1-byte type tag**. Today's `rel` (reliable/ordered) + `snap` (unreliable/unordered) **dual channel collapses to one ordered reliable stream** — a simplification, since TCP is uniformly reliable + ordered and the WebRTC channel-role bookkeeping disappears.
- **Reuse `snapshot.ts`** binary quantized encoding (int16 coords, byte angles, type indices). Its compactness + idempotent latest-wins semantics are exactly what make a TCP stream tolerable. Extend it to also carry **the tick's `fxEvents`** (§2) — a small discrete-cue list accumulated since the last broadcast; this is the one non-idempotent part of the payload (events must not be dropped), which the ordered TCP stream delivers for free.
- **Client latest-wins collapse on read.** TCP never delivers a stale snapshot (ordered), but after a loss-induced stall it delivers a burst; the client jumps to the **newest** and discards the intermediates (interpolation already targets `now − interpDelay`, so this is natural).
- **Client input is rate-limited + latest-wins on the send side.** Today `main.ts` ships input every rAF frame (~60/s). The host only does `p.input = msg.input` (overwrite), so intermediate frames are droppable — input is latest-wins too. Cap client send to ~20–30 Hz, batching to the newest input. Without this, **inbound** input dominates the DO message budget (see §4), and each WebSocket read costs a kernel↔runtime context switch.
- **HOL-blocking mitigation is app-layer:** small snapshots + moderate broadcast rate (short retransmit windows), interpolation buffer sized for TCP jitter (§4).

**Recorded risk (the binding platform constraint):** CF DO has **no unreliable-datagram escape**. If the feel gate fails on TCP head-of-line blocking and buffering can't tune it out, the response is the contingency ladder (§Contingency), up to and including a transport/provider change. The method-C baseline (pre-condition §1) is the measuring stick for how much TCP ordering actually costs.

### 4. DO tick / broadcast / reconcile

- **Stepping model = fixed-dt, one-tick-one-step.** `setInterval(~1000/simHz)`; each callback runs `update()` **exactly once** with a fixed `dt = 1/simHz`. No wall-clock accumulator server-side — this avoids Workers' coarsened/possibly-frozen clock entirely (no wall-clock `dt` read) and sidesteps the accumulator's spiral-of-death under load. The trade-off is **not** "invisible": if the DO can't sustain the rate (CPU-bound), the sim runs slower than wall-time, which **increases everyone's input→reflect latency — worst exactly at night/horde, when feel matters most.** The client's `?netlog` freeze% (render outrunning the newest snapshot) captures it; 2a also adds a **server-side effective-tick-rate counter** as the trigger for the 30 Hz fallback. The **client keeps its browser accumulator** for its own local-prediction cadence (unchanged).
- **Sim rate = 60 Hz target.** Movement / fire-rate / hitstop are all tuned as 60 Hz fixed-step; changing `dt` changes feel. Validate DO CPU for 8–12 players + horde at the server spike. **30 Hz is a costed CPU fallback only** (accepting a feel re-tune).
- **Broadcast rate = decoupled from sim** (already `sendHz 30` vs `simHz 60`). MVP start **~20 Hz**, guided by Cloudflare's batching advice (50–100 ms). Budget both directions against the ~500–1,000 msg/s per-DO ceiling: outbound ≈ clients × broadcastHz (12 × 20 = 240/s) **plus inbound ≈ clients × inputHz**, which dominates unless input is rate-limited (§3) — at the raw 60 Hz send it is 12 × 60 = 720/s, alone near the ceiling. Interpolation covers the broadcast gap. Squeezing both toward 32 players is sub-project 3's job.
- **Reconcile = architecture unchanged, constants retuned.** Keep `predX/predY`, `smoothCorrect`, `snapTeleportThresh`, `interpDelayMs`, and ghost tracers. Retune the constants for the DO's ~1.5–2× hop + TCP jitter: `interpDelayMs` 100 → ~150 start; `smoothCorrect`/`snapTeleportThresh` widened so larger, jitterier corrections stay smooth. Exact numbers are **feel-tuned at the gate**, not fixed here (per sub-project 1). Auto-controls (PR #50) reduce sensitivity here — the latency-critical twitch-aim is already gone.

### 5. Scope = thin slice to the feel gate (2a), persistence deferred (2b)

**In 2a (this spec):**
- Headless sim running in the DO; `sim/` extraction (§2).
- Single binary WebSocket transport (§3); DO tick/broadcast/reconcile (§4).
- Client prediction + interpolation against the DO; `?netlog` `netStats` retained as the feel-gate instrument.
- **Minimal connection lifecycle:** join, input, snapshot, disconnect + grace-hold/reclaim. The DO inherits `host.ts`'s `pickSlot` / nonce-rejoin / `graceMs` logic — **minus the pid-0 host player** (all slots are clients).
- **Single-arena routing:** reuse the room-code → DO `getByName` path (`idFromName`). One arena, enough to prove authority + feel.
- **Feel-gate scenario = a held siege phase.** A full sim would run `sysSiege` to dawn, which calls `openShop()` → `state.paused = true` → the whole `update()` early-returns (`game.ts` `if (!running || paused) return`). That synchronized all-stop shop is incoherent for a shared DO arena and its per-player replacement is 2b. So for the gate, **hold a single phase** (a sustained night — the horde is the feel to prove — with the dawn→shop transition disabled), rather than cycling through dawn. The gate proves movement/combat feel at 8–12 under the DO hop; the day/night cycle + shop return with 2b.
- **Invariant (promoted from 2b): the DO sim never globally pauses.** `state.paused`/`inShop` stopping the entire arena is fundamentally incompatible with a shared drop-in DO (you cannot freeze one arena for one player). Removing the global-pause shop is therefore a **DO-model property, established in 2a** (as the held-phase gate above relies on it); the full per-player, non-pausing shop is 2b.

**Deferred to 2b (own spec):** the persistent-arena lifecycle — occupied-clock freeze/thaw, the `breached → resetting → day1` soft-reset state machine, empty-arena hibernate — plus always-open per-player shop and drop-in at arbitrary sim time.

**Deferred further:** matchmaking **pool** (multi-arena selection — a scaling/SDK-boundary concern; the `net/registry.ts` fill-first selection evolves into it), density curve + interest management (sub-project 3), leaderboard submission + SDK + ads (sub-project 4).

Rationale: the feel gate is the #1 risk and a single point of failure. Reaching it with minimal scaffolding keeps a failed gate cheap, and keeps this spec focused.

### Sequencing within 2a

Big-bang means method C is not kept as a *parallel authority* — it does **not** mean the sim extraction and the authority relocation land in one step. Do them in order, because the intermediate state is a safe bisection point:

1. **Extract `sim/` while single-player keeps working.** Single-player calls `sim/`'s `update(state, dt)` locally, then `drainFxEvents(state)` each frame so its cues are byte-for-byte identical; method C is still present and functional. Land it with CI green and the `single` path **feel-unchanged** (the CLAUDE.md invariant). No transport or DO involved yet — this step is a pure refactor + the event-buffer seam.
2. **Big-bang the authority.** Delete method-C networking + the local `update()` authority, wire the DO + WebSocket, move all players to clients.

If the feel gate then comes back "off," this split separates the two candidate causes — **extraction regression** (caught earlier, at step 1, with SP still runnable) vs **the DO hop itself** (step 2). Collapsing both into one step would make them co-manifest and hard to bisect.

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

Per CLAUDE.md, only pure deterministic code is unit-tested; feel is a **playtest gate**. The extracted `sim/` is pure, so its existing co-located tests move with it. New pure surface to test: the DO connection-lifecycle helpers (the `pickSlot`-equivalent), and the snapshot round-trip **extended to cover `fxEvents` encode/decode** (the existing round-trip test grows to assert events survive the wire). Transport/DO integration is validated on the local harness + the feel-gate playtest, not unit tests. `drainFxEvents` itself is a client-side effect sink (imports `Audio`/`fx`) so it is not unit-tested — its correctness is the feel gate.

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
