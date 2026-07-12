# DO Server 2b ① — Gameplay Loop (Design Spec)

- **Date:** 2026-07-13
- **Sub-project:** 2b ① of the CrazyGames large-PvE rearchitecture epic. 2b is decomposed into **① gameplay-loop → ② persistence → ③ cleanup**, preceded by the completed `2b-0` housekeeping slice (method-C worker corpse deletion + `deleted_classes` migration, PR #54, deployed). This spec is **①**.
- **Status:** Brainstormed (four design forks resolved with the user). Pending rubber-duck blind-spot review, then user review, then planning.
- **Upstream:** game model `docs/superpowers/specs/2026-07-11-large-pve-coop-game-model-design.md`; 2a authority relocation `docs/superpowers/specs/2026-07-12-do-server-phase2-authority-relocation-design.md`; 2b-0 `docs/superpowers/specs/2026-07-12-do-server-2b0-method-c-cleanup-design.md`.

## What this is (and where we are)

2a relocated the authoritative sim from the host browser to a Cloudflare Durable Object (`worker/arena.ts`) that runs `stepSim` on a fixed-dt `setInterval` loop and broadcasts binary snapshots; clients predict/interpolate and never run the sim. To ship 2a without the full loop, the arena was frozen into a **held night**: `ensureRunning()` seeds `heldNight = true`, `day = heldNightDay (4)`, calls `startNight`, and `sysSiege` re-arms the night clock forever (never dawns). The shop CoopEvents are received but **deferred** (`arena.ts` `onMessage`: "buy/place/deploy/draft: 2b"). Death returns `"wipe"` from `stepSim`, which the DO ignores (the sim just freezes cosmetically).

**① turns the held night into a living, cycling, drop-in arena**: real day/night on the DO (never globally pausing), a per-player non-pausing shop, death → spectate → respawn, coherent drop-in at any sim time, and relocated SALVAGE banking. It also folds in three carry-forwards the resume pointer parked on ①: arena auto-reconnect, moving `cam.shake`/`flashT` to per-viewer cues, and three stale comments.

② (persistence: occupied-clock freeze/thaw, SQLite persist, `breached → resetting → day1` soft-reset + `arenaReset` wire event, empty-arena hibernate) and ③ (cleanup) stay downstream.

## Locked decisions

From the resume pointer (not relitigated) and this brainstorm's four forks:

1. **Living day/night on the DO, never globally pausing.** Remove `heldNight`; the DO orchestrates the cycle. The invariant **"the DO never sets `state.paused`/`state.inShop`"** is preserved and strengthened — `state.inShop` is retired entirely (see §5).
2. **Per-player, non-pausing shop, day-only, at the fortress** (fork Q1 = option A). The DO applies the five shop CoopEvents (`buy`/`place`/`deploy`/`draftTake`/`draftReroll`) in `onMessage`; the shop overlay becomes client-local UI.
3. **Death → spectate → individual timed respawn at the fortress** (fork Q2 = option C), composed with the existing peer-revive and a dawn safety-net revive. **No global game-over.**
4. **SALVAGE banks at dawn, never gated on death** (fork Q3, corrected). What SALVAGE buys is unchanged. (Grounding narrowed Q3's "leave flush" to dawn-only banking — §4; flagged for review.)
5. **Meta reward stays the deliberate middle** (fork "決める"): cross-run meta = weapon *access* (variety, mild power); vertical power (upgrades/levels/muls) stays run-scoped and resets each session; leaderboard fairness is a sub-project-4 metric concern. Recorded as a game-model ratification, not an ① mechanic change.
6. **Coherent drop-in at arbitrary sim time.**
7. **Three-milestone slice: M-A living loop → M-B per-player shop → M-C resilience/cleanup** (fork Q4).

## Design

### 1. Living day/night cycle on the DO

`stepSim` already returns `"night"`/`"dawn"`/`"wipe"`/`null`; in 2a the DO ignores it. In ① the DO **acts on it**, replacing the held-night gate:

- `ensureRunning()` seeds a fresh **Day-1** arena (`startDay`), not a held night. `heldNight` is deleted from `State`, `sysSiege`, `stepSim`, `snapshot`, and `CONFIG.siege.heldNightDay`.
- `sysSiege` no longer re-arms the night clock; it returns `"dawn"` on the frame the night clock elapses (its original behavior). The DO reacts to `stepSim`'s return:
  - `"dawn"` → `state.day++`, `startDay(state)`, roll each present player's draft offer (§5), commit SALVAGE (§4), batch-revive anyone still down (§2). No pause, no global shop.
  - `"night"` → handled inside `stepSim`/`startNight` as today (stalker spawn, banner cue). The DO does nothing extra.
- **The invariant holds:** the DO never sets `paused`/`inShop`; `stepSim` returns discrete outcomes and the DO drives the world-level reactions that used to live in `game.ts` (`shopDeploy`'s `day++`/`startDay`).

The day↔night transition banners/audio remain client-derived (`siegeEdgeCue` off the synced `phase` edge — unchanged 2a mechanism). `snapshot` already carries `phase`/`day`/`phaseT`, so nothing new goes on the wire for the cycle.

### 2. Death → spectate → respawn (no game-over)

Today the sim already has: **downed** = `hp <= 0` (a spectator whose camera follows a living teammate, `cameraTarget`); **peer-revive** (`sysAssist`: an alive teammate standing near a downed body fills `assistT`, reviving in place at partial HP); **dawn auto-revive** (`revivePlayer` default path: teleport to a HOME spawn at full HP). None of these fire on the DO today because there is no dawn and `stepSim` short-circuits on wipe.

① wires a **three-tier revive** and removes the game-over path:

- **Fast tier — peer-revive (unchanged):** a teammate reaches your body → up in place quickly (`sysAssist` → `revivePlayer({inPlace, hp: maxHp*0.5})`). The social rescue; keeps your field position.
- **Fallback tier — individual timed respawn (new):** a downed player accrues a respawn timer; at `CONFIG.siege.respawnDelay` (~15–20s, feel-tuned) they respawn at the **fortress** (`revivePlayer`, non-in-place). Pulls a stranded looter home; guarantees nobody spectates for long. This is the receptacle the rewarded-ad "instant respawn" plugs into later (sub-project 4).
- **Safety-net tier — dawn revive (unchanged):** at dawn anyone still down is batch-revived at the fortress ("new day, everyone fresh"). With the timer this is rarely load-bearing but is a clean cycle reset and cheap.

**Interaction guards (grounding, rubber-duck):**
- The respawn timer is a **new `Player.downT`** counting up while `hp <= 0`, ticked inside the sim (authoritative). **`revivePlayer` must reset `downT` to 0** (it already clears `assistT`; add `downT` beside it) so peer-revive/dawn-revive don't leave a stale timer that fires on the *next* downing.
- **Dawn revive and the timer are mutually exclusive per-player:** dawn only revives players whose `downT` has *not* already fired (the timer already handled them mid-night). Prevents a redundant double-`revivePlayer`.
- **Fortress respawn coordinate collision:** `revivePlayer` and `spawnFresh` both teleport to `HOME_SPAWN.x + ((id % 4) - 1.5) * 36` — at 12 players `id % 4` overlaps (four to a spot). Widen the spread to the player cap (e.g. `id % maxPlayers`) so simultaneous respawns don't stack. (Pre-existing in `spawnFresh`; fixed here.)

**`stepSim` wipe short-circuit removed.** `!anyAlive` must **not** end the frame — critically, in `sim/step.ts` the `return "wipe"` sits *before* `sysSiege`, so today an all-down party **freezes the night clock** and dawn never comes. Removing it lets the sim keep running (the night clock advances via `sysSiege`, respawn timers tick, zombies mill) while everyone is down; each player returns on their own timer and dawn revives any stragglers. What keeps running while all-down, verified: `sysBullets` still lands in-flight rounds → `state.kills++` (harmless; `awardBounty` is a no-op when no player is alive, so no money is created/lost); `sysPickups` collects nothing (gated on alive players); `sysStalker` continues (see Open Questions — its all-down behavior is a playtest item). The `"wipe"` return value is deleted from `stepSim`'s type; `game.ts`'s `gameOver`/`clientGameOver` client-flow no longer participates (dead code, cleaned in M-C §8). The co-located `sim/step.test.ts` is updated (drop the wipe case).

### 3. Coherent drop-in at arbitrary sim time

A joiner is spawned **alive at the fortress in the current phase** (`spawnFresh` already spawns alive at HOME; it keeps doing so). Because `phase`/`day`/`phaseT` ride the snapshot, the joiner's clock is correct immediately. Coherence work:

- **No spurious transition banner on join.** The client derives siege cues from the `prevPhase → phase` edge; a fresh client starts `prevPhase = null`. `siegeEdgeCue(null, …)` must **not** fire a NIGHT/DAY banner on the first snapshot (a joiner shouldn't see "NIGHT" just because they joined at night). Verified/adjusted against `sim/systems/siegeEdge.ts` (unit-tested). The same `prevPhase = null` reset happens in `client.ts` `resetNet` on a reconnect rebind, so §6 reuses this guarantee (no banner on reconnect either).
- **Mid-day joiner gets a draft offer, without double-rolling.** Draft offers roll at dawn (§5); a player who joins after dawn missed that roll, so on spawn during `day` the DO rolls that player's offer. But a joiner arriving just *before* a dawn would then be re-rolled by the dawn pass and get a **second set of free picks** (`draftFreePicksUsed` reset). Guard with a per-player **`draftRolledForDay`** stamp: roll only if `draftRolledForDay !== state.day`; the dawn pass and the spawn pass both respect it. A night joiner gets theirs at the next dawn.
- Full arena → `roomfull` (unchanged). `maxPlayers` stays 12 for ① (the MVP 8–12 band; ~32 is sub-project 3).

### 4. SALVAGE banking relocation

Today SALVAGE is computed at `gameOver` via `salvageEarned(state.day, state.kills)`, split by `salvageShare(total, recipients)`, and each client banks its share (`addSalvage` → `localStorage`). With no game-over this trigger is gone.

**Grounding correction (rubber-duck):** an earlier draft assumed *per-player* accrual. There is no per-player kill accounting anywhere — `state.kills` is a single global counter (`bullets.ts` `state.kills++`), `salvageEarned` takes global kills, and `Player` has no kill/salvage field. Per-kill attribution would require a bullet `owner` (neither `Bullet` nor `SnapBullet` carries one) — a non-trivial change we explicitly avoid in ①. Also `state.kills` **drives the wave count as well as SALVAGE**, so it must not be repurposed.

**Model (minimal, no new per-entity state):** bank once per night, at dawn, to the players present at that dawn:

- Add **one State scalar `salvageBanked`** = the cumulative SALVAGE already handed out. On the dawn transition (after `day++`), compute `total = salvageEarned(state.day, state.kills)`, `delta = total − state.salvageBanked`, split via the **existing `salvageShare(delta, presentCount)`** among present players, send each a `banked` rel event (client calls the existing `addSalvage`), then set `state.salvageBanked = total`. Reuses the current formula and split verbatim; only the *trigger* moves from game-over to each dawn, incrementally.
- **`present` = alive-or-downed but `!absent`** (a disconnected held body doesn't earn); a respawned player *is* present, so **death does not gate the reward** — you were downed, you respawned (timer/dawn), you are present at dawn, you bank. This is the whole point of fork Q3.
- **Mid-night *departure* (leave/grace-expiry) forfeits only that night's share** — not death, an actual exit. Honoring the "flush a mid-night partial" idea from Q3 would require per-player-per-night accrual (the per-player state we just ruled out), so ① banks at the dawn beat only; a leaver simply wasn't present. **This is a deliberate simplification of Q3's "leave flush" — surfaced for review** (see Open Questions).
- The **run wallet** (`money`/SCRAP, per-player, spent in the shop) is untouched; the game-model "drop carried SCRAP on death" penalty is **deferred** (additive balance tuning, not loop-critical).
- **Wire:** `banked` is a new **rel** message (like `hello`/`gameover`), added to `NetMsg`. The DO stops sending `gameover`; `client.ts`'s `gameover`/`clientGameOver`/`endRun` path becomes dead client code (cleaned in M-C §8).
- Leaderboard DO-side submission stays **sub-project 4**; ① only relocates the local banking.

### 5. Per-player, non-pausing, day-only fortress shop

The current shop is a global, sim-pausing, full-screen modal opened at dawn (`openShop` sets `inShop`+`paused`; `shopDeploy` clears them and starts the day). Incoherent in a drop-in arena. ① makes it **per-player and non-pausing**:

- **Retire `state.inShop` (global).** Whether *my* shop overlay is open is **client-local UI state**, not authoritative and not synced. Removing it touches **five sites** (rubber-duck): the `Snapshot` interface field, `captureSnapshot`, `applySnapshot`'s assignment, the encode flag bit3, and the decode. **Bit3 is left reserved, not reused.** Because the wire byte layout changes, **bump `PROTOCOL_VERSION` (18 → 19)**: `snapshot.ts`'s `Reader` has no bounds checks, so a length mismatch decodes silently-wrong; the existing hello `v` gate (`client.ts` version check) then cleanly rejects a stale/cached client instead. `state.paused` is never set server-side (invariant) — but the `stepSim` `!state.running || state.paused` early-return guard **stays** (kept for client-side/test use; the DO just never trips it).
- **Server-side gate = phase + place, not `inShop`.** The DO applies a shop CoopEvent when it is **day** and (optionally) the player is at the fortress; the `applyBuy`/`applyDraftTake`/`applyDraftReroll`/`applyPlace` guards are rebased from `s.inShop` onto `phase === "day"` (+ fortress-radius check around `HOME_SPAWN`). Deploy of a queued item stays alive at night (placing a turret mid-siege is legitimate) — only the *purchasing* surface is day-gated; the exact split (which of place/deploy stay night-legal) is confirmed at plan time.
- **DO `onMessage` handles the five CoopEvents** (`buy`/`place`/`deploy`/`draftTake`/`draftReroll`), replacing the `arena.ts` defer, calling the existing `apply*` functions authoritatively; results propagate via the snapshot as usual (money/wlevel/draftOffer/deployables already synced).
- **Per-player dawn draft roll:** on dawn the DO calls `rollDraft` for each present player (today's per-player `draftOffer`/`draftFreePicksUsed`/`draftRerolls`/`draftTaken` fields already exist and sync). Mid-day joiners roll on spawn (§3).
- **Client UI rework:** the shop overlay opens when the local player is **at the fortress during the day** (a HUD control / interact — exact wiring under the unified auto-controls scheme decided at plan time), driven by client-local open state instead of the synced `inShop`. The sim keeps running behind it; **the body must stop moving while the overlay is open** — since the sim no longer pauses, the client must suppress *movement* input while browsing (the `game/input.ts` keyboard `Set`/touch-stick otherwise keeps driving the body). The body then stands idle at the daytime fortress. `syncShopUI` is rebased onto the local open flag; `shopDeploy`'s `day++`/`startDay` responsibility moved to the DO (§1). **Whether an idle body at the daytime fortress is actually safe (against `roamersPerDay` wanderers) is a blocking M-B feel gate, not an "accepted tradeoff"** (see Open Questions) — mitigations if it fails: keep `roamers` spawns away from the fortress, or a fortress safe-radius.

### 6. Arena auto-reconnect

The client reconnect scaffolding is present but undriven (`client.ts` `suspend`/`rebind`/`onIdentity`, the snap-starvation watchdog, `CONFIG.net.reconnect`); a mid-session drop currently returns to title, though the DO's grace-hold already lets a *fresh manual* reconnect re-attach the body within `graceMs`. ① **drives the loop over the WebSocket link** (`game/net/wsLink.ts` `createArenaLink`): on both-channels-silent, `suspend` → redial the arena URL → `rebind` replaying the persisted `{pid, nonce}` (from Hello) so the DO's `tryRejoin` re-attaches the held body in place (no respawn) within `graceMs`; past grace → fresh join. The existing `resetNet` prevents stale-buffer fx misfires on rebind. This makes the persistent arena survive a transient drop instead of ejecting to title.

### 7. `flashT` → per-viewer cue (2a carry-forward ②)

**Grounding correction (rubber-duck):** the earlier draft was wrong that `flashT` "rides the snapshot." `flashT` lives only on `State` (`types.ts`), is decayed in `stepSim`, is bumped by `sysAI` (zombie-hit global screen flash) and by the client-side stalker scare (`game.ts`), and is rendered client-side as the full-screen flash opacity (`game.ts`). **It is NOT in the snapshot.** Consequence under DO authority: `sysAI`'s server-side `flashT` bump is computed and then **discarded** (never snapshotted), so a normal zombie-hit screen flash currently doesn't reach clients at all — a latent per-viewer gap. `cam.shake` is likewise already client-only (`sysCamera` runs on the client).

So the migration is smaller than stated **and fixes that gap**: make `flashT` fully client-owned — remove it from `State`, its `stepSim` decay, and the `sysAI` bump; the client instead bumps its own `flashT` on the **local player's `hitFlash` edge** (the same diff `client.ts` `effects()` already detects for `fxHurt`/`Audio.hurt`), keeping the existing stalker-scare bump. Net: each viewer owns its screen-flash response, the authoritative frame drops a discarded field, and the zombie-hit flash actually shows for clients. `cam.shake` needs no migration (confirm at plan time). Small; stays in M-C (or folds into M-A since it touches `stepSim`/`sysAI` — plan-time call).

### 8. Stale comment triage

Fix pre-existing stale comments surfaced during 2b-0 (host-authoritative-era language) plus the ones the ① rework makes stale:

- `sim/config.ts` — net header "(host-authoritative)" / "host snapshot broadcast rate"; reconnect block "(P4)" / "host".
- `game/net/events.ts` — `roomfull` "host + 3" / "host.ts".
- `game/net/client.ts` — the reconnect comments premised on WebRTC's *two* channels ("both channels silent", `lastActivityMs`): on the single multiplexed WebSocket, snap and rel die together, so the two-value logic collapses to "WS silent" (update the comment to the wsLink reality; §6).
- `sim/engine/players.ts` — the `anyAlive` / `cameraTarget` comments that reference "game over" / "before game over" (no game-over exists after ①).
- Also fold in the `gameover`/`clientGameOver`/`endRun` client dead-code left by §4 (either delete or clearly mark inert).

## Milestone decomposition

Each milestone is independently mergeable, CI-green, and feel-gateable.

- **M-A — Living arena loop (server-side).** §1 cycle + §2 death/respawn + §3 drop-in + §4 banking. Remove `heldNight`; DO cycles day/night; three-tier revive; wipe short-circuit removed; SALVAGE banks at dawn. **Shop still deferred** (buy/draft no-op as today). The biggest/riskiest slice (respawn feel, drop-in coherence, cycle). **Feel-gate scope is deliberately narrow:** M-A gates the *loop mechanics* — cycle transitions, respawn timing, drop-in coherence, banking cadence. It does **not** gate difficulty-curve or economy feel: with the shop deferred there is no run-scoped progression, so the day-scaled night curve (`waveDef`/`nightDuration`/`nightMaxZombies`) gets punishing within a few days. Keep M-A playtests short-horizon (or cap `day` via a debug flag) and defer difficulty/economy feel to M-B.
- **M-B — Per-player shop.** §5. DO `onMessage` handlers + per-player dawn draft roll; client shop UI rebased non-pausing/day-only/fortress-gated/per-player; `state.inShop` retired. Result: the economy runs in the live arena.
- **M-C — Resilience & carry-forward polish.** §6 reconnect + §7 `cam.shake`/`flashT` → cues + §8 stale comments. Result: drop-survivability + per-viewer演出 + triage cleanup.

Ordering rationale: A is the loop foundation (shop is meaningless without a day phase); B rides on A; C is orthogonal polish that never blocks playability. Manual rejoin already works via grace-hold, so auto-reconnect can safely land last.

## Invariants preserved

- **The DO never globally pauses** — `state.paused`/`state.inShop` are never set server-side; `inShop` is removed outright. `stepSim` returns discrete outcomes; the DO drives world reactions.
- **Systems stay net-agnostic** — state + events, never importing net code.
- **Derive-first fx** — combat cues from snapshot diffs, siege transitions from the `phase` edge, no `fxEvents` on the wire for ①'s cycle/shop (the wire-event mechanism remains idle, reserved for ②'s `arenaReset`). The new `banked` event is a **rel** message (like `hello`/`gameover`), not a snapshot fxEvent.
- **`sim/` stays headless** — no DOM/WebGL/audio; enforced by `sim/tsconfig.json`.
- **Feel-first** — respawn timing, shop-at-fortress flow, day/night rhythm, and reconnect are validated by playtest, not just compilation.

## Out of scope / deferred

- **② persistence:** occupied-clock freeze/thaw, SQLite persist, `breached → resetting → day1` soft-reset + `arenaReset` wire event, empty-arena hibernate. In ① a full-arena breach clamps (integrity can deplete but triggers no reset); the arena cycles indefinitely.
- **"Drop carried SCRAP on death"** penalty (game-model §Death) — additive balance tuning.
- **Leaderboard DO-side submission** + CrazyGames SDK/ads (incl. rewarded instant-respawn) — sub-project 4.
- **Meta reward-type change** (win-connected vs cosmetic) — ratified as the current middle; any shift is a sub-project 3/4 game-model追補.
- **~32-player density scaling, interest management, delta snapshots** — sub-project 3.
- **15-second-timer tuning vs dawn-only** is resolved (timer, §2); the *value* is feel-tuned, not a spec fork.

## Open questions / playtest items

- **Respawn feel:** is ~15–20s the right spectate window solo vs in a crowd? Does fortress-respawn-into-a-live-horde feel recoverable or punishing?
- **Idle body at the daytime fortress — BLOCKING M-B feel gate:** with the sim non-pausing, is a browsing player's idle body actually safe against `roamersPerDay` wanderers? If not, apply a mitigation (roamer spawns away from fortress / safe-radius). Not to be waved through as an "accepted tradeoff" given the feel-first horror mandate.
- **Shop-at-fortress ergonomics** under unified auto-controls: open/dismiss control, and the movement-input suppression while the overlay is open.
- **Which shop actions stay night-legal** (deploy/place a pre-bought turret mid-siege) vs day-only (purchasing/drafting).
- **SALVAGE "leave flush" simplification (§4):** ① banks only at dawn, so leaving *mid-night* forfeits that night's share (death does not — a respawn keeps you present at dawn). Is dawn-only banking acceptable, or is a true mid-night flush worth the per-player-per-night accrual state it costs?
- **All-down stalker behavior:** with the wipe short-circuit gone, `sysStalker` keeps running while the whole party is down — does an untargeted stalker wandering an empty field read wrong? (New playtest item from removing the short-circuit.)
- **Reconnect under real WebSocket drops** (not just the `debugDrop` hook): does `rebind` re-attach within `graceMs` (backoff total 15s < grace 20s) cleanly, without an fx-misfire?
- **Drop-in coherence:** confirm no spurious banner/kill-burst on the first snapshot for a mid-night joiner (and on reconnect rebind).

## Testing

Pure/deterministic additions get co-located Vitest coverage (the existing discipline): the reworked `sysSiege` (dawn returns, no held-night re-arm), `stepSim` returns (wipe case dropped), the `downT` respawn-timer tick + `revivePlayer` `downT` reset, the dawn/timer mutual exclusion, the per-dawn SALVAGE increment (`salvageBanked` delta × `salvageShare`), the `draftRolledForDay` double-roll guard, the rebased shop guards (phase/fortress instead of `inShop`), and `siegeEdgeCue(null, …)` drop-in suppression. The DO's `onMessage` shop dispatch and the reconnect loop are exercised via the wrangler-dev harness + real-browser playtest (feel gates), consistent with 2a.
