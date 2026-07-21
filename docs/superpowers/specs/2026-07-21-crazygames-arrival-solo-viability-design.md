# CrazyGames Arrival / Solo-Viability Model (Design Spec)

- **Date:** 2026-07-21
- **Sub-project:** The head of the CrazyGames-launch critical path. The launch work is a bundle — this spec covers the **arrival / solo-viability model** only; **SDK integration + leaderboards + ads** (sub-project 4) and **metadata/cover/trailer** (D) are downstream cycles, and **full single-arena ~32 scaling** (sub-project 3, delta/interest-management) is an explicit non-goal for launch.
- **Status:** Brainstormed + rubber-duck reviewed (code-grounded blind-spot pass applied). Pending user review, then planning.
- **Upstream:** game model `docs/superpowers/specs/2026-07-11-large-pve-coop-game-model-design.md`; DO authority `docs/superpowers/specs/2026-07-12-do-server-phase2-authority-relocation-design.md`; gameplay loop `docs/superpowers/specs/2026-07-13-do-server-2b1-gameplay-loop-design.md`; persistence `docs/superpowers/specs/2026-07-14-do-server-2b2-persistence-design.md`.

## What this is (and where we are)

The game is now a **DO-authoritative, persistent, shared-arena PvE co-op** (2a→2b①②③, deployed live at `quarantine.snsgr.workers.dev`). Every player is a WebSocket client of one always-live Arena Durable Object running the sole authoritative `stepSim`; **there is no single-player mode** — offline was made a non-goal. Mobile-forward unified auto-controls shipped (PR #50): move-only, auto aim/fire/light, touch stick, portrait HUD, 3-slot tap loadout.

The remaining blocker for a CrazyGames launch is **not more technology** — the SDK wrapper and metadata are mechanical, and full 32-scaling is a post-launch growth lever. The blocker is a **feel question the architecture change created**: a CrazyGames player almost always arrives **alone, cold, for a short session**, but the game is tuned for a *party defending a fortress against a horde*. Does a lone cold arrival land in a game that feels **alive** (not a dead/empty room) and **fair** (not a 12-player horde dropped on one person)?

This spec answers that. It defines what happens the instant a CrazyGames player clicks Play, how mid-cycle arrival is made safe with **zero wait**, how overflow is handled, and how threat/reward scale with live occupancy so the same product reads as **Darkwood solo-horror at low population and SAS3 co-op mowing at high population**. Everything rides existing seams — and, crucially, **the occupancy-scaling machinery already half-exists** (see below) — so this is mostly *extending* current mechanisms, with **no separate single-player fork**.

### Code baseline (verified — what already exists)

The rubber-duck pass confirmed against the code, and the design below builds on these facts rather than inventing parallel systems:

- **Occupancy scaling is already partially built.** `waveDef(n, players)` already takes a player count; `startWave` computes `players = state.players.filter(p => !p.absent).length || 1` and scales the batch by `mul = 1 + (players - 1) * waveCountPerPlayer` (`waveCountPerPlayer = 0.5`). **But it is evaluated once at night start and frozen into `state.wave.def`, and the scaling is linear, not sublinear.**
- **Concurrent zombies are capped by `nightMaxZombies(day) = nightCapBase 45 + (day-1)*5`, ceiling `nightCapMax 90` — occupancy-independent.** This cap, not `waveDef`, is what actually bounds on-screen density.
- **Breach is a fixed constant:** `isFortressBreached` compares interior (HOME-rect) zombie count directly to `breachZombies = 14`, sustained `breachSustain` — **occupancy-independent**. `resetArena` on breach resets `day = 1` and `salvageBanked = 0` for the whole shared arena (cross-run client SALVAGE meta is untouched).
- **Routing is `idFromName(code)`** — every client on a given code already shares **one** live persistent DO. There is **no** cross-DO registry/matchmaker, and each DO's population is in-memory `peers.size` only.
- **A full arena already rejects the next joiner** (`roomfull`). Per-player run-power (money/wlevel/gear) **resets on join** — arrivals always get the starter loadout (no account identity yet).
- **Salvage:** `salvageEarned(day, kills) = round(day*8 + kills*0.15)`, split `salvageShare = floor(total / recipients)`. The `day*8` term is occupancy-neutral; only the `kills` term grows with population.
- **Spawn grace / invulnerability does not exist.** `spawnFresh` spawns immediately alive at the phase's `HOME_SPAWN`.

## Locked decisions

From the brainstorm and the applied rubber-duck findings (approved by the user):

0. **The CrazyGames build IS this DO shared co-op arena — one deploy, no separate single-player fork.** "Single-player focus" = *a lone arrival handled well*, not a distinct build. The embed connects to the production DO worker over WebSocket (always-online; offline out of scope).
1. **Arrival = the existing single shared live arena (`MAIN`), braains-style. This needs ZERO new routing code — it is the current default.** No bot-fill: the game is PvE, so the content (horde / Stalker / dread) is AI-supplied and a solo arrival is a complete solo-horror session, not a dead room. Real players are a **liveliness bonus**.
2. **Overflow: keep single `MAIN`; when it is full, present a graceful "arena full — start/join another" affordance** (today the 13th joiner is silently rejected). **Real fill-then-spill pooling — which requires a new cross-DO occupancy registry (a Lobby DO) and would fracture the shared world into per-arena cycles — is deferred to a fast-follow, not launch.** Staying single-`MAIN` at launch keeps the shared-world feel intact, keeps a *communal* leaderboard definable, and avoids splitting friends. (New-title traffic rarely reaches 12 concurrent in one arena; this is the cheap, coherent choice.)
3. **Mid-cycle arrival is made safe by *place + grace*, not by *waiting for the clock*.** Spawn immediately inside the fortress at any sim time (time-to-first-interaction ≈ 0). **Spawn grace is a NEW mechanism** (there is none today) — see §2 for what it must include, because "the interior is safe" is only *partly* true (up to `breachZombies-1` = 13 zombies can be inside without a breach).
4. **Occupancy-linked scaling is the one non-negotiable**, evaluated **in real time, day and night** (converting `startWave`'s one-shot eval to continuous, EMA-smoothed), applied to **one shared communal horde**. It is deliberately the **genre slider**: fear at low population, liveliness + mowing at high population — the dread drop with population is **intended, not a bug**.
5. **Perimeter pressure REQUIRES co-scaling the breach threshold** (`breachZombies`) with occupancy — this is a **required mechanism extension**, not "rides existing openings." Without it, the co-op showcase lever induces soft-resets exactly at high population (see §3).
6. **Occupancy scaling applies to *in-run* reward only; cross-run SALVAGE meta stays occupancy-neutral** to protect the deliberate-middle weapon-access economy (see §3).
7. **A modest occupancy-linked raise of `nightMaxZombies` is IN scope**, bounded to stay within the full-only snapshot budget at `maxPlayers = 12`. Full high-cap density + delta/interest-management **32-scaling remain out of scope** (sub-project 3).

## Design

### 1. Arrival & routing

- **Play → the existing shared `MAIN` arena.** No new routing code; this is current behavior. Private play (friends) via room code / invite link is unchanged.
- **No bots.** No survivor-AI investment. If low-population *liveliness* (not survivability) later proves thin, cheaper signals (recent-player ghosts, kill-feed, "N survivors online") are candidates — **out of scope here**.
- **Overflow = graceful full-arena affordance.** When `MAIN` is full, instead of a silent `roomfull` rejection, surface a clear path (start/join another arena via code). No matchmaker, no registry.
- **Deferred (fast-follow, not launch):** true fill-then-spill pooling. It is **not** a "light routing layer" — it needs a cross-DO occupancy registry (a **Lobby DO** each Arena reports join/leave/hibernate to), and it **fractures the persistent shared world** (each arena runs an independent day/salvage cycle) and would force a *personal*-type leaderboard. Explicitly out of launch scope; revisit only if concurrency sustains past 12.
- **Non-goal:** raising the per-arena cap to hold ~32 in one arena (delta/partial snapshots + interest management) → sub-project 3.

### 2. Safe mid-cycle arrival (zero wait)

- **Spawn immediately at the fortress interior**, at any phase, so first input is instant. **The interior is not automatically safe** — up to 13 zombies can be inside without tripping the breach — so a bare "spawn alive" (today's `spawnFresh`) is insufficient.
- **Spawn grace is a new mechanism and must include:**
  1. brief **invulnerability** (new `Player` field; `sysBullets`/`sysAI` melee must respect it),
  2. **de-aggro** — nearby zombies do not target the arrival for the grace window,
  3. a **safe spawn point / short knockback** so the arrival is not placed on top of interior zombies.
- **"True start" opens naturally at the next day** (day-only workbench shop/draft, existing behavior). A light first-time hint is allowed; no wait gate.
- **Watch item — high communal-day arrival with a starter loadout.** `waveDef(day)` ramps enemy toughness/composition by day, and per-player power resets on join, so a cold arrival into a high-day `MAIN` faces day-scaled enemies with a pistol. Occupancy density scales to headcount, but the *day-based* enemy strength does not forgive a fresh player. Mitigations to consider (flag for playtest, not yet locked): a brief catch-up loadout/allowance on cold arrival, or leaning on the natural day-bound the soft-reset imposes. **This is a real newcomer-fairness gap, tracked as a feel gate.**

### 3. Occupancy-linked scaling (the genre slider)

One **shared communal horde**, extending the existing `waveDef(n, players)` / `startWave` machinery. All knobs live in `CONFIG` and existing data (`ENEMY_TYPES`, `waveDef`, drops) — no special-case paths.

**Real-time, not night-start-locked.** Convert `startWave`'s one-shot `def` computation into a **continuously re-evaluated** budget driven by live occupancy, with an **EMA on the target** so join/leave bursts (e.g. a featured spike) don't visibly jerk the spawn rate. `waveDef` stays a pure function of `(day, count)` (unit-testable); the EMA/re-eval state is new mutable `state.wave` bookkeeping. **Re-evaluate the *remaining* budget** so an in-progress designed wave's arc isn't scrambled.

**Separate the axes** (a single multiplier cannot be both "total sublinear" and "count linear" — the current `mul` is linear at 0.5):

- **Spawn budget / count — ~linear** in occupancy (more zombies to mow). Bounded by `nightMaxZombies`, which gets a **modest occupancy-linked raise** (locked decision 7) — enough that 12 players feel clearly denser than solo, but within the full-snapshot budget at `maxPlayers = 12`. Full mowing density + higher caps wait for sub-project 3.
- **Per-person difficulty — sublinear** (a bigger party is slightly easier per person: the casual/co-op reward). This is a *separate* curve from the count budget, not the same multiplier.
- **Toughness — composition-shift primary, flat HP mild.** More players ⇒ the mix shifts from walkers toward runners/brutes (via `ENEMY_TYPES` + `waveDef` composition); flat HP/damage multiplier stays gentle to avoid bullet-sponge feel. **Balance guard:** count and toughness must not both scale linearly (total enemy-HP pool would grow ~quadratically).
- **Reward — scales with threat, IN-RUN ONLY (core).** In-run loot / in-run upgrade drops / bounty scale with occupancy so the mow → grow-stronger loop keeps pace. **Cross-run SALVAGE meta is deliberately NOT occupancy-scaled** — it stays on the occupancy-neutral `day*8`-style term so a big party doesn't accumulate weapon-access meta several times faster than solo (protects the deliberate-middle economy; consistent with the meta-reward memory). This separation is a required part of the design, not a tuning detail.
- **Perimeter pressure — core, WITH a required breach-threshold co-scale.** Headcount progressively opens more of the fortress's boardable openings so attacks come from multiple directions — converting "camp one chokepoint" into "hold the whole fortress." **Because breach triggers on a fixed interior count of 14, opening more entries makes high-population arenas breach *more* easily and induces soft-resets (day→1, salvage→0) exactly where we want the party to thrive.** Therefore perimeter pressure **must** co-scale `breachZombies` with occupancy (e.g. `breachZombies = 14 + k*(count-1)`), or route perimeter pressure through a channel that doesn't feed the interior-count breach test. Either way this is a **mechanism extension of the breach system**, locked as part of this axis.
- **Apex punctuation (in-scope, low priority).** Headcount-linked elite punctuation (a tougher special heavy and/or Stalker reinforcement) at a night's climax. Lower priority; **Stalker-careful** (it is a flee/evade pursuer now, not the differentiator).
- **Pacing (tuning knob).** Bigger parties may get shorter inter-wave lulls. A tuning value, not a design decision.

**Intended genre split (design intent, not a defect):** count/toughness/reward don't serve *dread*, and dread naturally falls as population rises. That is the point — **occupancy is the dial between Darkwood (solo / low-pop / fear) and SAS3 + braains (high-pop / mowing / liveliness).** The three north stars self-segregate along the population axis.

### 4. Scope boundary (explicitly NOT in this spec)

- **Leaderboard type** (personal highest-night vs communal nights-survived) + server-side anti-cheat submission → **sub-project 4**. Note: staying single-`MAIN` (decision 2) keeps a *communal* leaderboard well-defined; real spill would force *personal* — so the arrival decision does constrain the later leaderboard design, and that constraint is now favorable.
- **CrazyGames SDK wiring** — `init`, loading bracket, `gameplayStart/Stop`, ads, cloud save → **sub-project 4**. See the ad/always-live risk in §6.
- **Metadata / cover / trailer / tags / age rating** → **D**.
- **Full single-arena ~32 scaling** (delta/partial snapshots, interest management) → **sub-project 3**. (A *modest* occupancy-linked `nightMaxZombies` raise is in scope per decision 7; the heavy bandwidth work is not.)

### 5. Feel gates (feel-first — validated by playing, not by tests)

1. **Solo cold arrival feels alive and fair** — lone player lands into a populated horror scene (not a dead room) at a threat tuned to 1. **This is the single biggest unverified bet of the spec** (see §6): with no bots and no other players, the *only* "population" solo is the horde, so "alive" rests entirely on the PvE atmosphere carrying a lone session.
2. **Low-population transition (2–3 players) feels natural** — no cliff between solo and small-group.
3. **Perimeter pressure at higher headcount forces spreading** — a big party genuinely cannot camp one opening — **and does not trigger runaway soft-resets** (validates the breach co-scale, decision 5).
4. **Reward scaling keeps big parties fun, not punished** — in-run mow→grow paces with threat, while cross-run SALVAGE accrual stays comparable to solo.
5. **Safe spawn + grace: no arrival instakill, TTFI ≈ 0**, including a mid-night arrival into a partly-occupied interior.
6. **Genre slider holds — dread survives at low population.**
7. **High-day cold arrival is not hopeless** with a starter loadout (§2 watch item).

Because occupancy scaling and safe-arrival are integrated into the DO sim (not a throwaway toy), the feel gate is **build-then-playtest on `dev:coop`** (solo and simulated low/high population).

### 6. Named launch risks (surfaced by rubber-duck; resolution may live in later sub-projects, but named here because they touch the arrival/survival model)

- **Fixed DO region (`apac-ne`, Japan) vs a global CrazyGames audience.** EU/US players see ~150–250ms+ RTT; own-player prediction + others-interpolated softens it and PvE tolerates latency better than PvP, but this **directly touches the "does a lone cold arrival feel good" core question** and is currently homeless (multi-region DO placement is a `locationHint` concern, neither sub-project 3 nor 4). Named as an **open launch-feel risk**.
- **Ads-pause vs the always-live shared DO.** CrazyGames expects `gameplayStop()` (pause + mute) around ads, but the shared persistent DO **cannot globally pause** (a promoted invariant). During a 15–30s ad the player's body stays in the arena, input-frozen, and can be killed. The arrival model introduces spawn grace; an **ad-return grace** is the analogous need and is **reserved** here for the SDK cycle (sub-project 4) to resolve.
- **No offline fallback = QA risk.** Offline is out of scope, so a worker/DO outage makes the game unplayable — CrazyGames QA disfavors this. At minimum the "couldn't reach the arena" path should read as a graceful, retrying state, not a dead end. (Implementation later; named now.)

## Open questions carried into planning

- Exact `breachZombies` occupancy curve and whether perimeter pressure feeds the interior-count test or a separate channel (decision 5 mandates one of these — planning picks which).
- The modest `nightMaxZombies` occupancy curve and its measured full-snapshot bandwidth headroom at 12 players.
- Whether cold high-day arrival needs an explicit catch-up mechanic or the soft-reset day-bound suffices (§2 watch item).
- EMA time-constant / re-eval cadence for real-time budget (tuning; playtest).
