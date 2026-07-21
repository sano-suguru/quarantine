# CrazyGames Arrival / Solo-Viability Model (Design Spec)

- **Date:** 2026-07-21
- **Sub-project:** The head of the CrazyGames-launch critical path. The launch work is a bundle — this spec covers the **arrival / solo-viability model** only; **SDK integration + leaderboards + ads** (sub-project 4) and **metadata/cover/trailer** (D) are downstream cycles, and **single-arena ~32 scaling** (sub-project 3, delta/interest-management) is an explicit non-goal for launch.
- **Status:** Brainstormed (arrival model + occupancy-scale axes resolved with the user, design approved). Pending rubber-duck blind-spot review, then user review, then planning.
- **Upstream:** game model `docs/superpowers/specs/2026-07-11-large-pve-coop-game-model-design.md`; DO authority `docs/superpowers/specs/2026-07-12-do-server-phase2-authority-relocation-design.md`; gameplay loop `docs/superpowers/specs/2026-07-13-do-server-2b1-gameplay-loop-design.md`; persistence `docs/superpowers/specs/2026-07-14-do-server-2b2-persistence-design.md`.

## What this is (and where we are)

The game is now a **DO-authoritative, persistent, shared-arena PvE co-op** (2a→2b①②③, deployed live at `quarantine.snsgr.workers.dev`). Every player is a WebSocket client of one always-live Arena Durable Object running the sole authoritative `stepSim`; **there is no single-player mode** — offline was made a non-goal. Mobile-forward unified auto-controls shipped (PR #50): move-only, auto aim/fire/light, touch stick, portrait HUD, 3-slot tap loadout.

The remaining blocker for a CrazyGames launch is **not more technology** — the SDK wrapper and metadata are mechanical, and 32-scaling is a post-launch growth lever. The blocker is a **feel question the architecture change created**: a CrazyGames player almost always arrives **alone, cold, for a short session**, but the game is tuned for a *party defending a fortress against a horde*. Does a lone cold arrival land in a game that feels **alive** (not a dead/empty room) and **fair** (not a 12-player horde dropped on one person)?

This spec answers that. It defines what happens the instant a CrazyGames player clicks Play, how mid-cycle arrival is made safe with **zero wait**, how overflow is handled, and how threat/reward scale with live occupancy so the same product reads as **Darkwood solo-horror at low population and SAS3 co-op mowing at high population**. Everything rides existing seams (`CONFIG`, `waveDef`, `ENEMY_TYPES`, drops, the map's multiple fortress openings, the death→respawn path) — **no special-case codepaths, no separate single-player fork.**

## Locked decisions

From the brainstorm (approved by the user):

0. **The CrazyGames build IS this DO shared co-op arena — one deploy, no separate single-player fork.** "Single-player focus" is realized as *a lone arrival being handled well*, not as a distinct build. The embed connects to the production DO worker over WebSocket (always-online; offline is out of scope). Co-op and "solo" are the same product and the same deploy.
1. **Arrival = drop straight into a shared, live, persistent arena** (braains-style). **No bot-fill.** Because the game is PvE, the content — horde / Stalker / day-night dread — is supplied by AI, so a solo arrival is a *complete solo-horror session*, not a dead room. Real players joining are a **liveliness bonus**, never a requirement to not-be-dead.
2. **Overflow = fill-then-spill pooling.** When the shared arena reaches `maxPlayers` (currently 12), route each new arrival to the **fullest not-yet-full arena**; open a new arena only when all are full. This is a **routing layer only — it does not touch netcode** and must not be conflated with single-arena 32-scaling (sub-project 3).
3. **Mid-cycle arrival is made safe by *place + grace*, not by *waiting for the clock*.** A newcomer **spawns immediately inside the fortress** (reusing the death→respawn path) with a **short spawn grace**, at any sim time. Time-to-first-interaction ≈ 0. There is **no "wait until dawn" gate.**
4. **Occupancy-linked scaling is the one non-negotiable**, and it is **real-time and day-and-night** (not locked at night start), applied to **one shared communal horde**, smoothed to absorb only large swings. It is deliberately the **genre slider**: fear lives at low population, liveliness + mowing at high population. The population-driven drop in dread is **intended, not a bug**.
5. **Scope boundary (below) is firm:** leaderboards, SDK, ads, metadata, and 32-scaling are **out of this spec.**

## Design

### 1. Arrival & routing

- **Play → shared live arena.** The default `Play` connects to a public shared arena (today: `idFromName("MAIN")` — one DO per code). Private play (friends) continues via room code / invite link, unchanged.
- **No bots.** No survivor-AI investment. If, post-launch, low-population *liveliness* (not survivability) proves too thin, cheaper signals are available (recent-player ghosts, kill-feed, "N survivors online") — but they are **out of scope here** and explicitly deferred.
- **Fill-then-spill pooling at the cap.** A lightweight matchmaker assigns each public arrival to the **fullest arena with a free slot**, so players **clump** (preserving the braains "everyone's here" feel) while no single arena exceeds `maxPlayers`. A new arena is spun up only when every existing public arena is full. This replaces single-`MAIN` routing for the *public* path; it is a routing/registry concern, **not** a change to snapshots, prediction, or the per-arena cap.
  - **Launch-minimal is acceptable.** At new-title traffic, hitting 12 concurrent in one arena is rare; the failure mode we are insuring against is "got featured → 13th player hard-bounces." A minimal fill-then-spill is the cheap insurance; a richer matchmaker is a later concern.
- **Non-goal (restated):** raising the per-arena cap or holding 32 players in one arena. That is sub-project 3 (delta/partial snapshots + interest management) and is **not required to launch**.

### 2. Safe mid-cycle arrival (zero wait)

- **Spawn immediately at the fortress interior**, using the **same path as death→respawn**, regardless of the current phase (day / night / breached-adjacent). Add a **short spawn grace** (brief invulnerability + a beat to orient).
- **Why place, not time:** implementing "safe" as "wait for the next dawn" would make a mid-night arrival wait tens of seconds before first input — fatal for a CrazyGames trial (time-to-first-interaction ≈ retention). Spawning inside the *defended* fortress is safe **spatially** (breach is defined as interior zombies, so the interior is normally clear-ish) and lets the player act instantly (shoot / repair / prep).
- **"True start" opens naturally at the next day.** The shop / loadout draft is day-only at the workbench (existing behavior); a mid-night arrival simply reaches it when day comes. No special onboarding gate is required, though a light first-time hint is allowed.
- **Playtest watch item:** a lone player inheriting a high-day, damaged-fortress communal world. Difficulty is handled by §3 (occupancy density tuned to 1); the day *number* is cosmetic. Watch that inherited state reads as "a living world" rather than "confusing."

### 3. Occupancy-linked scaling (the genre slider)

One **shared communal horde**. Threat budget is evaluated **in real time, day and night**, from **live occupancy**:

```
threat(day, count) = waveDef(day) × f(count)      // f is sublinear
```

- `f(count)` is **sublinear** — a bigger party is a little easier *per person* (the casual/co-op reward), never punishing.
- Evaluated **continuously** (not locked at night start). Live evaluation is correct and cheap: the DO already tracks occupancy, spawn budget only affects *future* spawns (so changes are inherently gradual — no mass teleport-in), and added players bring added firepower coupled to the added density. A **smoothing/EMA on the budget target** absorbs only large join/leave swings so the spawn rate never visibly jerks. `f` stays a pure function of `(day, count)`, preserving `waveDef`'s unit-testability.

Axes, all riding existing data/config (no special-case paths):

- **Count — ~linear.** More players ⇒ more zombies to mow (the satisfying direction).
- **Toughness — composition-shift primary, flat HP mild.** More players ⇒ the mix shifts from walkers toward runners/brutes (tougher *types*, via the existing `ENEMY_TYPES` roster and `waveDef` composition), with only a **gentle** flat HP/damage multiplier. Composition-shift is qualitatively more interesting than HP inflation and avoids "bullet-sponge" feel. **Balance guard:** count and toughness must not *both* scale linearly (total enemy-HP pool would grow ~quadratically and overwhelm) — count ~linear, toughness gentle.
- **Reward — scales with threat (core).** Loot / salvage / bounty scale up with occupancy so the **mow → grow-stronger** loop (the SAS3 pillar) keeps pace. Threat-up-without-reward-up would make big parties feel *punished*; this axis is what makes co-op "hard but fun."
- **Perimeter pressure (core).** Headcount progressively **opens more of the fortress's boardable openings** so attacks come from **multiple directions at once**. This is the strongest *co-op-feel* lever: it converts "camp one chokepoint with 12 guns" into "spread out and hold the whole fortress." Rides the map's existing multiple openings (`map.ts`).
- **Apex punctuation (in-scope, low priority).** Headcount-linked "elite" punctuation at a night's climax — a tougher special heavy and/or Stalker reinforcement. Lower priority than the four above, and **Stalker-careful**: the Stalker is now a flee/evade pursuer (not the differentiator), so any headcount scaling of it is added conservatively.
- **Pacing (tuning knob).** Bigger parties may get shorter inter-wave lulls. This is a tuning value, not a design decision.

**Intended genre split (design intent, not a defect):** count/toughness/reward do not serve *dread* — and dread naturally falls as population rises (safety in numbers, chatter, lights). This is the point: **occupancy is the dial between Darkwood (solo / low-pop / fear) and SAS3 + braains (high-pop / mowing / liveliness).** The three north stars self-segregate along the population axis by design.

### 4. Scope boundary (explicitly NOT in this spec)

- **Leaderboard type** (personal highest-night vs communal nights-survived) and its anti-cheat server-side submission → **sub-project 4** (SDK + leaderboards). Noted because per-player run-power resets on join today (no account identity), which will shape what is even trackable.
- **CrazyGames SDK wiring** — `init`, loading bracket, `gameplayStart/Stop`, midgame/rewarded ads, cloud save → **sub-project 4**.
- **Metadata / cover / trailer / tags / age rating** → **D** (captured from the post-SDK stable build).
- **Single-arena ~32 scaling** (delta/partial snapshots, interest management) → **sub-project 3**, post-launch, not a launch blocker.

### 5. Feel gates (feel-first — not verifiable in code, hand off to human playtest)

The core claims of this spec are **unverified feel** and must be validated by playing, not by tests passing:

1. **Solo cold arrival feels alive and fair** — a lone player lands into a populated horror scene (not a dead room) and a threat tuned to 1 (not brutal).
2. **Low-population transition (2–3 players) feels natural** — no cliff between solo and small-group.
3. **Perimeter pressure at higher headcount forces spreading** — a big party genuinely cannot camp one opening.
4. **Reward scaling keeps big parties *fun*, not punished** — the mow→grow loop paces with threat.
5. **Safe spawn + grace: no arrival instakill, time-to-first-interaction ≈ 0** — including a mid-night arrival.
6. **Genre slider holds — dread survives at low population** — the Darkwood pillar is real when alone/near-alone.

Because the occupancy scaling and safe-arrival paths are integrated into the DO sim (not a throwaway toy), the feel gate is **build-then-playtest on `dev:coop`** (solo and simulated low/high population), not a standalone prototype.

## Open questions / risks flagged for rubber-duck

- **Fill-then-spill vs "everyone meets":** aggressive spilling could split two friends who arrive seconds apart. Mitigation is "fullest-not-full first" + join-by-code, but the exact arena-selection policy (and how private/code arenas interact with the public pool) needs scrutiny.
- **Real-time density during an *in-progress designed wave*:** `waveDef` encodes a per-night composition arc; re-evaluating budget mid-wave on a headcount change must not scramble that arc. Likely an implementation detail (scale the *remaining* budget, smoothed), but confirm.
- **Inherited communal state legibility** for a cold solo arrival at high day count (§2 watch item).
- **Perimeter opening as difficulty:** opening more fortress openings for a big party also permanently weakens the fortress for the *rest of that night* — interaction with the breach/soft-reset machine needs checking.
- **Reward scaling vs the meta economy:** scaling salvage with occupancy could distort the cross-run SALVAGE bank rate; confirm it does not trivialize weapon-access meta.
