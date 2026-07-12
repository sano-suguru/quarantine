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
- **Empty-arena → stop the loop, retiring held bodies first.** When the last socket closes, **retire every held-`absent` body immediately** (not via `tickGrace`), then `clearInterval` and let the DO idle (billing stops). Retiring up-front avoids a frozen-clock hazard: `tickGrace` compares `goneAt` against a wall clock the umbrella flagged as coarsened/frozen while idle, so a body held across a loop-stop could mis-expire on restart. For 2a the in-memory state resets on a fully-empty arena; occupied-clock freeze/thaw + SQLite persistence is **2b**.
- **Routing:** reuse the room-code → DO `getByName`/`idFromName` path. One arena. `locationHint` on first `get()` for edge placement (umbrella §Contingency step 1); Japan → `apac-ne`.

**Two porting constraints the `host.ts` code encodes implicitly — the plan must call them out:**
- **The slot-assign handler must stay `await`-free between `pickSlot` and setting `decided`.** `host.ts:219` carries a load-bearing comment: an `await` there would let two joins claim one slot. Today WebRTC callbacks are synchronous main-thread events; DO WebSocket `message` handlers are also processed sequentially (no true reentrancy), **so the invariant ports intact — but only if the DO `join` handler commits the slot synchronously.** DO handlers are often written `async` for `storage` access; any `await` before `decided=true` reopens the double-claim race. Hard constraint.
- **The DO has no lobby / "not-yet-started" state.** `host.ts`'s `decideFresh`-on-open branch (`host.ts:106–120`, taken when `!this.started`) does not exist — the arena is always running, so every socket takes the **first-rel path** (wait for `join`/`rejoin`, with the `rejoinClaimTimeoutMs` fallback). Drop that branch on the port.

The connection helpers stay **pure and unit-testable** (`pickSlot` already is; the rejoin-match predicate is extractable the same way), per the umbrella testing note.

### (b) The DO's authoritative step — `update()` sheds its cosmetic tail

**Grounding correction:** `update()` is **not** headless today — it lives in `game/game.ts` (not `sim/`), imports `Audio`/`renderer`, and on transitions calls `openShop()`/`gameOver()` (DOM/UI functions in `game.ts`). Phase 1 extracted the *systems/state/helpers* into `sim/` but left the **orchestrator** in the client layer. So the DO cannot run `game.ts`'s `update()`; Phase 2 must **extract a headless step into `sim/`**:

- **Extract `sim/step.ts` → `stepSim(state, dt): "night" | "dawn" | "wipe" | null`.** It contains the body of `game.ts`'s `update()` (`game.ts:183`) — `sysPlayer → sysAssist → sysAI → sysStalker → sysDeployables → sysBullets → sysPickups → sysSiege → transition pushes` — but **decoupled from the two client-side reactions**: instead of calling `openShop()` (dawn) or `gameOver()` (party wipe), it **returns the discrete result** and lets the caller decide. It also **excludes `sysFx`/`sysCamera`** (cosmetic/per-client). Transition *event pushes* (`announce`/`audio`) stay (they're just `fxEvents`).
- **The DO** calls `stepSim` directly. In the 2a held-night gate it ignores the `"dawn"`/`"wipe"` returns (held-night never dawns; per-player shop + death/end are 2b) — the arena just keeps running. `openShop`/`gameOver` (DOM) never enter the DO.
- **During coexistence (Milestone A)**, `game.ts`'s `update()` is re-implemented as a thin wrapper — `stepSim(state, dt)` then the client reactions (`openShop` on `"dawn"`, `gameOver` on `"wipe"`, `sysFx`, `sysCamera`) — so single-player/method-C stay **feel-unchanged** (byte-identical system logic; the only reorder is `sysFx` now running just after `sysSiege` instead of just before, which is inconsequential — `sysSiege`/`sysWave` create no particles and don't touch `state.cam`). At the cutover `game.ts`'s `update()` is deleted; nothing in the browser calls `stepSim`.
- `state.cam` and `state.particles` stay **off the authoritative wire** (already not in `snapshot.ts`). The DO never allocates meaningful particle churn; the client owns its camera and particles.
- **Caveat — cosmetic residue on the DO.** Removing `sysCamera` removes the *only* decayer of `state.cam.shake` (`camera.ts`), yet authoritative combat systems still *write* it (`feel.ts`, `bullets.ts`, `ai.ts`). So on the DO `cam.shake` climbs and pins at its clamp ceiling — harmless (off-wire, never read server-side, bounded by `Math.min`), but it means "the cosmetic tail sheds cleanly" is not literally true: a cosmetic *head* (shake writes scattered in combat systems) remains. `state.flashT` is fine — its decay stays inline in `stepSim`, not in `sysCamera`. Routing shake/flash through the fx seam (per-viewer) is the honest full fix and is **Phase-2 carry-forward ② from the Phase-1 ledger**; deferred here (harmless) to keep the slice thin, but recorded rather than glossed.
- **Invariant — the DO never globally pauses.** Because `stepSim` returns `"dawn"` rather than calling `openShop()`, and the held-night gate ignores that return, `state.paused`/`inShop` are never set on the DO. The promoted invariant holds by construction.
- **Held night = a small explicit mechanism extension (not "zero new code").** The sustained-night gate needs a steady horde to feel, and holding the night **cannot** be done by config alone: `sysSiege` (`siege.ts:74–87`) unconditionally decrements `phaseT` and returns `"dawn"` at zero — no knob prevents it, and forcing it with an astronomical `nightDuration` is exactly the magic-value special-case CLAUDE.md forbids. The honest form is a **`heldNight` state flag consulted by `sysSiege`** (return `null` instead of `"dawn"` while held) — a small, clean mechanism extension gated for 2a and generalized by 2b's day/night return, in the spirit of "extend the mechanism." Horde supply needs no new code: `startNight` is entered once at a **representative mid-game `day`/`waveN`**, and `sysWave`'s existing cap-refill loop (`wave.ts:117–128`) sustains pressure indefinitely — the night simply never ends (there is no "re-arm"; it tops up to `cap`).

### (c) fx delivery — **derive-first** (refines the umbrella spec)

The umbrella spec leaned toward eventing *everything* and deleting `effects()`. Grounded in the real `client.ts`/`snapshot.ts`/`game.ts` and the bandwidth/determinism goal, this Phase-2 design **refines that to derive-first — and the conclusion is stronger than a small allowlist: for 2a's cue set the wire carries _zero_ `fxEvents`.** Everything is reconstructable client-side from already-synced authoritative fields (see §Refinement for why this is a deliberate change, not a contradiction):

- **Combat cues → `effects()` derivation.** The client keeps `effects()` and re-derives kill (zombie id-set diff), hit (`z.flash` edge), hurt (`pl.hitFlash` edge), remote muzzle/shot (`pl.muzzle` edge), heal (`healT` edge), revive (`assistT`+hp), mate-heal (hp bump), cache (`looted` edge), barricade full-repair (hp crossing `maxHp`), deployable spawn/destroy (id-set diff), stalker withdraw (`present` edge) — all from fields the snapshot **already carries**. Reading synced authoritative state is deterministic; eventing these would add wire bytes for zero determinism gain, worst during the 12-player horde × fan-out. The `goreIntensity(hp-drop)` heuristic stays (accepted under method C).
- **Siege transitions → synced `phase` edge, not a wire event.** The NIGHT/DAY banner and the `waveStart`/`dawn` audio stings are pushed in `update()` **coincident with the phase change** (`game.ts:211–216`: `ev==="night"` ⟺ `phase`→`night`). Since `phase`/`day`/`waveN` are snapshotted, the client derives these one-shots from a **`prevPhase` edge** (new, tiny, in the spirit of `effects()`). This is *more* robust than a wire event: on reconnect the client reconciles from the fresh snapshot's `phase` (no missed-banner desync), and a drop-in mid-night correctly shows **no** banner (no edge — you joined, you didn't transition). Zero bytes.
- **`lightDie` → already derive-first (spec correction).** It is **not** a wire event: `audioAmbience` (`game.ts:248`) fires it on each client from its own synced `battery` crossing zero (`AUDIO_CUES` in `snapshot.ts` has no `lightDie`; `drainAudioCue` has no case). The client already runs `audioAmbience`, so this keeps working untouched.
- **Local player fire-feel → predicted.** Own muzzle/recoil/shake/shot-audio stay predicted (`applyFireFeel` → local `drainFxEvents`, `client.ts:578–579`). Not wire-evented ⇒ nothing to suppress, no double-fire.
- **DO serialization:** the systems still push `state.fxEvents` (required to keep the headless sim DOM-free), but the DO **serializes an empty event list in 2a** and clears the buffer each broadcast — it drains to nothing (no speakers/screen). The event-capable snapshot format (Phase 1 Task 12, `PROTOCOL_VERSION 18`) stays plumbed but idle, **reserved for 2b's genuinely non-derivable events** (e.g. the `arenaReset` one-shot the game-model spec flags, which a `phase`/id-diff cannot reconstruct because the soft-reset re-seeds everything at once).

**Feel trade to state honestly (rubber-duck finding):** derive-first means *every* player gets the client-side approximation that today only method-C *clients* get — and single-player/host loses its privileged exact gore. Two concrete losses: (1) the killing-frame **finisher spray** is host-only today (`bullets.ts` uses real bullet `dmg`; the client re-derives from hp-drop) — it disappears for everyone; (2) re-derived kills pass `dir/hitDir = 0` (`client.ts:264`), so **fragment bloom launches radially, not along the hit direction**. Both are cosmetic and match the *current co-op client* experience (no regression there), but they *are* a regression from single-player feel. **Playtest item at the gate.** If the directional kill-gore is missed, the cheap fallback is to wire the `kill` event (per-kill bytes) — a deliberate, measured exception, not the default.

### (d) `main.ts` collapse + dev harness

- **Three frame paths → one client path.** Delete the worker-ticker host sim + broadcast (`main.ts:388–433`), the `single` branch (`446–459`), and the `host` render-only branch. What remains is the **client path**: sample input → send (rate-limited) → `render()` (predict local, interpolate remote, derive fx via `effects()` + the `prevPhase` edge, drain the local predicted muzzle) → `sysFx`/`sysCamera`/`clientAmbience` → reconnect watchdog. `?netlog` `netStats` is retained as the feel-gate instrument.
- **Delete method C wholesale:** `game/net/host.ts`, the WebRTC `transport.ts` (`PeerLink`/manual SDP/`createHostLink`/`createClientLink`), the SDP relay + room-code=`idFromName`=host routing in the signaling Worker, `ticker.ts` (the DO carries the loop). The **new** transport is a single binary WebSocket per client, multiplexing input/snapshot/reliable-events behind a **1-byte type tag** (umbrella §3). A thin `PeerLink`-shaped adapter over the WebSocket keeps `client.ts`'s call sites (`sendSnap`/`sendRel`/`onSnap`/`onRel`/`onOpen`/`onClose`/`close`) stable, so the client rewire is mostly transport-swap, not logic-rewrite. Adapter details the plan must honor (rubber-duck): frame **both** kinds as binary (tag byte + raw snapshot bytes, or tag byte + UTF-8 JSON of the rel message) so the adapter owns `JSON.stringify`/`parse` and the call sites stay object-typed; replicate `sendSnap`'s `readyState===OPEN` no-op guard (`transport.ts:178`) or early snapshots throw; **keep** `client.ts`'s `snap.tick <= lastTick` drop (`:149`) — over one ordered stream it never fires, so it's a cheap harmless invariant guard, not dead-harmful (leave it); and **preserve the `PROTOCOL_VERSION` Hello gate** (`client.ts:114`) on the WS `hello` — a persistent DO serving a stale-build client makes `decode()`'s unknown-tag truncation (`snapshot.ts`) silently lossy every broadcast, so version mismatch must refuse before play.
- **Client input rate-limit:** cap send to ~20–30 Hz, latest-wins (umbrella §3/§4), so inbound doesn't dominate the per-DO message budget. **Playtest caveat (rubber-duck):** latest-wins overwrite (`p.input = msg.input`) can drop a *semi-auto* fire-then-release that falls within one 33–50 ms send window — a shot the client predicted but the DO never applied. Auto weapons (sustained `firing`) are unaffected, and PR #50's auto-fire likely makes this rare, but confirm semi-auto feel specifically at the gate. Method C (send every rAF) has no such window; the rate-limit introduces it.
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

Ordered so **every intermediate commit leaves something runnable** — the key correction from the rubber-duck: the DO client is added as a **coexisting mode alongside method C**, and the old paths are deleted only at the atomic cutover, so there is never a "both broken, bisection-blind" window.

1. **Capture the method-C `netStats` baseline** (+ feel note) while C still runs. Pre-condition for big-bang.
2. **DO skeleton + WebSocket transport + `sim/` bundling — added, not replacing.** DO runs the `sim/` `update()` loop on `setInterval`, accepts a WebSocket, echoes a snapshot. Add a **new coexisting `Net.mode`** (e.g. a `doclient` path, reachable behind a dev flag/route) with a `PeerLink`-shaped WS adapter. **Method C's `single`/`host`/`client` paths stay untouched and fully runnable** — bisection baseline preserved. Local harness (`wrangler dev`) green: one DO client sees a moving world.
3. **Connection lifecycle** on the DO path: `join`/`rejoin` (ported `pickSlot`/nonce/grace, honoring the sync + drop-in constraints), input apply, per-broadcast snapshot fan-out, disconnect + grace-hold. Method C still coexists.
4. **Atomic cutover — one commit.** Make the DO path the default, delete the `single`/`host`/`client` frame branches + worker ticker, derive-fx via the `prevPhase` edge, rate-limit input, retune reconcile constants. `main.ts` collapses to one path. This is the single point where the old paths stop running; it lands only after 2–3 proved the DO path works.
5. **Delete method-C dead code** (`host.ts`, WebRTC `transport.ts`, SDP relay, host routing, `ticker.ts`) — now unreachable.
6. **Feel gate** (real browsers; edge placement; tick-rate + snapshot-size metrics; compare to baseline).

## Testing

Per CLAUDE.md, only pure deterministic code is unit-tested; feel is the playtest gate.

- **Pure, unit-tested:** the ported connection-lifecycle helpers (`pickSlot` already tested; add the rejoin-match predicate), and the 1-byte-tag transport framing (encode/decode of the type tag + payload boundaries) as a pure round-trip. The `snapshot.ts` `fxEvents` round-trip already exists (Phase 1 Task 12) and stays as-is — 2a serializes an empty list, so the test just confirms the format still round-trips (it earns its keep for 2b's events).
- **Not unit-tested (harness + playtest):** DO loop timing, WebSocket integration, prediction/interp feel, the derive+drain fx path. Validated on the `wrangler dev` harness + the feel gate.

## Non-goals (Phase 2 / 2a)

- Persistent-arena lifecycle, SQLite freeze/thaw, occupied-clock, `breached→resetting→day1` soft-reset, per-player non-pausing shop, day/night cycle return, death/spectate/dawn-respawn — **2b**.
- Matchmaking pool, density curve, interest management, delta/partial snapshots, synthetic load-driver — **sub-project 3**.
- Leaderboard submission, CrazyGames SDK, ads — **sub-project 4**.
- Keeping method C alive as a parallel mode or fallback (big-bang; the contingency is low-occupancy **client** authority, cheap now that `sim/` is browser-runnable — umbrella §Contingency step 4).
- Carrying any `fxEvents` on the wire in 2a (see §c — derive-first; everything is reconstructable from synced fields). Wire events return in 2b for `arenaReset`.

## Refinement to the umbrella 2a spec (root c)

The umbrella spec (`2026-07-11-do-authoritative-server-design.md` §2) states the fx dual path "collapses into the single buffer→drain path" and implies deleting `effects()`. This Phase-2 design **deliberately narrows that all the way to: 2a carries _zero_ `fxEvents` on the wire.** The client keeps `effects()` to derive combat cues, and derives siege transitions from the synced `phase` edge — nothing in 2a's cue set is both non-snapshotted and non-derivable. The event-capable snapshot format stays plumbed, idle, reserved for 2b.

Rationale (the umbrella's own reasoning, followed to its conclusion):
- The umbrella justified events specifically for cues "which live in `state.cam`/`flashT` and are **never snapshotted**." But every 2a cue is reconstructable: combat from id-sets/`flash`/`hitFlash`/`muzzle`; transitions from the `phase`/`day`/`waveN` edge; `lightDie` from `battery`. None meets the "non-snapshotted **and** non-derivable" bar that would earn wire bytes.
- The "dual path" the umbrella wanted to remove was the Phase-1 **single-player** divergence (host direct-call vs. client `effects()`). Big-bang **deletes single-player** — there is no host direct-call path left, so there is no divergent dual path to remove. `effects()` becomes simply *the client's fx source*, not one of two competing paths.
- Goal alignment: eventing derivable cues costs wire bytes (worst during the horde, × fan-out) for no determinism gain, contradicting the low-bandwidth/deterministic goal.
- **The event mechanism is not wasted:** the systems still push `state.fxEvents` (the headless sim's DOM-free seam), the client still drains locally for its own predicted muzzle, and the wire format is ready for 2b's genuinely-irreducible `arenaReset` (a soft-reset re-seeds everything at once — no id-diff or phase edge can reconstruct it).

This is recorded as a refinement, not a silent deviation — flagged explicitly at spec review and the plan's rubber-duck. (It began as a small wire allowlist and tightened to zero after the rubber-duck showed the transitions and `lightDie` are all derivable.)

## Open questions / gate items

- **Feel gate:** does prediction + edge placement clear the RTT budget over one TCP hop, at parity with the method-C baseline? (#1 risk.)
- **RTT-metric validity (rubber-duck):** the baseline's `netStats().rtt` is measured on WebRTC's reliable channel; on the DO path ping/pong shares the single ordered WebSocket, so its RTT includes head-of-line queueing behind snapshots under load. The two numbers measure subtly different things — the gate comparison must account for this, or add a dedicated latency probe outside the snapshot stream. This matters because RTT is the #1-risk instrument.
- **Directional kill-gore feel (rubber-duck):** derive-first drops the host-only finisher spray and directional fragment bloom for all players (§c). Acceptable, or does it warrant wiring the `kill` event as a measured exception?
- **TCP HOL under real loss:** does latest-wins collapse + interp buffering keep it invisible, or does the umbrella §Contingency ladder escalate?
- **DO CPU ceiling:** does the tick-rate counter show 60 Hz held for the horde at the counts we reach, or is the 30 Hz fallback triggered?
- **Held-night tuning:** what representative wave difficulty makes the gate's horde feel like the real mid-game (not a trivial or unsurvivable night)?
- **`sim/` bundling in `worker/`:** any transitive import that the `worker/` build resolves differently than the game build (the no-DOM `sim/tsconfig` should already have caught DOM edges in Phase 1).
