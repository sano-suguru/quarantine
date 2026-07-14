# DO Server 2b ② — Persistence & Soft-Reset (Design Spec)

- **Date:** 2026-07-14
- **Sub-project:** 2b ② of the CrazyGames large-PvE rearchitecture epic. 2b decomposes into **① gameplay-loop → ② persistence → ③ cleanup**, after the completed `2b-0` housekeeping slice. ① (living arena loop, per-player shop, reconnect) is **done + merged + feel-accepted** (PRs #55–#58). This spec is **②**.
- **Status:** Brainstormed (six design forks resolved with the user). **Two** rubber-duck blind-spot passes (both grounded in the real netcode/DO/CF): a design-level pass (7 blockers → the interior-overrun breach trigger, the `stepSim` freeze, the 2-bit phase, phase-edge client reset, write ordering, tightened schema) and a written-spec pass (6 more → thaw must not call `startDay`/`startNight`, the return-value↔DO handler contract, `HW`/`HH` export, two-edge client handling, feel-gate prerequisites). All folded in. Pending user review, then planning.
- **Upstream:** game model `docs/superpowers/specs/2026-07-11-large-pve-coop-game-model-design.md`; 2a authority relocation `.../2026-07-12-do-server-phase2-authority-relocation-design.md`; 2b① gameplay loop `.../2026-07-13-do-server-2b1-gameplay-loop-design.md`.

## What this is (and where we are)

2b① turned the arena into a living, cycling, drop-in world: real day/night on the DO, per-player non-pausing shop, death→spectate→respawn, arena auto-reconnect. But the arena is **still ephemeral**: `worker/arena.ts` `stop()` sets `this.state = null` when the last body's grace expires, and a DO eviction/restart (a worker deploy, a rare crash) resets the arena to Day 1. There is no failure stake either — a fully-overrun fortress just rides the night clock to dawn (2b① `breach` "clamps": integrity depletes but nothing resets).

**② adds two things the game model requires:**

1. **A failure stake — the soft-reset.** When the fortress is overrun at night the arena enters a `breached → resetting → day1` state machine: a short announced failure beat, then the communal world rebuilds to a fresh Day-1. Per-player SALVAGE + weapon unlocks (client-side meta) survive; run-scoped power resets.
2. **Persistence — the arena survives sleep and restarts.** The communal cycle state (day/phase/clock/barricades/caches/economy watermark) is written to DO SQLite storage at cycle boundaries and when the arena empties, and reconstructed on the next cold start. An empty arena stops its loop and stops incurring duration charges; a worker deploy or crash resumes from the last persisted boundary instead of resetting to Day 1.

2b③ (cleanup) stays downstream. Matchmaking/arena-pooling, DO-side leaderboard submission, and per-player progression persistence are **out of scope** (later sub-projects — see §Out of scope).

## Locked decisions (six brainstorm forks + duck revisions)

1. **Persistence granularity = durable cycle/progression state only** (Q1). The ephemeral horde (zombies/bullets/pickups/particles/decals/positions, plus the transient `hash`/`flow`/`navTick`) is **not** persisted; on thaw the current phase's spawner is re-armed without disturbing the restored clock/caches (§M-B.4). "Resume the cycle, not the exact bullet" — matches game-model §2.
2. **Write cadence = phase boundaries + last-leave + immediately after a soft-reset** (Q2). An occupied arena receives inbound WS input near-continuously, so it never hits the 70–140s idle-eviction window; the only mid-occupancy state loss is a CF platform restart (worker deploy / rare crash), which resumes from the last **phase boundary** (worst case: the current day's night/dawn opening). Delivers the resume-pointer's "eviction/restart resilience" cheaply (phases are minutes apart).
3. **Breach detection = the fortress interior is overrun** (Q3, **revised by rubber-duck**). Originally "all HOME openings' barricades at hp≤0"; the duck showed this is structurally unreachable (`sim/systems/ai.ts:332` `if (bar.hp <= 0) continue` — a downed opening drops out of collision, the horde funnels through it and stops pressuring the other three). Revised trigger: **the count of zombies inside the HOME rect (`|x| < HW && |y| < HH`, `sim/data/map.ts`) meets a threshold, sustained briefly.** Robustly captures "overrun," reachable via the funnel, and a lone straggler doesn't false-trigger. A pure helper, no new aggregate `State` field.
4. **`arenaReset` transport = phase extension, derive-first** (Q4). `SiegePhase` gains `breached` and `resetting`; both ride the existing snapshot `phase` field. The client detects the reset off the `resetting → day` phase edge (not a snapshot id-diff) and hard-clears its interpolation buffers + suppresses that frame's diff-derived fx (`effects()`), preventing a mass-kill/mass-spawn burst on the wholesale id churn. No new wire event; reuses the `siegeEdgeCue`/`resetNet` machinery. **PROTOCOL_VERSION 19→20** (the phase wire encoding changes — §M-A.3).
5. **Restore scope = communal world only** (Q5). Persist/restore `day`/`phase`/`phaseT`/`salvageBanked`/`kills`/`barricades[].hp`/`caches[].looted`. **Players are `null`-persisted** — a returning/new player spawns fresh (starter gear, money 0, wlevel reset), exactly as a drop-in joiner does today. 2b② has no account identity (CrazyGames user identity is sub-project 4), so a stranger seated at a recycled `pid` slot must not inherit anyone's run-power. Per-player restoration would additionally require persisting the roster + nonces + bodies (scope blow-up). Per-player SALVAGE/unlocks live in the client's `localStorage` meta and are unaffected.
6. **Two milestones: M-A soft-reset → M-B persistence** (Q6). M-A is pure-sim + client (feel-gateable via `dev:coop`, no DO storage plumbing); M-B is the DO-infra layer that persists the world M-A produces. A→B avoids designing the storage schema before the world shape is final.

**Core insight (validated by the duck):** the client-side arenaReset handling (buffer hard-clear + fx suppression on id churn) is needed **only for the breach soft-reset**, because that is the only reset that happens *while clients are connected*. Freeze/thaw has zero connected clients during the freeze, so the first joiner starts fresh (`prevPhase = null`, `effects()` guarded by `this.prev`) with no special handling. A crash-thaw likewise drops every client, which re-joins fresh via the 2b① reconnect loop. This cleanly separates M-A (client-visible reset) from M-B (transparent restore).

## Design

### M-A — Soft-reset state machine

The failure stake and the `breached → resetting → day1` cycle, entirely in-memory (no storage). Independently mergeable, CI-green, feel-gateable.

#### M-A.1 `SiegePhase` extension

`SiegePhase` (`sim/types.ts`): `"day" | "night"` → `"day" | "night" | "breached" | "resetting"`. `breached` and `resetting` are genuine game states (a frozen dramatic beat; a rebuild window), not ephemeral events, so they belong on `phase` and ride the snapshot like day/night.

#### M-A.2 Breach detection

A **pure predicate** `isFortressBreached(indoorCount)` (co-located in `sim/systems/siege.ts`, unit-tested) returns true when `indoorCount >= CONFIG.siege.breachZombies` — it does no mutation and does not read `State` (the `is…` name + the sim purity rule). The **caller — `sysSiege`'s `night` branch — owns the counting and the sustain**: each night tick it counts live zombies inside the HOME rect, accumulates `breachT` (a new transient `State` field: `+= dt` while `isFortressBreached(count)`, decay toward 0 below threshold), and when `breachT >= CONFIG.siege.breachSustain` it fires the breach (`sysSiege` returns `"breached"`, §M-A.3). The sustain prevents a momentary spike from firing.

- The HOME rect bound (`|x| < HW && |y| < HH`) needs the half-extents, but **`HW`/`HH` are module-private in `sim/data/map.ts`** — a M-A sub-task **exports them** (as `HW`/`HH` or a `HOME_BOUNDS` const). Do not reference them as if already exported.
- `breachT` is server-only detection state — **not snapshotted, not persisted** (like `flow`/`navTick`); initialize to 0 in `newState()`.
- Reuses existing state (`state.zombies` + the static HOME rect); **no new communal-integrity field** (extends the mechanism, no special-case debt).
- `breachZombies` + `breachSustain` are `CONFIG.siege` constants, feel-tuned (playtest items, not spec forks).

#### M-A.3 The state machine — who drives it, and the freeze

**`sysSiege` runs every tick and drives the whole clock, including the reset machine; `stepSim` gates only the *gameplay* systems while frozen.** This is cleaner than scattering `phase` gates across `sysPlayer`/`sysAI`/`sysRespawn` (none inspect `phase` today) and cleaner than a total early-return (the reset clock must still advance). `stepSim` (`sim/step.ts`):

```
stepSim(state, dt):
  if !running || paused: return null            // unchanged guard (DO never sets these)
  advance time; decay hitstop (unchanged)
  const frozen = phase === "breached" || phase === "resetting"
  if (!frozen) { sysPlayer; sysAssist; sysRespawn; sysAI; sysStalker; sysDeployables; sysBullets; sysPickups }
  return handleSiege(sysSiege(state, dt))       // sysSiege ALWAYS runs (the clock/reset driver)
```

- **The freeze sets no `state.paused`.** The invariant "the DO never globally pauses" holds — frozen phases just skip the gameplay systems while `sysSiege` advances the reset countdown. The `paused` guard stays for client/test use; the DO never trips it.
- **The reset-machine timer reuses `phaseT`** (no new field): `breached` runs for `CONFIG.siege.breachedDuration`, `resetting` for `CONFIG.siege.resettingDuration`, each counted down in its own `sysSiege` branch. `phaseT` already rides the snapshot, so the client gets the countdown for free.

**`sysSiege` gains `breached`/`resetting` branches** (its return type widens); `sysWave` stays inside the `night` branch only, so no reset phase ever spawns:

| `phase` (in) | `sysSiege` does | sets `phase`→ | returns | DO `step()` reacts |
|---|---|---|---|---|
| `day` | `phaseT -= dt`; elapse → `startNight` | `night` | `"night"` \| `null` | (unchanged: `"night"` → nothing) |
| `night` | `sysWave`; accumulate `breachT` (§M-A.2); `phaseT -= dt` | on breach: `breached` (phaseT=breachedDuration); on clock: — | `"breached"` \| `"dawn"` \| `null` | `"dawn"` → `sysDawn` (unchanged); `"breached"` → **broadcast only** (the beat begins) |
| `breached` | `phaseT -= dt`; elapse → enter resetting | `resetting` (phaseT=resettingDuration) | `null` | nothing (client sees `phase=resetting` next broadcast → clears, §M-A.4) |
| `resetting` | `phaseT -= dt`; elapse | (stays until DO rebuild) | `"reset"` | **rebuild to Day-1 + persist** (below) |

- **`"reset"` handler (DO, symmetric with the `"dawn"` handler):** `day = 1`; clear `zombies`/`bullets`/`pickups`/`particles`/`decals`; restore every `barricade.hp = boardMaxHp`; `salvageBanked = 0`; `kills = 0`; revive all players alive at the fortress (existing `revivePlayer`/HOME-spawn spread); `startDay(state)` (sets `phase="day"`, `phaseT`, restocks caches, seeds roamers); then the M-B persist write. `nextId` **keeps incrementing** (a fresh Day-1 id must not alias an id still in a connected client's interp buffer mid-clear).
- **Why `resetting` is a real (brief) phase, not instant:** the client triggers its buffer-clear on the `→ resetting` edge (§M-A.4), so `phase="resetting"` must appear in **≥1 broadcast** before the Day-1 rebuild. `resettingDuration` ≥ one broadcast interval (~33ms at `sendHz` 30) guarantees this; it doubles as a brief "rebuilding" hold. `breached` (the visible failure beat, frozen tableau) precedes it.
- Joins arriving during `breached`/`resetting` → §M-A.5.

**PROTOCOL_VERSION 19→20.** The snapshot encodes `phase` in a **single flag bit** today (`sim/snapshot.ts`: encode `snap.phase === "night" ? 4 : 0` = bit2; decode `(flags & 4) !== 0 ? "night" : "day"`). Four phase values need **two bits**: use bit2 **and** bit3 (bit3 was freed + marked reserved when 2b① removed `inShop`) as a 0–3 phase index. Encode `phaseIndex << 2`; decode `(["day","night","breached","resetting"][(flags >> 2) & 3]) ?? "day"` (the `?? "day"` satisfies `noUncheckedIndexedAccess`). Byte length is unchanged, so the bounds-check-less `Reader` (2b① §5) is unaffected; but a v19 client would misread the new phases, so the version bump + hello `v` gate cleanly reject stale clients. `phase` is touched in exactly four places — `encode`/`decode` (the change) and `captureSnapshot`/`applySnapshot` (pass-through, unchanged); `lerpSnapshots` takes `phase` from the newer snapshot, no change.

#### M-A.4 Client handling — two phase edges (derive-first)

The client (`game/net/client.ts` `onSnap`, which already computes `prevPhase → phase` and calls `siegeEdgeCue`) sees three edges, and **the entity-id churn — the DO's atomic world rebuild — happens on `resetting → day`**, because through `breached` and `resetting` the frozen tableau's entities are still present in every snapshot (the DO rebuilds only when `resetting` elapses, §M-A.3). So:

- **`night → breached`:** show the fallen-fortress cue (banner + dread audio) via `siegeEdgeCue`. **Do NOT clear the buffer** — keep interpolating the frozen tableau (downed bodies, stalled zombies) for the beat. The horror payoff.
- **`breached → resetting`:** no-op cue; keep interpolating the (still frozen) tableau. No buffer clear (no churn yet).
- **`resetting → day` (the churn frame):** run the existing **`resetNet`** (`client.ts` — reused verbatim from reconnect; clears `buf`, `prev`, `prevPhase`, ghosts, prediction/`predInit`, `lastTick`) **and skip that frame's `effects()`**. This is the frame where the whole entity set is replaced at once; nulling `prev` suppresses the diff-derived mass `fxKill`/`fxImpact`, and `prevPhase = null` suppresses a spurious `DAY` banner (so a reset never fires the normal dawn banner — the same drop-in guarantee). The day-1 snapshot becomes the new clean `prev`; `render()` early-returns on the now-empty `buf` for at most one frame (imperceptible) until the next Day-1 snapshot refills it. A pure `isArenaResetEdge(prev, next)` (= `prev === "resetting" && next === "day"`) is the tested decision core; the client wiring is a thin call over it.

- **The reset trigger is the `resetting → day` phase edge, not `day → 1`.** A breach on the **night of day 1** leaves `day` at 1→1 (no change), so a `day`-diff trigger would miss it; the phase edge is unambiguous regardless of which day the breach happened on.
- **`siegeEdgeCue` extension:** `sim/systems/siegeEdge.ts` today returns a NIGHT cue for `night` and a DAY cue for anything else (`siegeEdge.ts:16`) — so `breached`/`resetting` would wrongly fire a "DAY" banner. Add explicit branches: `breached` → fallen-fortress cue; `resetting` → no-op. Unit-tested.
- **`resetNet` is idempotent**, so the rare overlap of a breach reset with a reconnect `rebind` (which also calls `resetNet`) is harmless.

#### M-A.5 Joins during `resetting`, and meta

- A join landing in the `resetting` window: `spawnFresh` spawns the body alive at the fortress as usual, but its position/state will be overwritten by the imminent Day-1 re-seed — acceptable (they materialize into Day-1 a beat later). The draft-roll gate (`s.phase === "day"`) simply doesn't fire during `resetting`; they roll at the Day-1 dawn or on the day-phase spawn path, guarded by `draftRolledForDay` (2b① mechanism, unchanged).
- **Meta survives the reset.** SALVAGE balance + weapon unlocks are client `localStorage` (`game/meta.ts`); a soft-reset touches only the DO's run-scoped world. Run-power (wlevel/dmgMul/money) resets with the fresh Day-1 — the game-model's intended stake.
- **Leaderboard finalize at breach is out of scope** (leaderboard = sub-project 4). 2b② enters `breached` and resets; it does **not** submit a score. See §Out of scope.

**M-A feel-gate (blocking):** via `dev:coop`, deliberately let the fortress be overrun (don't defend) and confirm **(a) a breach actually fires** (the revised interior-overrun trigger is reachable), **(b) the `breached` beat reads as a horror payoff**, and **(c) the Day-1 re-seed lands with no mass-kill/mass-spawn fx burst** and no spurious banner, for both a player present through the reset and a fresh joiner. **Prerequisite:** `breachZombies` must be set at or below the interior's realistic zombie capacity so a **solo** player who stops defending can actually trigger it — estimate the HOME-rect (360×300) fill count (bounded by zombie radius + `sysAI` de-overlap) before setting the constant, or the gate is unreachable solo.

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

- **`ensureRunning()`** changes from "always seed a fresh Day-1" to: **if a saved blob was loaded, reconstruct the communal world from it; else fresh Day-1.** Reconstruct = `newState()` for structure, then overlay the blob: set `day`/`salvageBanked`/`kills`, `phase`, `phaseT`, overwrite `barricades[i].hp` and `caches[i].looted`, and **set `s.running = true`** (the `stepSim` guard requires it).
  - **Do NOT call `startDay`/`startNight` on thaw.** Both overwrite `phaseT` (`startNight` → `nightDuration(day)`, `startDay` → `dayDuration`) and `startDay` calls `restockCaches`, which resets `looted`/`searchT` to false/0 — either would **destroy the restored frozen clock and cache state** (the whole point of freeze/thaw). Instead re-arm *only* the ambient spawner without touching `phaseT`/`caches`: if the restored phase is `night`, call `startWave(state, day)` (rebuilds `state.wave`; does not touch `phaseT`); if `day`, seed roamers (the `startDay` roamer loop, extracted or inlined). The ephemeral horde is otherwise left empty and re-populates from the restored clock.
- **`stop()`** (last-leave): serialize the **live** state and `put` it **before** `this.state = null` (the current code nulls synchronously; serialize first, then null; the put is fire-and-forget). Everything else in `stop()` (clearInterval, peers.clear, metric reset) is unchanged.
- **Grace interaction (verified, safe):** while any body is `absent` in its grace window the peer entry is retained, so `peers.size !== 0` and the loop keeps running (non-hibernatable, not idle) — no eviction mid-grace since `graceMs` (20s) ≪ the 70–140s eviction floor. `stop()` (and its persist) fires only after the last grace expires and `peers.size === 0`. A crash *during* grace falls back to the last phase-boundary blob (Q2's accepted resolution).
- **Empty-arena hibernate = no extra code.** Once `stop()` clears the interval and the sockets have closed, the DO satisfies the hibernation conditions (no setInterval, no standard-WS-in-use, no in-flight I/O) → it hibernates (10s) or, failing that, evicts (70–140s); either way in-memory state is discarded and **duration billing stops**. The next `fetch` runs the constructor → `load` → reconstruct. **The Hibernation WebSocket API is deliberately not adopted** (it exists to keep *connected* clients attached during sleep; an empty arena has none — standard WS API stays).

**M-B feel/robustness gate:** with `wrangler dev`, (a) play a few days, kill+restart the worker mid-day, confirm the arena resumes at the last phase boundary (day count, barricade hp, SALVAGE watermark) rather than Day 1; (b) solo-play, leave, rejoin after the arena has frozen, confirm the day/world resumed (not reset); (c) confirm a fresh brand-new arena code still starts at Day 1. **Prerequisite:** the restart test only proves anything if `wrangler dev` **persists local storage across the restart** — confirm the local persistence dir is on (recent wrangler defaults to `.wrangler/state`; else pass `--persist-to`). Without it, storage dies with the process and the resume can't be observed. (The thaw path can additionally be exercised deterministically via the Workers Vitest integration `runInDurableObject`/`evictDurableObject`, but the loop/broadcast feel stays a wrangler-dev + browser gate, per 2a/2b① discipline.)

## Invariants preserved

- **The DO never globally pauses** — `state.paused`/`state.inShop` are never set server-side. `breached`/`resetting` freeze the sim via `stepSim`'s frozen-phase gating (the gameplay systems are skipped while `sysSiege` still advances the reset clock), not `paused`.
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
- **`breachedDuration`**: how long does the fallen-fortress beat want to be for the horror payoff without dragging? (`resettingDuration` is a separate new `CONFIG.siege` constant, floored at ~1 broadcast interval so the client reliably sees the `resetting` edge — mostly mechanical, not a feel dial.)
- **Reset recoverability:** does losing run-power (wlevel/money) to a breach feel like a fair stake or a punishment, given SALVAGE/unlocks persist?
- **Restart granularity:** is "resume at the last phase boundary" (worst case: the current day's night/dawn opening) acceptable, or does a mid-night restart snapping back to the night opening feel like lost progress? (If so, a coarse periodic `phaseT` refresh is the escalation — deferred unless the gate fails.)
- **Thaw entity re-seed:** re-seeding the phase's ambient horde on thaw (rather than restoring positions) — does a returning solo player notice the horde "resetting" its composition? (Expected fine; playtest confirm.)
- **Breach during reconnect grace:** a held-absent body present at breach is removed (no finalize); confirm no client-side artifact when that body's owner reconnects post-reset (they get a fresh Day-1 join).

## Testing

Pure/deterministic additions get co-located Vitest coverage (existing discipline):
- `isFortressBreached(indoorCount)` — the pure threshold predicate (at/over/under).
- `sysSiege` — the branch transitions and returns: `day→night`, `night→breached` (via the `breachT` accumulator over/under/flicker cases), `breached→resetting`, `resetting→"reset"`; and that `sysWave` is called **only** in the `night` branch (no reset phase spawns).
- `stepSim` — the gameplay systems are skipped while `phase` is `breached`/`resetting` (frozen), but `sysSiege` still runs; the widened return type surfaces `"breached"`/`"reset"`.
- The snapshot `phase` 2-bit encode/decode round-trip across all four values, incl. the `?? "day"` fallback (guards the M-A.3 bit change).
- `siegeEdgeCue` — `breached` cue, `resetting`/reset-edge no-op suppression.
- The `CycleBlob` serialize/deserialize round-trip (pure), including unknown-`schemaVersion` → fresh-start.

The DO's write cadence, `blockConcurrencyWhile` load/thaw, empty-freeze, and the client buffer-clear on reset are exercised via the `wrangler dev` harness + real-browser playtest (the feel/robustness gates), consistent with 2a/2b①.

## Milestone decomposition

- **M-A — Soft-reset state machine.** §M-A. `SiegePhase` extension + `PROTOCOL_VERSION 19→20`, `HW`/`HH` export + `isFortressBreached` + `breachT`, `sysSiege` breached/resetting branches + `stepSim` freeze-gating + the `"reset"` DO handler, the snapshot 2-bit phase, client two-edge handling (`resetNet` on `→resetting`) + `siegeEdgeCue` extension. In-memory only; a breach resets the live arena. **Merges without persistence — a DO restart still drops state to Day 1 (same as 2b①, no regression);** M-B adds the resilience. Blocking feel-gate: breach reachability + beat + reset coherence.
- **M-B — Persistence.** §M-B. `Arena` constructor + `ctx.storage` + `blockConcurrencyWhile` load, the `CycleBlob` KV format, the phase-boundary/last-leave writes, `ensureRunning`/`stop` freeze/thaw, empty-arena hibernate (no extra code). Robustness gate: restart-resume + freeze/rejoin-resume + fresh-arena-still-Day-1.

Ordering: M-A first (the world shape must be final before persisting it; pure-sim + client, feel-gateable standalone); M-B layers storage onto it transparently.
