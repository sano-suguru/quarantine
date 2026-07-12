# Large-Scale PvE Co-op — Game Model (Design Spec)

- **Date:** 2026-07-11
- **Sub-project:** 1 of the **CrazyGames rearchitecture epic** (the pivot that subsumed the old "C = SDK integration"). This spec is the **game-model / requirements** doc only. Downstream sub-projects (DO authoritative server, netcode scaling, CrazyGames SDK + leaderboards + ads, D = store metadata) get their own specs and derive their requirements from here.
- **Status:** Worked through brainstorming; revised after **two** rubber-duck blind-spot reviews (both grounded in the actual netcode). Pending user review before planning.

## What this is (and how we got here)

Brainstorming for "C = CrazyGames SDK integration" surfaced a much larger intent: QUARANTINE becomes a **large-scale PvE co-op** game (dozens of players in a shared arena, casual/lively "braains.io-style") with **scoring/leaderboards**. That is not an increment on the current ≤4-player co-op — it is a **rearchitecture**: the authoritative simulation moves from the **host browser** (method C: WebRTC P2P listen server, ~4-player cap) to a **Cloudflare Durable Object authoritative server**, and player count scales 4 → ~32 per arena.

**Two corrections recorded from brainstorming:**
- "braains.io" means its **large-multiplayer liveliness / casualness / drop-in**, **NOT** its PvP infection mechanic. PvP is **rejected** (Non-goals). The game stays **PvE**.
- "Darkwood" means the **audiovisual / atmosphere layer** (art, lighting, sound, dread), not its solo-quiet gameplay.

This spec defines the **experience and its requirements**; it deliberately does **not** pick implementation mechanisms (transport, snapshot format, server loop) — those are downstream sub-project decisions.

## Goal

One game that scales seamlessly from **1 to ~32 players** in a **drop-in, DO-authoritative shared arena** that advances while occupied, keeping QUARANTINE's day/night siege identity and its Darkwood-grade horror **presentation**, published on CrazyGames (their CDN hosts the files; our Cloudflare DO is the multiplayer server — CrazyGames FAQ: "CrazyGames only hosts game files; a separate solution is required for multiplayer servers").

Pillars, understood as **orthogonal layers**: **Darkwood** (audiovisual/atmosphere), **SAS3** (shooting feel, weapon growth), **braains.io** (large-multiplayer liveliness / casual drop-in), **Vampire Survivors** (casual accessibility — auto controls shipped in sub-project B, PR #50).

## The game model (confirmed decisions)

1. **Unified DO-authoritative arena — no solo/multiplayer split.** Every player, alone or in a crowd, is a **client of a Durable Object arena** that owns the authoritative sim. The current in-browser `update()` authority for single-player is **removed**; "solo" is simply *alone in an arena*. This makes "1..N seamless" literal and collapses "how does solo relate to the shared world" into one answer: *everyone is in an arena*.
   - **Accepted costs / conditions:** offline play is a **non-goal** (CrazyGames is always-online); DO compute cost is bounded by matchmaking + hibernation (below); and **solo/low-pop feel becomes the project's single biggest risk** — addressed as a numeric gate + contingency in §Solo-feel.

2. **Arena persistence = "advances while occupied."** The arena runs a **shared day/night clock that progresses only while ≥1 player is present.** When the last player leaves, the current cycle state **freezes** (to DO storage) and the DO sleeps; on rejoin it **thaws and resumes from the freeze point** — the clock does **not** advance unmanned (so no arena falls, and no leaderboard finalizes, with nobody watching). "Persistence" means *your return continues where it left off*, not *a world simulating an empty room*. Players **join/leave at any time**; **no global game-over**.

3. **Spatial: one shared large fortress, communal defense.** Day: venture out to loot caches/POIs and repair/fortify. Night: everyone falls back to the **shared fortress** and defends a **massive horde together**; barricades/fortify are **communal** (shared integrity). One cooperative focal point = the source of "liveliness," and it concentrates the horde for the server's interest management.

4. **Failure stake: the fortress can fall → soft reset** (state machine, §Lifecycle). The fortress has **communal integrity**; a night breach makes the arena **fall** and soft-reset to a fresh Day-1. **Per-player SALVAGE + weapon unlocks persist across resets.**

5. **Player target ~32 per arena — a design target, not a guarantee. MVP target 8–12** (prove DO authority + feel there first). ~32 needs interest management + DO perf tuning and may settle lower after the server spike.

6. **Death / respawn.** Dying at night → **~15–20s spectate → respawn at the fortress**, rejoining the defense (death = setback, not ejection → everyone stays on the front line). On death, **drop some carried credits/loot; SALVAGE banks.** **Opt-in rewarded ad = instant respawn** (this is where the earlier "rewarded revive" lands now that there is no game-over screen). Never forced.

## Matchmaking / arena allocation

- **Default "Play" = instant public matchmaking:** route into the **best fillable public arena** — prefer topping up an arena that already has players (liveliness + fewer DOs = lower cost) over a fresh one. *Existing asset:* the public-room registry already implements fill-first joinable selection (`net/registry.ts` `selectQuickMatch`/`isJoinable`); matchmaking is an **evolution of it**, not a greenfield build.
- **Cap** at the player target (~32; MVP 8–12). Full → next fillable arena, else create one.
- **Empty arenas hibernate** (freeze + sleep; §2).
- **Private / friends arenas:** invite links + room codes map to a specific arena (the existing room-code path, repurposed).
- **Model change to record:** this **replaces "room code = one DO" routing** (today's `idFromName`, CLAUDE.md worker section) with **a pool of arenas + a matchmaker**. Downstream server/scaling depend on this shape. *(The specific SDK calls that surface instant-join / invite are the SDK sub-project's concern.)*

## Persistent arena lifecycle & soft-reset state machine

`day ⇄ night → (integrity 0) breached → resetting → day1(new cycle)`

- **breached:** short, communal, *announced* failure beat (the horror payoff). Input frozen. **Leaderboard finalizes here** — the single unambiguous cycle-end trigger.
- **resetting:** world rebuilt for Day-1 via an **explicit `arenaReset` signal to clients to hard-clear + re-seed** (NOT inferred from a snapshot diff — the client re-derives kills/spawns from diffs in `net/client.ts` `effects()`, so a wholesale id churn would misfire as a mass-kill + mass-spawn burst). Joins during this window are **queued** into Day-1.

**Player-state × phase handling (the model must cover every cell):**

| player state | night / breached / resetting |
|---|---|
| alive inside | breach → wiped into the fall; re-seed at Day-1 fortress |
| alive outside (looting) | same rule — no inside/outside special-case; re-seed at Day-1 |
| spectating (awaiting respawn) | re-seed at Day-1 |
| dead | already banked; re-seed at Day-1 (or stays out per session) |
| **held-absent** (disconnected, body held in grace) | **at breach: finalize their leaderboard at their disconnect-night, then remove the body** — held-absent is explicitly *not* carried into Day-1 |

## Disconnect / reconnect

- **Death** banks SALVAGE + drops some carried loot.
- **Disconnect without dying:** the DO **holds the body + carried progress for a grace window** (reuse `host.ts` `absent`/`graceMs`/nonce reclaim); if unclaimed, **bank SALVAGE + remove the body** (a persistent public arena must not fill with abandoned bodies). If a **breach** happens during the grace window, the held-absent player is finalized at their disconnect-night (table above).

## Shop / economy at scale — **always-open, per-player**

The current dawn→shop is a **synchronized all-stop break** (`state.inShop` + `state.paused`, host-authoritative). That is **incoherent in a persistent drop-in arena** — someone joining mid-night, or awaiting respawn, can't be globally paused into a shop. **Decision: shop/upgrades become an always-open, per-player interaction at the fortress** (buy/upgrade any time you're at the fortress; no global pause). This preserves the economy (money/dmgMul/owned/wlevel on `state`; gear on `Player`) but removes the whole-arena stop.
- **Consequence for the SDK sub-project:** the "midgame ad at the dawn→shop break" placement assumed a global break that no longer exists; ad placement must be re-derived for the persistent loop (e.g. the per-cycle dawn moment, or the soft-reset beat).

## Density scaling & solo/low-pop preservation (playtest-critical)

A single wave curve cannot serve both solo and 32 players: today `waveDef` scales the batch by `1 + (players-1)*0.5` (→ ~16.5× at 32) but caps at `nightCapMax: 90` (`config.ts`) → 32 players face ~3 zombies each (neither "crushed by the horde" nor SAS3 "sweep"). Therefore:
- **Density target first:** choose target *zombies-per-active-player* (and a fortress-pressure level), then design the curve and make **`nightCapMax` player-count-linked** so a near-empty arena stays tense and a full one stays a wall of bodies.
- **Solo/low-pop is a first-class experience** (a solo player is *alone in an arena*), kept as tense as today's single-player. Explicit goal + **feel-first playtest gate**.
- "No mode split" holds at the **code** level (one system, one curve function); the **tuning** is population-aware — expected, not a violation.

## Solo-feel: the project's biggest risk — a numeric gate + a contingency

Unifying onto the DO means **every player pays a round-trip**; the old listen-server gave at least the host player local-zero latency, which is now gone. Prediction (`net/client.ts` `reconcile`/`smoothCorrect`/`snapTeleportThresh`) was built to hide **one** P2P hop; DO adds a **client→DO→client** hop (~1.5–2×). "Feel is a playtest gate" alone makes the whole project hinge on one unvalidated bet. So:
- **Numeric gate:** DO **co-located near its players** (edge placement), with a target **p50 RTT** budget defined as the gate's pass/fail bar (number set in the server sub-project, but the *gate exists* is a model requirement).
- **Pre-committed contingency if the gate fails at MVP** (decided now, not during a crisis, and **without** abandoning the unified model as the default): a documented fallback such as a client-side authoritative step permitted only at very low occupancy (≤1–2 players). Recording the contingency removes the single-point-of-failure; it is a risk response, not the default architecture.

## Darkwood audiovisual pillar (cross-cutting — honest tradeoff)

Darkwood is the presentation target at all player counts, and **there is a real tradeoff at scale**: 32 overlapping flashlight cones lift the gloom the horror relies on (floor↔sprite albedo gap — memory `lighting-gloom-albedo-model`); the shared particle budget (`maxParticles`, `config.ts`) thins each player's gore or saturates into soup; dread/heartbeat/groan audio can become noise. Stance: **the tradeoff exists and we hold the quality bar anyway** — every downstream sub-project must intentionally preserve the Darkwood presentation when crowded (crowd-aware lighting, coherently-layered dread audio, VFX restraint).

## Scoring / leaderboard

- **Ranked (submitted) metric = individual-closed**, to avoid arena-dependence: which arena the matchmaker chose (veterans' full fortress vs a fragile quiet one) shouldn't determine rank. **Recommended primary: a personal metric such as best survival streak / total kills** — explicitly acknowledging any night-based figure is partly arena-bound (accepted under the casual framing).
- **Communal "nights survived this arena-cycle" is a live, non-ranked readout** (shared drama, not a fairness-sensitive ranking).
- **Anti-cheat:** submit **DO server-side** via the CrazyGames Leaderboard API (client `submitScore` is spoofable), at the two finalization triggers — a player's **death** and the **breached** phase. (API detail = SDK sub-project.)

## Meta-progression (unchanged)

SALVAGE unlocks stay **per-player**, bank on death, spent between deaths at the fortress, **persist across soft-resets**. No mechanic change; `meta.ts` only gains the cloud-save seam in the SDK sub-project.

## Griefing / communal resources (public-arena minimum bar)

- **Communal fortress integrity takes damage from zombies only**, never from player friendly-fire — so nobody can wreck the shared wall from inside.
- **Loot is per-player-instanced or first-come with non-depleting restock** — no hoarding a shared pool dry.
- AFK/non-contribution is **low harm** in PvE (no direct player-vs-player interference) → light mitigation deferred.

## Requirements imposed downstream (behavior + why; solutions chosen downstream)

- **DO authoritative server (sub-project 2).** Relocate authority from a peer browser to a Durable Object. *Reusable:* the client **interpolation** transform + the predict-against-a-host shape. *New / non-trivial (do not under-scope):* **transport semantics** (today's `snap` is unreliable/unordered with latest-wins drop-stale in `client.ts`; a reliable/ordered server transport changes jitter behavior — the strategy is a downstream choice, not assumed); **headless sim extraction** (`game.ts` `update()` calls `Audio` ambience and there is no DOM/WebGL/WebAudio/Web-Worker `ticker` server-side); **reconcile retuning** for the extra hop (feel gate). Plus the lifecycle (occupied-clock, breach state machine, hibernate/thaw) and drop-in join at arbitrary sim time.
- **Netcode scaling (sub-project 3).** Reach ~32: smaller/partial snapshots + interest management. Honest sizing: `snapshot.ts` is **full-snapshots-only** and rebuilds all state each tick, so this is **close to a rewrite**, not a tweak. Budget DO CPU for a 60Hz sim of N players + large horde (`sysAI` rebuilds the spatial hash each frame) + per-client encode/send.
- **CrazyGames SDK + leaderboards + ads (sub-project 4).** SDK lifecycle, cloud-save seam, DO server-side leaderboard submission, ads on the new loop (**rewarded = instant respawn**; **midgame** placement re-derived since the global shop break is gone). SDK v3 API facts in memory `crazygames-port-roadmap`.
- **Cost (a costed input; needs an early ballpark).** A 60Hz DO sim is far more compute than today's occasional signaling. The server spike must produce a rough **$/arena-hour**, which with the matchmaker's concurrent-arena count bounds spend (same fail-closed discipline as the TURN budget cap; note DO CPU-time ≠ TURN bandwidth cost structure).

## Sequencing

1. **Game model** (this spec) → 2. **DO authoritative server** (prove authority + feel at MVP 8–12) → 3. **Netcode scaling** (→ ~32) → 4. **CrazyGames SDK + leaderboards + ads** → 5. **D: store metadata / cover / trailer** (from the stable post-4 build). Each stage: brainstorm → spec → rubber-duck → plan → SDD.

## Non-goals (rejected)

- **PvP / infection.** PvE only. (Assistant's misread of "braains.io".)
- **A separate local/offline single-player mode.** Unified onto the DO arena; offline out of scope.
- **Unmanned world simulation.** The clock advances only while occupied.
- **Discrete match-with-total-wipe sessions.** Replaced by the persistent arena + soft-reset.
- **Solving server / netcode / SDK / transport / snapshot format here.** Downstream.

## Open questions / playtest items

- **Solo/low-pop feel on a DO** — does prediction + edge co-location clear the RTT gate? The project's #1 risk (§Solo-feel).
- **Darkwood at 32×** — crowd-aware lighting/audio/VFX keeping the dread. Feel gate.
- **Density curve** — zombies-per-player target + player-count-linked `nightCapMax`; solo↔full balance.
- **Loot economy at scale** — restock cadence + per-player instancing for ~32.
- **Day exploration at scale** — map size vs interest-management range.
- **DO CPU ceiling** — ~32 may settle lower after the server spike (MVP 8–12).
- **Cost ballpark** — $/arena-hour feeding the matchmaker's concurrent-arena policy.
