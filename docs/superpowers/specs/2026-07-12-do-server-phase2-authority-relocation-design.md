# DO Server — Phase 2: Authority Relocation (browser → DO) — Design Spec

- **Date:** 2026-07-12
- **Sub-project:** 2a of the **CrazyGames large-PvE-co-op rearchitecture epic**, **Phase 2**. Phase 1 (`docs/superpowers/plans/2026-07-11-do-server-phase1-sim-extraction.md`, merged as `c32c61d`) extracted a headless `sim/` module + the `state.fxEvents` seam. This spec picks the **implementation mechanisms** for relocating authority from the host browser to a Cloudflare Durable Object, resolving the four roots the umbrella 2a spec (`2026-07-11-do-authoritative-server-design.md`) left open.
- **Status:** Brainstormed; refines the umbrella 2a spec on root (c) (see §Refinement). Pending user review before planning.

## What this is

The umbrella 2a spec locked the **scope** (big-bang replace method C; single binary WebSocket; DO fixed-dt loop; reconcile retuned; held-siege feel gate) and verified every platform fact. It deliberately left four **implementation roots** for a Phase-2 brainstorm, once Phase 1's shape was known:

- **(a)** DO connection lifecycle — porting `host.ts`'s `pickSlot`/nonce-rejoin/`graceMs` to a **host-player-less** authority DO.
- **(b)** How the DO runs `sim/` — excluding the cosmetic/per-client `sysFx`/`sysCamera` from the authoritative step.
- **(c)** fxEvents distribution + the client's fx source (drain vs. the existing `effects()` snapshot-diffing).
- **(d)** Collapsing `main.ts`'s three frame paths into one client path + a local DO dev harness.

This spec resolves all four. It does **not** re-litigate the umbrella scope (transport = WebSocket, big-bang, 60 Hz/30 Hz, ~20 Hz broadcast, held-night gate, `interpDelay` retune — all locked there).

## Goal

Every player — alone or in a crowd — is a **WebSocket client of one always-live DO** that runs the sole authoritative `update()`. Prove, by playtest over the real DO hop, that prediction + edge placement hold QUARANTINE's feel. The DO is a **Braains.io-style persistent arena**: you connect and drop straight into the running world; there is no lobby-gather, no host, no global pause.

## Resolved decisions

### (a) DO connection lifecycle — `host.ts` minus the host player

The DO is the pure authority; it has **no local player**. Port the proven roster machinery from `host.ts`, dropping only the pid-0-is-host reservation:

- **`pickSlot`** ports verbatim as the single source of truth for the cap, but the range becomes **`pids 0..MAX_PLAYERS-1`** (no reserved pid-0). `MAX_PLAYERS = 12` for the gate (umbrella MVP 8–12).
- **Identity from the first reliable message** (unchanged shape): `join` → `pickSlot` assigns the lowest free slot and a reconnect `nonce`, then **spawns the player straight into the live arena** (drop-in — there is no "not yet started" state; the arena is always running). `rejoin` (pid+nonce) → re-attach the still-held body (no respawn, gear/hp/pos kept).
- **Drop + grace-hold** ports directly: a closed socket marks the body `absent` and stamps `goneAt`; a tick-driven `tickGrace(now)` retires bodies past `CONFIG.net.reconnect.graceMs`. A `rejoin` within grace re-attaches. Same `reconnect` config block as today.
- **`spawnFresh`** ports minus the host bias: spawn at HOME with a per-pid offset; in the held night, a fresh joiner arrives **downed → 15–20 s spectate → dawn-respawn** is 2b, so for the 2a held-night gate a fresh joiner spawns **alive at HOME** (the shop/day path that gated the old downed-spawn is disabled in the gate). This keeps the gate about combat feel, not the death loop.
- **DO WebSocket API = the standard API, not Hibernation.** The `setInterval` sim loop is non-hibernatable regardless (verified, `cloudflare-do-game-server-capabilities`), so Hibernation buys nothing while occupied, and the standard API's in-memory socket map is exactly the existing `worker/room.ts` pattern (which also deliberately avoids Hibernation). The DO holds `WebSocket[]` in memory keyed by pid, mirroring `Host.links`.
- **Empty-arena → stop the loop.** When the last socket closes, `clearInterval` and let the DO idle (billing stops). The next `join` restarts the loop from the persisted/rebuilt state. Full occupied-clock freeze/thaw + SQLite persistence is **2b**; for 2a the in-memory state is fine (a fully-empty gate arena can reset).
- **Routing:** reuse the room-code → DO `getByName`/`idFromName` path. One arena. `locationHint` on first `get()` for edge placement (umbrella §Contingency step 1); Japan → `apac-ne`.

The connection helpers stay **pure and unit-testable** (`pickSlot` already is; the rejoin-match predicate is extractable the same way), per the umbrella testing note.

### (b) The DO's authoritative step — `update()` sheds its cosmetic tail

Post-big-bang, **no browser calls `update()` — only the DO does.** The browser client is pure predict+interpolate and already runs `sysFx`/`sysCamera` itself in its frame path (`main.ts:468–470`). So excluding the cosmetic systems from authority is a **clean removal, not a new fork**:

- Delete the inline `sysFx(state, sdt)` and `sysCamera(state, sdt)` calls from `update()` (`game.ts`). `update()` becomes the pure authoritative core: `sysPlayer → sysAssist → sysAI → (gameOver) → sysStalker → sysDeployables → sysBullets → sysPickups → sysSiege → transitions`.
- `state.cam` and `state.particles` stay **off the authoritative wire** (already not in `snapshot.ts`). The DO never allocates meaningful particle churn; the client owns its camera and particles.
- **`gameOver()` / the dawn→`openShop()` path:** the held-night gate never reaches dawn (`sysSiege` holds the night phase; see below), so `openShop()` is not called and **`state.paused` is never set — the promoted invariant "the DO sim never globally pauses" holds by construction.** `anyAlive()`→`gameOver()` on a full party wipe is retained (a real end condition) but in the held-night gate the arena simply keeps running for whoever is alive; per-player death/spectate/respawn is 2b.
- **Held night = re-armed waves.** The sustained-night gate needs a steady horde to feel. `sysSiege`/`sysWave` are configured (gate-only tuning, not new code paths) to hold the night phase and keep re-arming the wave queue at a **representative mid-game difficulty**, so the horde density under which feel matters most is continuously present. The day/night cycle returns with 2b.

### (c) fx delivery — **derive-first** (refines the umbrella spec)

The umbrella spec leaned toward eventing *everything* and deleting `effects()`. Grounded in the real `client.ts` and the bandwidth/determinism goal, this Phase-2 design **refines that to derive-first** (see §Refinement for why this is a deliberate change, not a contradiction):

- **The client keeps `effects()` as its combat-fx source.** Every high/medium-frequency cue it re-derives — kill (zombie id-set diff), hit (`z.flash` edge), hurt (`pl.hitFlash` edge), remote muzzle/shot (`pl.muzzle` edge), heal (`healT` edge), revive (`assistT`+hp), mate-heal (hp bump), cache (`looted` edge), barricade full-repair (hp crossing `maxHp`), deployable spawn/destroy (id-set diff), stalker withdraw (`present` edge) — is reconstructed from fields the snapshot **already carries**. Reading synced authoritative state is **deterministic**; eventing these would add wire bytes for **zero determinism gain**. During a 12-player horde the hit/kill cues are exactly the high-frequency payload we must **not** duplicate onto the wire × the fan-out. The existing gore-intensity heuristic (`goreIntensity` from the synced hp-drop) stays — its feel was accepted under method C, and exact params are not feel-critical.
- **The wire carries events only for the irreducible one-shots `effects()` cannot reconstruct and that must not be dropped:** the siege transitions (`nightfall`/`dawn` banner via the `announce` event), the `waveStart`/`dawn` stings, and the battery `lightDie` cue. These are **low-frequency** (negligible bytes) and the **ordered TCP stream guarantees delivery** — the one property snapshot-diffing can't promise (a latest-wins collapse could skip an intermediate). This is precisely the umbrella §2 justification for events ("siege-transition one-shots … which live in `state.cam`/`flashT` and are never snapshotted"), scoped down to *only* that set.
- **DO serialization:** `snapshot.ts` is already event-capable (Phase 1 Task 12, `PROTOCOL_VERSION 18`). The DO **accumulates `state.fxEvents` across the sim ticks between broadcasts** (60 Hz sim, ~20 Hz broadcast ⇒ ~3 ticks/broadcast) and, on broadcast, **serializes only the allowlisted one-shot variants**, then clears the buffer. It does **not** drain to hardware (no speakers/screen). Non-allowlisted events (kill/hit/muzzle/…) are pushed by the systems (they must be, to keep the systems DOM-free) and **discarded at serialize time** — the client re-derives them.
- **Client drain path:** on snapshot receipt the client (1) `applySnapshot` + `effects(prev,next)` as today, and (2) **drains the snapshot's carried one-shot events** through the existing `drainFxEvents` sink (banner/stings/lightDie). Today the client only drains its own predicted muzzle (`client.ts:579`); this adds the wire-carried one-shots.
- **Local player:** own muzzle/fire-feel stays **predicted** (`applyFireFeel` → local `drainFxEvents`, `client.ts:578–579`). Because muzzle is **not** wire-evented, there is nothing to suppress — no double-fire risk.

Net effect: the wire grows by a handful of bytes per phase transition, not per kill; the client's fx stay deterministic and feel-identical to method C; and the Phase-1 event buffer keeps doing its essential job (letting the headless sim avoid `Audio`/`renderer`).

### (d) `main.ts` collapse + dev harness

- **Three frame paths → one client path.** Delete the worker-ticker host sim + broadcast (`main.ts:388–433`), the `single` branch (`446–459`), and the `host` render-only branch. What remains is the **client path**: sample input → send (rate-limited) → `render()` (predict local, interpolate remote, derive fx, drain one-shots) → `sysFx`/`sysCamera`/`clientAmbience` → reconnect watchdog. `?netlog` `netStats` is retained as the feel-gate instrument.
- **Delete method C wholesale:** `game/net/host.ts`, the WebRTC `transport.ts` (`PeerLink`/manual SDP/`createHostLink`/`createClientLink`), the SDP relay + room-code=`idFromName`=host routing in the signaling Worker, `ticker.ts` (the DO carries the loop). The **new** transport is a single binary WebSocket per client, multiplexing input/snapshot/reliable-events behind a **1-byte type tag** (umbrella §3). A thin `PeerLink`-shaped adapter over the WebSocket keeps `client.ts`'s call sites (`sendSnap`/`sendRel`/`onSnap`/`onRel`/`onOpen`/`onClose`/`close`) stable, so the client rewire is mostly transport-swap, not logic-rewrite.
- **Client input rate-limit:** cap send to ~20–30 Hz, latest-wins (umbrella §3/§4), so inbound doesn't dominate the per-DO message budget.
- **Reconcile constants** retuned for the DO hop + TCP jitter: `interpDelayMs` 100 → ~150 start; widen `smoothCorrect`/`snapTeleportThresh`. Exact numbers are **feel-tuned at the gate**, not fixed here.
- **Lobby collapse:** "enter room code → connect to DO → first snapshot → playing." No Deploy, no host lobby, no public/private toggle, no quick-match-becomes-host. (Matchmaking pool = sub-project 3; single room-code arena is enough to prove authority + feel.)
- **Dev harness = `wrangler dev`** — the real DO + a real WebSocket to `localhost`, reusing the existing `bun run dev:coop` (`concurrently` game + `wrangler dev`) pattern. Faithful (real DO isolate, real TCP), permanent tooling (not gate-only). The `worker/` build gains **`sim/` bundling** (esbuild/wrangler bundles the TS; `worker/` already has its own `tsconfig.json`). An in-process fake-DO was rejected: more code, less faithful.
- **Pre-task — capture the method-C baseline before deleting C:** record the method-C client `netStats` (RTT / jitter / loss / freeze) + a qualitative feel note. This is the **comparison bar** for the TCP feel gate; big-bang removes the same-build A/B, so it must be recorded while C still exists.

## The feel gate (no gate-only code)

The gate proves the umbrella #1 risk: *does prediction + edge placement hold feel over the extra DO hop?* Honoring "no throwaway scaffolding that exists only to pass the gate":

- **Feel = real browsers over the real DO.** A human (plus a few real tabs / devices / friends) connects to the DO via `wrangler dev` locally and, for latency realism, an edge deploy. Zero new code — it exercises the client path we're building anyway. Even solo, the human feels the full extra hop (the #1 risk).
- **Objective headroom = permanent server metrics, not gate code.** A **server-side effective-tick-rate counter** (umbrella §4, the 30 Hz-fallback trigger) + a **snapshot-size log** are production instrumentation we want regardless. They tell us whether the DO sustains 60 Hz at whatever count we reach, and let us extrapolate toward 12.
- **True synthetic 8–12 soak is deferred to sub-project 3** (density curve + interest management), where a reusable load-driver is legitimately in-scope and permanent. It is **not** built in 2a.

Gate pass = the human reports feel at parity with (or acceptably close to) the recorded method-C baseline, and the tick-rate counter shows the DO holding 60 Hz (or a clear, costed reason to trigger the 30 Hz fallback).

## Sequencing

Ordered so the intermediate states are safe bisection points:

1. **Capture the method-C `netStats` baseline** (+ feel note). Pre-condition for big-bang.
2. **DO skeleton + WebSocket transport + `sim/` bundling.** DO runs the `sim/` `update()` loop on `setInterval`, accepts a WebSocket, echoes a snapshot. Client gets a `PeerLink`-shaped WS adapter. Local harness (`wrangler dev`) green: one client sees a moving world.
3. **Connection lifecycle:** `join`/`rejoin` (ported `pickSlot`/nonce/grace), input apply, per-broadcast snapshot fan-out + one-shot event serialization, disconnect + grace-hold.
4. **Client rewire to the single path:** predict + interpolate against the DO, derive fx via `effects()`, drain wire one-shots, rate-limit input, retune reconcile constants. `main.ts` collapses to one path.
5. **Delete method C** (`host.ts`, WebRTC transport, SDP relay, host routing, `ticker.ts`).
6. **Feel gate** (real browsers; edge placement; tick-rate + snapshot-size metrics; compare to baseline).

## Testing

Per CLAUDE.md, only pure deterministic code is unit-tested; feel is the playtest gate.

- **Pure, unit-tested:** the ported connection-lifecycle helpers (`pickSlot` already tested; add the rejoin-match predicate), and the 1-byte-tag transport framing (encode/decode of the type tag + payload boundaries) as a pure round-trip. The `snapshot.ts` `fxEvents` round-trip already exists (Phase 1 Task 12); extend it if the allowlist serialization diverges.
- **Not unit-tested (harness + playtest):** DO loop timing, WebSocket integration, prediction/interp feel, the derive+drain fx path. Validated on the `wrangler dev` harness + the feel gate.

## Non-goals (Phase 2 / 2a)

- Persistent-arena lifecycle, SQLite freeze/thaw, occupied-clock, `breached→resetting→day1` soft-reset, per-player non-pausing shop, day/night cycle return, death/spectate/dawn-respawn — **2b**.
- Matchmaking pool, density curve, interest management, delta/partial snapshots, synthetic load-driver — **sub-project 3**.
- Leaderboard submission, CrazyGames SDK, ads — **sub-project 4**.
- Keeping method C alive as a parallel mode or fallback (big-bang; the contingency is low-occupancy **client** authority, cheap now that `sim/` is browser-runnable — umbrella §Contingency step 4).
- Eventing derivable combat cues onto the wire (see §c — derive-first).

## Refinement to the umbrella 2a spec (root c)

The umbrella spec (`2026-07-11-do-authoritative-server-design.md` §2) states the fx dual path "collapses into the single buffer→drain path" and implies deleting `effects()`. This Phase-2 design **deliberately narrows that**: the wire carries events only for the **irreducible must-not-drop one-shots**, and the client keeps `effects()` to **derive** everything reconstructable from already-synced snapshot fields.

Rationale (the umbrella's own reasoning, followed to its conclusion):
- The umbrella justified events specifically for cues "which live in `state.cam`/`flashT` and are **never snapshotted**." Kill/hit/hurt/muzzle/etc. **are** snapshotted (as id-sets and `flash`/`hitFlash`/`muzzle` fields), so they don't meet that bar.
- The "dual path" the umbrella wanted to remove was the Phase-1 **single-player** divergence (host direct-call vs. client `effects()`). Big-bang **deletes single-player** — there is no host direct-call path left, so there is no divergent dual path to remove. `effects()` becomes simply *the client's fx source*, not one of two competing paths.
- Goal alignment: eventing derivable cues costs wire bytes (worst during the horde, × fan-out) for no determinism gain, contradicting the low-bandwidth/deterministic goal.

This is recorded as a refinement, not a silent deviation — flag it explicitly at spec review and the plan's rubber-duck.

## Open questions / gate items

- **Feel gate:** does prediction + edge placement clear the RTT budget over one TCP hop, at parity with the method-C baseline? (#1 risk.)
- **TCP HOL under real loss:** does latest-wins collapse + interp buffering keep it invisible, or does the umbrella §Contingency ladder escalate?
- **DO CPU ceiling:** does the tick-rate counter show 60 Hz held for the horde at the counts we reach, or is the 30 Hz fallback triggered?
- **Held-night tuning:** what representative wave difficulty makes the gate's horde feel like the real mid-game (not a trivial or unsurvivable night)?
- **`sim/` bundling in `worker/`:** any transitive import that the `worker/` build resolves differently than the game build (the no-DOM `sim/tsconfig` should already have caught DOM edges in Phase 1).
