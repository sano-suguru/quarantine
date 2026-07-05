# Enemy AI — Navigation & Behavior Spectrum — Design

**Date:** 2026-07-05
**Status:** Brainstormed (gradient model + technique agreed); **revised after independent (rubber-duck) review against the codebase** — Phase 1 scope grew honestly (heading-extraction refactor, percept in snapshot, noise owned here, openings as first-class nav); **pending user review**, then plan.
**Kind:** Engine/sim foundation. **Foundation 2 of 3 for the Stalker** (`2026-07-05-stalker-core-design.md`) — *and* a standalone fix for the "too-dumb crowd." Build order: light occlusion → **this** → Stalker.
**Relation to occlusion:** the occlusion spec deferred **AI-side line-of-sight** to here (render-occlusion ≠ AI-occlusion). This spec owns LOS. The two share the same wall-segment math (`geometry.ts segmentHitsSegment`), CPU-side here vs. shader-side there.

## Problem

Every zombie shares **one brain**: steer toward the nearest living player as a normalized vector, with a small shamble wobble (`ai.ts:52-79`); `resolveWalls` merely **pushes it out** of any wall each frame (`ai.ts:141,229`). There is **no pathfinding** — a zombie with a wall between it and the player walks straight into the wall and **smears/sticks**. The only variety across types is **stats** (speed / lunge / plow / wander in `enemies.ts`), never *intelligence*. The user's report — "頭悪すぎ" — is literal, and they want **a gradient of intelligence (not a smart/dumb binary)**, with **more enemy types coming**.

Zombies are also **omniscient**: they always know the nearest player, and night `autoAggro` latches permanent pursuit (`ai.ts:61`, `chasing` never reverts, `types.ts:223`). So there is **no stealth** — you cannot break line of sight to escape.

And it is the Stalker's **functional foundation**: "routes to the least-watched opening" and LOS-based lurking need navigation + line-of-sight that do not exist yet.

## Goal

Model enemy intelligence as **composable, data-driven trait axes on `EnemyType`**, producing a **continuous gradient** (not two buckets) that **scales as new types are added** — pick values, no new code. Build the shared **substrate** (navigation + perception) that both the smarter crowd **and** the Stalker ride.

## Design

### The gradient: four composable trait axes (data on `EnemyType`)

A type is a **point in a 4-axis space**; combining axis values yields the gradient. The AI system **reads the values and dispatches shared behaviors** — no per-type code branch, no special-case debt. New types = new coordinates.

| Axis | Low ⟶ High (gradient) |
|---|---|
| **Navigation** | `none` (beeline + smear = today's dumb) → `avoid` (steering whiskers: slide along walls) → `path` (flow-field: route around buildings to an opening) |
| **Perception** | `omniscient` (always knows player = today) → `sight` (senses only via LOS + hearing; loses you behind walls → goes to last-known, then searches) |
| **Positioning** | `direct` (straight at you) → `flank` (bias toward an uncovered opening / behind / cut retreat) |
| **Coordination** | `independent` → `pack` (share target, divide the approach, encircle) |

Example builds (illustrative): *Shambler* = (none, omniscient-slow, direct, independent) — deliberately dumb. *Hunter* = (path, sight, flank, independent) — clever, evadable. *Wolf pack* = (avoid, sight, flank, pack). Existing **walker/runner/brute get retrofitted** to points on the gradient (e.g. walker≈dumb, runner≈avoid+sight, brute≈path+omniscient plow).

### Shared substrate — Phase 1 (Navigation + Perception)

These two unblock the Stalker and directly fix the dumb crowd; flank/pack are Phase 2.

**Navigation — a hybrid (flow field for routing + steering for the last step)**

Review caught that a plain grid **can't represent the openings**: `map.ts` doors are **60px** (`door=30`) and HOME side-windows **80px**, so a cell-64/128 grid turns openings into wall cells and `path` types can't enter/leave buildings. Openings are the *only* way through — they must be **first-class**, not an accident of grid resolution. So:

- **Openings are explicit nav data.** Build the field's walkability from `state.walls` **and** the map's `openings` (a cell is passable if it lies on an opening even where a wall segment is near). The nav graph knows doors are doors.
- **Hybrid, so we don't bet opening-traversal on grid resolution:** a **flow field** gives the coarse route (which building face / which opening to head for), and **steering whiskers** handle the fine traversal *through* the opening. `nav:path` = field + steering; `nav:avoid` = steering only; `nav:none` = today's beeline (kept — it *is* the dumb end).
- **Anti-jam (review):** a raw per-cell (piecewise-constant) gradient + separation + wall push-back makes a 60px door a three-way oscillation/jam — the old "smear" reborn as door congestion. Mitigate: **bilinearly interpolate** the field gradient (smooth heading across cell borders), give openings a **sink/funnel** gradient, and **damp separation inside openings**. (Also: a `path` type with very low `separation` — e.g. brute's `0.15`, `enemies.ts:53` — would plug a door; retune per type.)
- **Flow field**: coarse grid, multi-source Dijkstra seeded from **all living players** (so scattered players are each approached — a single nearest-player source would let far players never be pathed to), **rebuilt every N frames / on player-cell change**, computed once and sampled by all.
- Fixes the smear/stick problem for everything above `none`.

**Noise — owned by THIS spec (positional), not a global scalar**

Review flagged a build-order **circular dependency** (the Stalker spec referenced `state.noise` but this spec, which comes first, is the first consumer) and a **regression risk** (a single global scalar loses the locality of the existing cache `lure`, `ai.ts:117-132`, which is *per-player* + radius-gated). So:

- **This spec owns noise.** Model it as **positional noise sources** (position + intensity + decay), *not* one global number — emitted by firing / running / cache-rummaging. Hearing and the existing `lure` both read the **nearest/loudest source by distance**, preserving locality and answering "whose noise?" in co-op. The Stalker (later) just reads the same sources (incl. "loudest player").
- Fold today's `lure` (`ai.ts:117`) into this so "quiet = harder to detect" is one concept across crowd, Stalker, and cache-rummage — **without** losing the current local pull.

**Perception (LOS) — the AI-side occlusion**
- **LOS** = segment player→zombie vs. `state.walls` (`geometry.ts segmentHitsSegment`, CPU) — same math as render occlusion, **including the same `t ∈ (ε,1−ε)` endpoint guard** (a zombie standing on a wall endpoint must not occlude itself — the caster-edge problem from the occlusion spec applies here too). Plus **hearing** from the noise sources above.
- `perception:sight` runs a **state machine — hunt → search → idle** that **replaces the permanent `chasing` latch**: on LOS/hearing → hunt; on losing you → store `lastSeen`, move there, then search/wander, then idle. New per-zombie fields: `lastSeenX/Y`, `searchT`, `percept`.
- **Asymmetric detection cadence (review):** entering **hunt** is *sensitive* (react fast when seen), entering **search** (declaring "lost") is *sluggish* (a grace delay) — so a pursuer doesn't snap to "lost" the instant you clip a corner, and stealth still works when you truly break LOS.
- `perception:omniscient` keeps today's always-know behavior.
- **Night interaction (revised):** *not* a binary `autoAggro` on/off. Night gives `sight` types a large **`senseMul` bump** (easily noticed) while **still LOS-gated** — so night stays high-pressure *and* you can still break line of sight to evade. This uses the existing multiplicative-modifier chain (`phaseMods`) rather than a special case. **Guard the `types.ts:223` "night always clears" invariant:** ensure evaded `sight` zombies don't idle forever eating the `nightCapMax` slot and starving new spawns — give search/idle a leash (re-acquire, drift toward players/noise, or time out) so the horde still resolves by dawn.

### Positioning & Coordination — Phase 2

- `flank`: bias the flow-field target toward an **opening not currently covered** by the player's light/facing — **shared logic with the Stalker's "least-watched opening"** (factor into one helper).
- `pack`: lightweight shared influence / target-slot spreading to encircle. Kept minimal (no full squad AI).

### How it rides the codebase (data-driven, no per-type branch)

- **`EnemyType`** gains four trait fields (`nav`, `perception`, `positioning`, `coordination`) — pure data in `enemies.ts`. Existing three types retrofitted; new types just add coordinates.
- **Prerequisite refactor (review): extract heading calc.** `ai.ts` pass 1 is a ~140-line monolith where `chasing` drives heading, `lunge` (`ai.ts:104`), and `roamMul` (0.45, `ai.ts:115`) together. Before the trait dispatch can be clean, **extract heading into `steerHeading(z, state) → {hx, hy}`** and remap the `chasing`-gated heading/speed/lunge onto the `percept` states (hunt = chase + full speed + lunge; search = move to `lastSeen`; idle = wander + roamMul). This is effectively a **pass-1 heading rewrite** — the feel-regression risk concentrates here; it is *not* the one-liner the first draft implied.
- **Dispatch, not branches.** `nav` selects a helper via a function table (`NAV_STEER[z.nav]` → field-sample / steering / beeline, uniform signature) — the same "data selects behavior" pattern as `phaseMods` (multiplicative factors) and the deployables capability-block dispatch, i.e. a dispatch table, **not** special-case debt. Pass 2 (hard de-overlap, `ai.ts:181-222`) is unchanged.
- **New modules**: host-side **flow-field** builder, **LOS/perception** helper (reusing `geometry.ts`), and the **noise-source** store.
- **`percept` IS in the snapshot (Phase 1) — not "optional" (review).** The client re-derives look/sound purely from position + cone-lit + type today: `zombieVoices` (`game.ts:286`) never reads AI state, `client.ts` fx re-derive from id/hp diffs, and `snapshot.ts:274` hard-codes restored zombies to `chasing:true`. To voice/animate **hunt vs. search** differently (the creepy searching groan vs. the discovery roar — the payoff of Perception), `percept` must be synced (2 bits × 90 ≈ nothing against the 16 KB budget). Add a `percept` field to `SnapZombie` and give client `zombieVoices`/anim a hook to read it. `lastSeenX/Y`/`searchT` stay host-only.
- **Tuning** in `CONFIG`: flow-field cadence/resolution, LOS/hearing radii + noise decay, hunt/search cadence (asymmetric), search leash/timeout, per-axis speeds.

### Purity / co-op

Unlike occlusion, **this is sim/AI, not pure render.** Only the **host** runs `update()`/AI (CLAUDE.md's three frame paths); clients interpolate snapshots and never re-simulate, so **no RNG seeding is needed** and flow-field/LOS run **host-only**. Single-player **deliberately changes** (that's the goal); the invariants are: **don't regress existing feel** (ballistics/camera/sweep), and systems stay **net-agnostic** (state + events, no net imports). Snapshot cost is ~zero (positions already synced; AI state stays host-side).

### Cost

- **Flow field**: coarse grid multi-source Dijkstra, rebuilt every N frames (bounded, amortized). Cost is driven by **grid size, not agent count** (~625 cells at 128px; computed once, sampled by all) — so the night cap (`nightCapMax: 90`, `config.ts`) barely affects it. (The first draft's "scales to ~90 cheaply" was misleading — 90 is nearly free *because* the field is shared.)
- **LOS**: per `sight` zombie × ~28 walls; **throttled/staggered** (every few frames, not all zombies every frame), with the asymmetric cadence above.
- All host-side (clients interpolate; no re-sim). Profile at the 90 cap.

## Non-goals (scope fence)

- **No navmesh / per-agent A\*.** A shared flow field + steering instead.
- **No full squad/tactical AI.** `pack` is deliberately lightweight, and Phase 2.
- **Phase 1 excludes** `flank`/`pack`.
- **No change to combat, economy, or rendering.**
- **Not pure-render** (contrast the occlusion spec): host-authoritative sim.

## Validation plan (feel-first — not done until played)

1. Do `path`/`avoid` types **visibly route around buildings** (no more smearing) while `none` types still shamble dumbly — **does the gradient read** (a believable mix), not a binary?
2. Does **smart heading survive the crowd physics** — with 90 bodies in pass-2 de-overlap (`ai.ts:181`), do clever paths still *read* as clever, or does the dogpile push override them back into a smear? (Review's caveat: pathfinding alone may not "look smart" if de-overlap/`sense` tuning dominate — tune if so.)
3. **No door congestion vibration:** `path` types funnelling through a 60px opening don't oscillate/jam (bilinear gradient + opening funnel + separation damping working).
4. Can you **break LOS behind a wall and lose a `sight` pursuer** (stealth works), including **at night**? Does "lost" fire at the right time (asymmetric cadence — not the instant you clip a corner)?
5. Does it **feel fair** — smart enemies clever, not clairvoyant; dumb enemies dumb, not broken?
6. **Co-op演出**: do clients voice/animate hunt vs. search correctly (percept synced) with no host/client mismatch, and no desync/rubber-band?
7. **Perf** holds at the 90 cap on target devices (flow-field rebuild + throttled LOS).

## Open questions

*Resolved in this revision:* multi-source field (all players) · noise owned here (positional sources) · `percept` in the Phase-1 snapshot · night = `senseMul` bump not binary `autoAggro`.

- **Flow-field grid resolution & rebuild cadence**, and the exact opening-aware walkability rule (cell-on-opening test vs. opening-aligned grid) — the hybrid reduces the risk but the walkable rule still needs pinning.
- **De-overlap / `sense` tuning as co-factors:** if smart heading still doesn't *read* through the crowd (validation #2), how much to soften pass-2 push or retune `sense`/`senseMul`.
- **Search leash design:** how evaded `sight` zombies re-acquire / drift / time out so they don't starve the `nightCapMax` slot (guarding the `types.ts:223` night-clears invariant).
- **Noise source model details:** decay curve, how firing vs. running vs. rummaging scale, and how the Stalker later reads "loudest player."
- **Retrofit values** for walker/runner/brute, and the trait points for the planned new types.
- **`flank` "least-watched opening"** — one shared helper with the Stalker, or independent?
- Do `none`-nav types still deserve a graceful wall-slide (so even "dumb" doesn't look broken), or is smearing acceptable as characterization?
