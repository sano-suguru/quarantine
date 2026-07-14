# DO Server 2b ② — Persistence & Soft-Reset (Design Spec)

- **Date:** 2026-07-14
- **Sub-project:** 2b ② of the CrazyGames large-PvE rearchitecture epic. 2b decomposes into **① gameplay-loop → ② persistence → ③ cleanup**, after the completed `2b-0` housekeeping slice. ① (living arena loop, per-player shop, reconnect) is **done + merged + feel-accepted** (PRs #55–#58). This spec is **②**.
- **Status:** Brainstormed (six design forks resolved with the user). Rubber-duck blind-spot review complete (grounded in the real netcode/DO/CF); seven blockers surfaced and folded into this spec. Pending user review, then planning.
- **Upstream:** game model `docs/superpowers/specs/2026-07-11-large-pve-coop-game-model-design.md`; 2a authority relocation `.../2026-07-12-do-server-phase2-authority-relocation-design.md`; 2b① gameplay loop `.../2026-07-13-do-server-2b1-gameplay-loop-design.md`.

## What this is (and where we are)

2b① turned the arena into a living, cycling, drop-in world: real day/night on the DO, per-player non-pausing shop, death→spectate→respawn, arena auto-reconnect. But the arena is **still ephemeral**: `worker/arena.ts` `stop()` sets `this.state = null` when the last body's grace expires, and a DO eviction/restart (a worker deploy, a rare crash) resets the arena to Day 1. There is no failure stake either — a fully-overrun fortress just rides the night clock to dawn (2b① `breach` "clamps": integrity depletes but nothing resets).

**② adds two things the game model requires:**

1. **A failure stake — the soft-reset.** When the fortress is overrun at night the arena enters a `breached → resetting → day1` state machine: a short announced failure beat, then the communal world rebuilds to a fresh Day-1. Per-player SALVAGE + weapon unlocks (client-side meta) survive; run-scoped power resets.
2. **Persistence — the arena survives sleep and restarts.** The communal cycle state (day/phase/clock/barricades/caches/economy watermark) is written to DO SQLite storage at cycle boundaries and when the arena empties, and reconstructed on the next cold start. An empty arena stops its loop and stops incurring duration charges; a worker deploy or crash resumes from the last persisted boundary instead of resetting to Day 1.

2b③ (cleanup) stays downstream. Matchmaking/arena-pooling, DO-side leaderboard submission, and per-player progression persistence are **out of scope** (later sub-projects — see §Out of scope).

## Locked decisions (six brainstorm forks + duck revisions)

1. **Persistence granularity = durable cycle/progression state only** (Q1). The ephemeral horde (zombies/bullets/pickups/particles/decals/positions, plus the transient `hash`/`flow`/`navTick`) is **not** persisted; on thaw the current phase is re-seeded fresh (`startDay`/`startNight`-equivalent). "Resume the cycle, not the exact bullet" — matches game-model §2.
2. **Write cadence = phase boundaries + last-leave + immediately after a soft-reset** (Q2). An occupied arena receives inbound WS input near-continuously, so it never hits the 70–140s idle-eviction window; the only mid-occupancy state loss is a CF platform restart (worker deploy / rare crash), which resumes from the last **phase boundary** (worst case: the current day's night/dawn opening). Delivers the resume-pointer's "eviction/restart resilience" cheaply (phases are minutes apart).
3. **Breach detection = the fortress interior is overrun** (Q3, **revised by rubber-duck**). Originally "all HOME openings' barricades at hp≤0"; the duck showed this is structurally unreachable (`sim/systems/ai.ts:332` `if (bar.hp <= 0) continue` — a downed opening drops out of collision, the horde funnels through it and stops pressuring the other three). Revised trigger: **the count of zombies inside the HOME rect (`|x| < HW && |y| < HH`, `sim/data/map.ts`) meets a threshold, sustained briefly.** Robustly captures "overrun," reachable via the funnel, and a lone straggler doesn't false-trigger. A pure helper, no new aggregate `State` field.
4. **`arenaReset` transport = phase extension, derive-first** (Q4). `SiegePhase` gains `breached` and `resetting`; both ride the existing snapshot `phase` field. The client detects the reset off the `prevPhase → resetting` phase edge (not a snapshot id-diff) and hard-clears its interpolation buffers + suppresses that frame's diff-derived fx (`effects()`), preventing a mass-kill/mass-spawn burst on the wholesale id churn. No new wire event; reuses the `siegeEdgeCue`/`resetNet` machinery. **PROTOCOL_VERSION 19→20** (the phase wire encoding changes — §M-A.3).
5. **Restore scope = communal world only** (Q5). Persist/restore `day`/`phase`/`phaseT`/`salvageBanked`/`kills`/`barricades[].hp`/`caches[].looted`. **Players are `null`-persisted** — a returning/new player spawns fresh (starter gear, money 0, wlevel reset), exactly as a drop-in joiner does today. 2b② has no account identity (CrazyGames user identity is sub-project 4), so a stranger seated at a recycled `pid` slot must not inherit anyone's run-power. Per-player restoration would additionally require persisting the roster + nonces + bodies (scope blow-up). Per-player SALVAGE/unlocks live in the client's `localStorage` meta and are unaffected.
6. **Two milestones: M-A soft-reset → M-B persistence** (Q6). M-A is pure-sim + client (feel-gateable via `dev:coop`, no DO storage plumbing); M-B is the DO-infra layer that persists the world M-A produces. A→B avoids designing the storage schema before the world shape is final.

**Core insight (validated by the duck):** the client-side arenaReset handling (buffer hard-clear + fx suppression on id churn) is needed **only for the breach soft-reset**, because that is the only reset that happens *while clients are connected*. Freeze/thaw has zero connected clients during the freeze, so the first joiner starts fresh (`prevPhase = null`, `effects()` guarded by `this.prev`) with no special handling. A crash-thaw likewise drops every client, which re-joins fresh via the 2b① reconnect loop. This cleanly separates M-A (client-visible reset) from M-B (transparent restore).

## Design

### M-A — Soft-reset state machine

The failure stake and the `breached → resetting → day1` cycle, entirely in-memory (no storage). Independently mergeable, CI-green, feel-gateable.

#### M-A.1 `SiegePhase` extension

`SiegePhase` (`sim/types.ts`): `"day" | "night"` → `"day" | "night" | "breached" | "resetting"`. `breached` and `resetting` are genuine game states (a frozen dramatic beat; a rebuild window), not ephemeral events, so they belong on `phase` and ride the snapshot like day/night.

#### M-A.2 Breach detection (pure)

A pure helper `isFortressBreached(state)` (co-located in `sim/systems/siege.ts`, unit-tested) returns true when the number of live zombies inside the HOME rect (`|z.x| < HW && |z.y| < HH`) meets `CONFIG.siege.breachZombies`, sustained for `CONFIG.siege.breachSustain` seconds (a small accumulator on `State`, e.g. `breachT`, counting up while over-threshold and decaying below it, so a momentary spike doesn't fire). Only evaluated during `night`. When it fires, `sysSiege` returns `"breached"`.

- Reuses existing state (`state.zombies` + the static HOME rect); **no new communal-integrity field** (extends the mechanism, no special-case debt).
- The threshold + sustain are `CONFIG` constants, feel-tuned. Values are a playtest item, not a spec fork.

#### M-A.3 The state machine + the freeze

`stepSim` (`sim/step.ts`) gains a **single early-return branch** for the reset phases, rather than scattering `phase` gates across `sysPlayer`/`sysAI`/`sysRespawn`/`sysWave` (the duck flagged that none of these systems inspect `phase` today, so scattering would be new special-case debt):

```
stepSim(state, dt):
  if !running || paused: return null            // unchanged guard (DO never sets these)
  if phase === "breached" || phase === "resetting":
      advance the reset-machine timer only; decay cosmetic timers (hitstop);
      DO NOT run sysPlayer/sysAI/sysBullets/sysRespawn/sysWave;
      return the machine's discrete outcome ("resetting" | "day1" | null)
  ... existing day/night pipeline ...
```

- **The freeze does not set `state.paused`.** The invariant "the DO never globally pauses" holds — the reset phases simply skip the gameplay systems while their own countdown advances. `state.paused`'s early-return stays for client/test use; the DO never trips it.
- **`breached`** (~`CONFIG.siege.breachedDuration`, e.g. 3s): the announced failure beat. Sim frozen; the client shows a "FORTRESS FALLEN" cue + dread audio off the `night → breached` phase edge. Held bodies still down, zombies frozen in the tableau. On timer elapse → `resetting`.
- **`resetting`** (brief, ~1 tick or a short window): the DO rebuilds the communal world to a fresh Day-1 — `day = 1`, `startDay(state)` (restock caches, seed roamers), all `barricades` back to `boardMaxHp`, `caches` un-looted, `salvageBanked = 0`, `kills = 0`, clear `zombies`/`bullets`/`pickups`/`particles`/`decals`. Players are re-seeded alive at the fortress (existing `revivePlayer`/HOME-spawn spread). `nextId` keeps incrementing (do **not** reset it — fresh Day-1 entity ids must not alias ids still sitting in a connected client's interp buffer mid-clear). Then → `day` (Day-1). Joins arriving during `resetting` are handled by §M-A.5.
- **`sysSiege` else-branch fix:** `sysSiege` currently branches only on `day`/`night`, falling through to the night path (`sysWave`). With the enum extended, the reset phases must **not** reach `sysWave`; the stepSim early-return handles this (sysSiege is never called for reset phases), but `sysSiege` also gets a defensive guard.

**PROTOCOL_VERSION 19→20.** The snapshot encodes `phase` in a **single flag bit** today (`sim/snapshot.ts`: encode `snap.phase === "night" ? 4 : 0` = bit2; decode `(flags & 4) !== 0 ? "night" : "day"`). Four phase values need **two bits**: use bit2 **and** bit3 (bit3 was freed and marked reserved when 2b① removed `inShop`) as a 0–3 phase index (`["day","night","breached","resetting"][(flags >> 2) & 3]`). Byte length is unchanged, so the `Reader` (which has no bounds checks — 2b① §5) is unaffected; but a v19 client would misread the new phases as day/night, so the version bump + the hello `v` gate cleanly reject stale clients. `captureSnapshot`/`applySnapshot` pass `phase` through unchanged.

#### M-A.4 Client arenaReset handling (derive-first)

On the `prevPhase → resetting` phase edge, `game/net/client.ts` runs its existing **`resetNet`-equivalent** reset: clear the snapshot buffer, `prev = null`, `prevPhase = null`, drop prediction (`predX`/`predY`). Because `effects()` is guarded by `if (this.prev)`, nulling `prev` suppresses the diff-derived fx (mass `fxKill`/`fxImpact` on the id churn) for the reset frame; `prevPhase = null` also suppresses a spurious siege banner on the first post-reset snapshot (same guarantee drop-in and reconnect already rely on).

- **Primary trigger is the phase edge, not `day → 1`.** A breach on the **night of day 1** leaves `day` at 1→1 (no change), so a `day`-diff trigger would miss it; the `→ resetting` edge is unambiguous. (`day → 1` may serve as a secondary assertion only.)
- **`siegeEdgeCue` extension:** `sim/systems/siegeEdge.ts` today returns a NIGHT cue for `night` and a DAY cue otherwise — so `breached`/`resetting` would wrongly fire a "DAY" banner. Add explicit branches: `breached` → the fallen-fortress cue; `resetting` → no-op. Unit-tested.

#### M-A.5 Joins during `resetting`, and meta

- A join landing in the `resetting` window: `spawnFresh` spawns the body alive at the fortress as usual, but its position/state will be overwritten by the imminent Day-1 re-seed — acceptable (they materialize into Day-1 a beat later). The draft-roll gate (`s.phase === "day"`) simply doesn't fire during `resetting`; they roll at the Day-1 dawn or on the day-phase spawn path, guarded by `draftRolledForDay` (2b① mechanism, unchanged).
- **Meta survives the reset.** SALVAGE balance + weapon unlocks are client `localStorage` (`game/meta.ts`); a soft-reset touches only the DO's run-scoped world. Run-power (wlevel/dmgMul/money) resets with the fresh Day-1 — the game-model's intended stake.
- **Leaderboard finalize at breach is out of scope** (leaderboard = sub-project 4). 2b② enters `breached` and resets; it does **not** submit a score. See §Out of scope.

**M-A feel-gate (blocking):** via `dev:coop`, deliberately let the fortress be overrun (don't defend) and confirm **(a) a breach actually fires** (the revised interior-overrun trigger is reachable — the duck's P0), **(b) the `breached` beat reads as a horror payoff**, and **(c) the Day-1 re-seed lands with no mass-kill/mass-spawn fx burst** and no spurious banner, for both a player present through the reset and a fresh joiner.

### M-B — Persistence (DO infrastructure)

Freeze/thaw + crash-resilience + empty-arena cost-down, layered onto the world M-A produces. Transparent to connected clients (per the core insight).

#### M-B.1 Storage handle + cold-start load

`worker/arena.ts` `Arena` currently has **no constructor** and never captures `ctx`. Add:

```ts
constructor(private ctx: DurableObjectState, _env: unknown) {
  ctx.blockConcurrencyWhile(async () => { this.saved = await this.load(); });
}
```

- `blockConcurrencyWhile` gates **all** requests/messages until the load resolves, so a join racing the cold-start load cannot see a half-initialized arena (CF serializes it). The WS upgrade in `fetch` is delivered only after load.
- **Load must not throw out of `blockConcurrencyWhile`** (that aborts/resets the DO). Wrap the storage read in try/catch; on any failure (missing/corrupt/unknown-schema blob) fall back to "no saved state" → fresh Day-1.
- The Arena is a plain class (not `extends DurableObject`); the CF runtime passes `(ctx, env)` regardless, so capturing `ctx.storage` this way is sound.

#### M-B.2 Storage format — a single communal-cycle blob

The Arena is already a **SQLite-backed DO** (`worker/wrangler.toml` migration v3 `new_sqlite_classes: ["Arena"]`), so both `ctx.storage.sql` and the synchronous **KV API** are available. The persisted state is one small structured value, so use the **KV API** (`ctx.storage.put("cycle", blob)` / `get`) — no SQL schema, no manual migration table (`PRAGMA user_version` is unsupported on DO SQLite anyway).

```
CycleBlob = {
  schemaVersion: number,       // bump on shape change; unknown → fresh Day-1
  day: number,
  phase: SiegePhase,           // never persisted mid-reset (see M-B.3)
  phaseT: number,
  salvageBanked: number,       // dawn delta baseline — MUST restore (else double-payout)
  kills: number,               // drives waves AND salvageEarned
  barricades: number[],        // hp per opening, index-aligned to HOME.openings
  caches: boolean[],           // looted per cache, index-aligned to newState() caches
}
```

- **Excluded (duck P2):** `owned`/`unlockedCards` (DO-side `owned` is always just starters — `unlockProvider()` returns `{}` server-side — and restoring a prior member's unlock set contradicts the no-account-identity premise; the cold-start joiner's `newState()` re-derives starters); `caches[].searchT` (a transient "someone is mid-search" value, always 0 at an empty freeze); all ephemeral entities and per-player bodies (Q1/Q5).
- Serialize/deserialize is a **pure function** (`worker/`-side or a shared helper) with a round-trip unit test.

#### M-B.3 Write cadence

Persist the blob (fire-and-forget) at:
- **Phase transitions** — in the DO `step()` where `stepSim` returns `"dawn"`/`"night"` (and after a soft-reset settles to Day-1). Captures the day count, barricade state, and `salvageBanked` watermark at each boundary.
- **Last-leave** — when the arena empties (§M-B.4).

Never persist while `phase` is `breached`/`resetting` (a transient, non-resumable state) — write on the *settled* Day-1 after a reset, so a crash during the beat thaws to a coherent phase.

**Write mechanics (duck P1):** the DO `step()` loop is synchronous; `ctx.storage.put` is async. Call it fire-and-forget with a `.catch(logErr)` — do **not** `await` inside the tick (it would stall the loop). Writes are rare (phase boundaries are minutes apart), so the output-gate's held-until-durable behavior adds at most a one-tick broadcast delay at a boundary — imperceptible; noted, not mitigated.

#### M-B.4 Freeze on empty, thaw on cold start

- **`ensureRunning()`** changes from "always seed a fresh Day-1" to: **if a saved blob was loaded, reconstruct the communal world from it; else fresh Day-1.** Reconstruct = `newState()` for structure, then overlay the blob: set `day`/`phase`/`phaseT`/`salvageBanked`/`kills`, overwrite `barricades[i].hp` and `caches[i].looted`, re-seed the current phase's ambient entities (`startDay` if day, `startNight` if the frozen phase is night — arming roamers/wave for the restored `phaseT`), and **set `s.running = true`** (the `stepSim` guard requires it — duck P2).
- **`stop()`** (last-leave): serialize the **live** state and `put` it **before** `this.state = null` (the current code nulls synchronously; serialize first, then null; the put is fire-and-forget). Everything else in `stop()` (clearInterval, peers.clear, metric reset) is unchanged.
- **Grace interaction (verified, safe):** while any body is `absent` in its grace window the peer entry is retained, so `peers.size !== 0` and the loop keeps running (non-hibernatable, not idle) — no eviction mid-grace since `graceMs` (20s) ≪ the 70–140s eviction floor. `stop()` (and its persist) fires only after the last grace expires and `peers.size === 0`. A crash *during* grace falls back to the last phase-boundary blob (Q2's accepted resolution).
- **Empty-arena hibernate = no extra code.** Once `stop()` clears the interval and the sockets have closed, the DO satisfies the hibernation conditions (no setInterval, no standard-WS-in-use, no in-flight I/O) → it hibernates (10s) or, failing that, evicts (70–140s); either way in-memory state is discarded and **duration billing stops**. The next `fetch` runs the constructor → `load` → reconstruct. **The Hibernation WebSocket API is deliberately not adopted** (it exists to keep *connected* clients attached during sleep; an empty arena has none — standard WS API stays).

**M-B feel/robustness gate:** with `wrangler dev`, (a) play a few days, kill+restart the worker mid-day, confirm the arena resumes at the last phase boundary (day count, barricade hp, SALVAGE watermark) rather than Day 1; (b) solo-play, leave, rejoin after the arena has frozen, confirm the day/world resumed (not reset); (c) confirm a fresh brand-new arena code still starts at Day 1.

## Invariants preserved

- **The DO never globally pauses** — `state.paused`/`state.inShop` are never set server-side. `breached`/`resetting` freeze the sim via the `stepSim` early-return, not `paused`.
- **Systems stay net-agnostic** — state + events, never importing net/storage code. All storage lives in `worker/arena.ts`.
- **`sim/` stays headless** — no DOM/WebGL/audio/storage; enforced by `sim/tsconfig.json`. The breach helper, phase machine, and blob serialize/deserialize are pure (or live in `worker/`).
- **Derive-first fx** — the soft-reset is signalled by the synced `phase` field + the client's phase-edge reset, not a new wire event and not a snapshot id-diff. No `fxEvents` on the wire.
- **Feel-first** — breach reachability + the failure beat + reset coherence, and restart/freeze resilience, are validated by playtest, not just compilation.

## Out of scope / deferred

- **Matchmaking / arena pooling.** 2b② keeps `idFromName` = one-DO-per-code (`worker/index.ts`). The game-model's "pool + matchmaker in front of routing" is a later sub-project (3/4). "Empty-arena hibernate" here means the single named arena freezes/reconstructs; it is not a pooling change.
- **DO-side leaderboard submission** + CrazyGames SDK/ads — **sub-project 4**. 2b② enters `breached` and resets but submits no score; a submission seam can hang off the breach transition later. Consequence recorded: the game-model's held-absent "finalize leaderboard at breach" cell is **not** satisfied in 2b② — a held-absent body at breach is simply removed (no finalize).
- **Per-player progression persistence** across freeze/thaw/crash (Q5) — needs account identity (sub-project 4) + roster/nonce/body persistence.
- **"Drop carried SCRAP on death"** penalty (game-model §Death) — additive balance tuning.
- **Point-in-time recovery** (DO SQLite offers 30-day PITR) — not needed; noted as available.
- **Delta/partial snapshots, interest management, ~32-player density** — sub-project 3.

## Open questions / playtest items

- **Breach threshold + sustain** (`breachZombies`/`breachSustain`): what interior-zombie count reads as "overrun" without being a hair-trigger or unreachable? Solo vs crowded. The M-A blocking feel-gate.
- **`breachedDuration`**: how long does the fallen-fortress beat want to be for the horror payoff without dragging?
- **Reset recoverability:** does losing run-power (wlevel/money) to a breach feel like a fair stake or a punishment, given SALVAGE/unlocks persist?
- **Restart granularity:** is "resume at the last phase boundary" (worst case: the current day's night/dawn opening) acceptable, or does a mid-night restart snapping back to the night opening feel like lost progress? (If so, a coarse periodic `phaseT` refresh is the escalation — deferred unless the gate fails.)
- **Thaw entity re-seed:** re-seeding the phase's ambient horde on thaw (rather than restoring positions) — does a returning solo player notice the horde "resetting" its composition? (Expected fine; playtest confirm.)
- **Breach during reconnect grace:** a held-absent body present at breach is removed (no finalize); confirm no client-side artifact when that body's owner reconnects post-reset (they get a fresh Day-1 join).

## Testing

Pure/deterministic additions get co-located Vitest coverage (existing discipline):
- `isFortressBreached` — interior-count threshold + the sustain accumulator (over/under/flicker cases).
- `sysSiege` / the `stepSim` reset branch — `night → breached → resetting → day1` transitions and outcomes; the early-return skips gameplay systems; `sysSiege` never reaches `sysWave` in reset phases.
- The snapshot `phase` 2-bit encode/decode round-trip across all four values (guards the M-A.3 bit change).
- `siegeEdgeCue` — `breached` cue, `resetting`/reset-edge no-op suppression.
- The `CycleBlob` serialize/deserialize round-trip (pure), including unknown-`schemaVersion` → fresh-start.

The DO's write cadence, `blockConcurrencyWhile` load/thaw, empty-freeze, and the client buffer-clear on reset are exercised via the `wrangler dev` harness + real-browser playtest (the feel/robustness gates), consistent with 2a/2b①.

## Milestone decomposition

- **M-A — Soft-reset state machine.** §M-A. `SiegePhase` extension + `PROTOCOL_VERSION 19→20`, `isFortressBreached`, the `stepSim` reset branch + freeze, the snapshot 2-bit phase, client phase-edge reset + `siegeEdgeCue` extension. In-memory only; a breach resets the live arena. **Merges without persistence — a DO restart still drops state to Day 1 (same as 2b①, no regression);** M-B adds the resilience. Blocking feel-gate: breach reachability + beat + reset coherence.
- **M-B — Persistence.** §M-B. `Arena` constructor + `ctx.storage` + `blockConcurrencyWhile` load, the `CycleBlob` KV format, the phase-boundary/last-leave writes, `ensureRunning`/`stop` freeze/thaw, empty-arena hibernate (no extra code). Robustness gate: restart-resume + freeze/rejoin-resume + fresh-arena-still-Day-1.

Ordering: M-A first (the world shape must be final before persisting it; pure-sim + client, feel-gateable standalone); M-B layers storage onto it transparently.
