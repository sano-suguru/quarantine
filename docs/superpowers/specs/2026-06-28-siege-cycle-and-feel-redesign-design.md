# Siege Cycle & Feel Redesign — Design

Date: 2026-06-28
Status: Draft for review

## Overview

Four pieces of player feedback, addressed together because they share the day/night
seam and must be felt as one cycle:

1. **#1 — "Deploy" wording is overloaded.** One word (`Deploy`) is reused for *start
   game*, *advance to next day*, and *place a barricade*, plus `Deploy raid` in co-op.
   Split into distinct, theme-appropriate verbs.
2. **#2 — Blood pools look flat.** A single uniform circle, red-channel-only color
   variation, unused `rot`. Make pools layered, irregular, and directional.
3. **#3 — Day vs night should feel different.** Today the AI only changes one thing at
   night (auto-aggro). Make day zombies sluggish and short-sighted, night zombies
   genuinely ferocious.
4. **#4 — The cycle should run on a clock, not on clearing the horde.** Replace
   "press Enter to summon night" + "kill every zombie to reach dawn" with a continuous
   in-game clock: day prep is time-pressured, dusk falls automatically, and **dawn
   arrives by time even if enemies remain**. Night spawns continuously so the standing
   crowd grows — running only delays the inevitable; the dawn clock is the only relief.

The non-negotiable: **no band-aid branches.** Every change rides existing seams —
`phaseT`, `sysSiege`, the wave system, the AI multiplier chain, `CONFIG`, and data
tables — or generalizes them. Feel changes (#2/#3/#4) are **not done until playtested**.

## Guiding decision: the clock is the backbone

`#4` reshapes the loop; `#1` (Enter removal) and `#3` (night ferocity tuning) hang off
it. So `#4` is designed first and the others slot in.

### Current loop (for reference)

- `startDay()` sets `phase="day"`, `phaseT = CONFIG.siege.dayDuration` (35s).
- `sysSiege()` day branch: `phaseT -= dt`; at `<=0` → `startNight()`, return `"night"`.
- `startNight()` sets `phase="night"`, `startWave(state, day)` builds a **finite roster**
  (`waveDef(n).spawn`). `sysSiege()` night branch returns `sysWave(...)`; `sysWave`
  drains the queue in batches, then once `queue empty && zombies==0` → `"cleared"` →
  `sysSiege` returns `"dawn"` → `openShop()`.
- Enter (`main.ts:244`) → `startNightNow()` brings night early; in co-op a client sends
  the `nightStart` reliable event (`client.ts:252` → `host.ts:105`).
- Ambient light is a hard two-value toggle: `dayAmbient 0.45` / `nightAmbient 0.04`
  selected by `phase` (`game.ts:307,382`).
- HUD `#phase`: `DAY n · DUSK IN Xs` / `NIGHT n`; `#remaining` shows
  `zombies + queue` at night.

### Target loop

**Both phases are timed and symmetric.** Night gets a duration; `sysSiege`'s night
branch counts down `phaseT` exactly like the day branch and returns `"dawn"` at `<=0`,
regardless of how many zombies remain. The wave system becomes a **continuous spawner**
that runs until dawn instead of a finite roster that ends the night when cleared.

```
sysSiege(day):   phaseT -= dt; if <=0 -> startNight();  return "night"
sysSiege(night): sysWave(dt) // keeps spawning, never ends the phase
                 phaseT -= dt; if <=0 -> return "dawn"
```

This is mechanism extension, not a special case: the day branch already does timed
countdown; we make the night branch do the same and demote `sysWave` from
"phase terminator" to "pressure generator."

## Work area #4 — Clock-driven day/night cycle

### Config (data-driven tuning, all in `CONFIG.siege`)

- `dayDuration` — keep (rename intent: "daylight hours"), tune for prep pressure.
- `nightDuration` — **new.** Seconds of night. Scales with day number so later nights
  are longer holds (e.g. `base + day * perDay`, clamped). Tunable.
- Keep `dayAmbient`/`nightAmbient`; **add** `duskFrac`/`dawnFrac` (fraction of each
  phase over which the ambient gradient crossfades) so sunset/sunrise read on screen.

### Wave system: finite roster → continuous spawner

`waveDef(n)` is reframed from "the night's full roster" to "the night's **spawn rate and
composition**." Instead of returning a fixed `spawn: string[]` that drains to empty:

- Return a steady-state spec: a spawn `interval` (or rate), a **composition** (weights
  of walker/runner/brute that ramp across the night — more runners/brutes late), plus
  the existing `hpScale`/`spdScale`. The day-number difficulty curve is preserved by
  scaling rate and composition with `n` (and squad size via `waveCountPerPlayer`, kept).
- `startWave`/`sysWave` keep emitting batches on cadence **until the phase timer ends**.
  The crowd accumulates because spawn continues while the player can't clear it — this is
  precisely the "run away and you eventually get cornered" pressure the feedback asks for.
- `sysWave` no longer returns `"cleared"`; the night ends only on the `sysSiege` timer.
  The `WaveDefinition` type and `wave` runtime state change shape accordingly.

> **Anti-exploit note (accepted trade-off):** time-based dawn theoretically lets a player
> kite until morning. Continuous accumulating spawn + a player who is only modestly faster
> than walkers (200 vs 60) but near runner speed (130) under heavy weapons makes sustained
> kiting collapse on its own. No special anti-kite code — the spawn model handles it.

### Ambient light follows the clock

Replace the two-value `phase` toggle at `game.ts:307` and `game.ts:382` with a single
helper `ambientForClock(state)` that returns ambient as a function of `phase`+`phaseT`:
flat `dayAmbient` through daylight, a sunset ramp down over `duskFrac` of late day, flat
`nightAmbient` through the night, a predawn lift over `dawnFrac`. Generalizes the toggle
into a curve; both call sites use the helper. Keeps the flashlight model untouched.

### HUD: countdown → clock

- `#phase` (`game.ts:833-839`) shows an **in-game time of day** mapped from
  `phase`+`phaseT`/duration (e.g. `DAY 2 · 16:40` heading to dusk, `NIGHT 2 · 02:10`
  heading to `06:00` dawn) rather than `DUSK IN Xs` / `NIGHT n`.
- Add a small **day/night dial** (DOM/CSS in `index.html`, since the HUD is vanilla DOM):
  a sun/moon arc or ring filling toward dawn — the "これくらいで夜明け" read.
- `#remaining` (`game.ts:848`) no longer represents progress (you don't clear the night).
  Repurpose to a plain live threat count or drop it in favor of the clock. **Decision:
  keep it as an ambient "contacts" count, not progress.**

### Remove "summon night early"

- `main.ts:244` Enter→`startNightNow` binding: removed.
- `index.html:414` controls hint `Enter start night early`: removed.
- `startNightNow()` in `game.ts`: the day→night transition is now automatic, so the
  manual entry point is deleted along with its co-op plumbing.

### Co-op

- Day→night and night→dawn are host-authoritative via `sysSiege` (host-only `update()`),
  already correct. Removing manual night means removing the `nightStart` path:
  `events.ts:16` (`CoopEvent` variant), `client.ts:252` (`requestNight`/send),
  `host.ts:105-106` (handler). **Bump `NET` protocol version** (`net.ts`) — wire change.
- **Clients must render the clock**, so `phase` and `phaseT` must be in the snapshot.
  *Implementation must verify* `captureSnapshot`/`applySnapshot` carry `phaseT` (and
  `phase`); add them if absent. Without this the client clock is wrong. (Not a band-aid:
  the clock is shared run state and belongs in the snapshot like `day`/`phase`.)

## Work area #3 — Sluggish day, ferocious night (data-driven AI)

Add a **phase modifier table** (in `src/data/enemies.ts`, beside `ENEMY_TYPES`, so it's
data not system logic):

```
PHASE_MODS = {
  day:   { speedMul: 0.6, senseMul: 0.45, lunge: false, wanderMul: >1, autoAggro: false },
  night: { speedMul: 1.0(+curve by day), senseMul: 1.0+, lunge: true, autoAggro: true },
}
```

`sysAI` already computes `const night = state.phase === "night"`. It applies the table as
**factors in the existing chains**, not new branches:

- Speed: `spd = z.speed * phaseMod.speedMul * emerge * roamMul * lungeMul * (1+lureMul)`
  — one extra factor in the existing product (`ai.ts` ~line 128).
- Sense: aggro test becomes `dist <= z.sense * phaseMod.senseMul` (`ai.ts` ~line 60);
  the existing `night || ...` auto-aggro latch is driven by `phaseMod.autoAggro`.
- Lunge gated by `phaseMod.lunge`; wander scaled by `wanderMul`.

Result — **day:** shamblers you can out-walk and slip past while looting (player 200 vs
day-walker ~36); **night:** the current behavior or stronger (speed at/above base, wide
sense, lunge active, latched aggro). Night ferocity is intentionally **not capped** for
survivability — survivability comes from the dawn clock + barricades + positioning, per
the feedback. Tunable per day via the night curve.

## Work area #2 — Blood pool quality (data-driven, new `CONFIG.fx.blood`)

Introduce `CONFIG.fx.blood` so tuning lives in config, not `fx.ts` constants:
blob counts, base/satellite radius ranges, center vs edge color, `maxAlpha`,
splatter bias strength, satellite spread.

`bloodPool()` (`fx.ts:191`) changes from one circle to a **cluster**:

- 1 base blob + N satellites (config-driven count). Center color darker
  (lower R, toward `[0.12..0.18, ...]`), edges the current brighter red — layered depth.
- **Use the currently-unused direction:** `fxKill`/`fxImpact`/`fxHurt` already know the
  hit/knockback vector; pass it to `bloodPool` and bias satellite offsets along it to form
  a splatter tail (and set `rot` so it's no longer dead data).
- Raise fresh-pool `maxAlpha` (0.5 → ~0.6) for a wetter look on impact (`game.ts:408-410`
  draw stays, alpha cap from config).
- `MAX_DECALS` (`fx.ts:6`): a pool now costs several decals; move the cap to config and
  raise modestly so pools don't churn the FIFO too fast.
- **Optional, default OFF, playtest-gated:** a short-lived faint wet sheen on fresh blood.
  Risk: under the night flashlight an additive glow reads as a light source. Only enable
  if it looks right in a dark playtest.

## Work area #1 — Rename "Deploy" (theme-appropriate, distinct verbs)

Pure UI strings (`index.html`), no logic change beyond the Enter-hint removal in #4:

| Location | id / line | Now | New |
|---|---|---|---|
| Title start | `startBtn` 425 | Deploy | **ENTER THE QUARANTINE** |
| Shop → next day | `deployBtn` 439 | Deploy | **FACE THE DAY** |
| Place barricade (Q) | `deploybar` 375 | Deploy [Q] | **FORTIFY [Q]** |
| Co-op start | `lobby-deploy` 501 | Deploy raid | **START RAID** |
| Arsenal hint | 437 | "…then deploy" | "…then face the day" |
| Controls hint | 414 | "Q deploy" / "Enter start night early" | "Q fortify" / (Enter line removed) |
| CSS comment | 158 | "(Deploy)" | update text |

Names are easily adjustable; these are the proposed set.

## Affected files (summary)

- `src/config.ts` — `siege.nightDuration`, `siege.duskFrac/dawnFrac`, `fx.blood` block.
- `src/systems/siege.ts` — symmetric timed night branch; `startNight` sets `phaseT`.
- `src/systems/wave.ts` — continuous spawner; `sysWave` no longer returns "cleared".
- `src/data/waves.ts` — `waveDef` returns rate/composition spec (curve preserved).
- `src/data/enemies.ts` — `PHASE_MODS` table.
- `src/systems/ai.ts` — apply `PHASE_MODS` as factors (speed/sense/lunge/wander/aggro).
- `src/systems/fx.ts` — multi-blob directional `bloodPool`; config-driven.
- `src/game.ts` — `ambientForClock` helper (2 call sites), clock HUD in `updateHUD`,
  remove `startNightNow`, `sysSiege` dawn handling already calls `openShop`.
- `src/types.ts` — `WaveDefinition`/`wave` runtime shape; snapshot fields if needed.
- `src/net/{events,client,host,net,snapshot}.ts` — remove `nightStart`, bump protocol,
  ensure `phase`/`phaseT` in snapshot.
- `index.html` — rename strings, add day/night dial, remove Enter hint.
- Tests: `src/data/waves.test.ts` updated to the new `waveDef` shape; add tests for the
  clock→time mapping and `ambientForClock` if extracted as pure helpers.

## Testing & verification

- **Unit (pure only, per project scope):** new/updated `waveDef`, `ambientForClock`,
  clock-time mapping, `PHASE_MODS` application if pure-extractable. `bun run test`.
- **Gates:** `bun run typecheck`, `bun run lint`, `bun run build`.
- **Playtest (required — feel changes are not done until felt):**
  - Day: zombies are clearly slow/oblivious; looting feels viable but time-pressured by
    the clock; dusk falls on its own.
  - Night: clearly more dangerous than today; spawn keeps coming; standing crowd grows;
    kiting collapses over time; dawn arrives by clock and *feels* like relief.
  - Clock/dial readable; sunset/sunrise ambient gradient reads on screen.
  - Blood: pools look layered/directional, not flat discs; no flashlight confusion at night.
  - Co-op smoke test: clock synced on client; no `nightStart` regressions; SP unaffected.

## Decomposition / suggested order

1. **#1 strings** (low risk) — except the Enter-hint line, which lands with #4.
2. **#4 clock cycle** (backbone): config, symmetric `sysSiege`, continuous wave,
   `ambientForClock`, clock HUD, Enter/`nightStart` removal, co-op snapshot/protocol.
3. **#3 AI phase mods** — tuned *with* #4 (night length × ferocity is one feel).
4. **#2 blood** — independent; can land anytime.

#3 and #4 should be playtested together since "survive until dawn" depends on both.

## Accepted trade-offs

- Time-based dawn enables theoretical kiting; the continuous accumulating spawn model
  makes it self-defeating, so no dedicated anti-kite code is added.
- Night ferocity is uncapped; survivability is a function of night length + defenses,
  not weakened enemies.
