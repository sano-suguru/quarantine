# Enemy Perception (Foundation 2b-core) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give enemies a `perception` trait — `omniscient` (always knows the player, today's behavior) vs `sight` (senses only by line-of-sight + hearing; loses you behind walls → searches last-known → gives up). This makes the night **stealth-playable**: `sight` enemies can be evaded by breaking line of sight, even at night.

**Architecture:** Host-side sim only. A per-player **noise level** (`Player.noise`, host-only, decays, bumped by firing/running/rummaging) plus a **line-of-sight** test (`segmentHitsSegment` vs walls) drive a **hunt → search → idle** state machine that replaces the permanent `chasing` latch for `sight` types. `omniscient` types keep today's behavior (incl. night `autoAggro`). **No wire-format/snapshot change** — clients don't run AI; the stealth behavior manifests through interpolated positions.

**Scope note vs the design spec (conscious split):** the design spec put `percept` in the Phase-1 snapshot (so clients can voice hunt vs. search differently). This plan is **host-side only and makes NO wire change** — client hunt/search audio/anim differentiation is deferred to **Foundation 2b-ii**. Co-op still gets the stealth *behavior* via interpolated positions; only the audio nuance waits.

**Composition with Foundation 2a (already merged):** `runner` is `nav:"path"` (2a) and becomes `perception:"sight"` (2b). The single integration point is the `chasing` local in `sysAI` pass-1, which drives the heading, the **lunge gate**, **roamMul**, AND 2a's **`NAV_STEER[z.nav]` dispatch** (`path`/`avoid` engage on `chasing`). Task 4 MUST derive `chasing` from `percept` for sight types or path-navigation silently dies (see Task 4 Step 1).

**Tech Stack:** TypeScript (strict), Bun, Vitest, Biome.

## Global Constraints

- **Host-side sim only. NO snapshot/wire-format change.** Clients don't run `sysAI`; they interpolate positions. Perception state (`percept`, `lastSeen*`, `searchT`) and per-player noise are **host-only transient** — NOT added to `captureSnapshot`/`encode`. (Client hunt-vs-search *audio/anim* differentiation is a deliberate follow-up, **Foundation 2b-ii**, which will add `percept` to the wire format then.)
- **Deliver night stealth (user-chosen):** `sight` types stay LOS/hearing-gated **even at night** — night gives them a `senseMul` bump (easier to notice) but does NOT force `autoAggro`. `omniscient` types keep night `autoAggro`. This preserves night pressure (walker stays omniscient) while making some enemies evadable.
- **Night ends by CLOCK, not extermination** (`sysSiege` returns "dawn" on `phaseT <= 0` regardless of survivors — `siege.ts`). So there is no "night won't clear" risk. The real hazard: an evaded `sight` zombie parked far away in `search`/`idle` **hogs a `nightCapMax` slot** (`sysWave` stops spawning at cap), starving new spawns near the players → **night pressure decays**. The leash (idle sight zombies drift toward players / stay re-detectable / time out) exists to prevent that pressure decay, NOT to clear the night. Also **update the `types.ts` `chasing` "never reverts → night clears" comment** — that invariant now holds only for `omniscient` types.
- **No behavior change until Task 4 assigns `sight`** — every type starts `omniscient` (today's behavior), verified green each step.
- **Fairness:** detection is **legible** — `hunt` triggers fast (sensitive), `search`→giving-up is slow (sluggish grace) so a pursuer doesn't snap to "lost" the instant you clip a corner.
- **Reuse, don't fork:** LOS uses `segmentHitsSegment` (`game/engine/geometry.ts`) — same math as the render occlusion, CPU side. This spec **owns the per-player noise concept**; the future Stalker will read it.
- Pure helpers unit-tested; AI feel playtested. Tuning in `CONFIG`. Systems net-agnostic. Commit per task; suite green before each commit.
- **Design source:** `docs/superpowers/specs/2026-07-05-enemy-ai-navigation-design.md` (Perception section).

## File Structure

- `game/types.ts` — `Perception` type; `EnemyType.perception?`; `Zombie` gains `percept`, `lastSeenX/Y`, `searchT` (host-only sim fields).
- `game/data/enemies.ts` — `perception` per type (all `"omniscient"` until Task 4).
- `game/systems/wave.ts` — init the new Zombie fields on spawn.
- `game/systems/perception.ts` (NEW) — pure helpers: `hasLineOfSight(ax,ay,bx,by,walls)`, `heard(px,py,noise,zx,zy)`; unit-tested.
- `game/systems/perception.test.ts` (NEW).
- `game/state.ts` — `playerNoise: number[]` (host-only transient, not synced).
- `game/systems/player.ts` / `game/systems/bullets.ts` — bump `playerNoise` on run/fire/rummage.
- `game/systems/ai.ts` — perception state machine for `sight` types; `omniscient` unchanged.
- `game/config.ts` — `ai.perception` tuning.

---

### Task 1: `perception` trait + host-only fields plumbing (no behavior change)

**Files:** `game/types.ts`, `game/data/enemies.ts`, `game/systems/wave.ts`, `game/net/snapshot.ts` (zombieFromSnap only — set the new required fields).

**Interfaces:**
- Produces: `type Perception = "omniscient" | "sight"`; `type Percept = "hunt" | "search" | "idle"`; `EnemyType.perception?: Perception`; `Zombie.perception: Perception`, `Zombie.percept: Percept`, `Zombie.lastSeenX: number`, `Zombie.lastSeenY: number`, `Zombie.searchT: number`.

- [ ] **Step 1: Types.** In `game/types.ts` add `export type Perception = "omniscient" | "sight";` and `export type Percept = "hunt" | "search" | "idle";`. Add `perception?: Perception` to `EnemyType`. Add to `Zombie` (behaviour-fields block): `perception: Perception; percept: Percept; lastSeenX: number; lastSeenY: number; searchT: number;`.

- [ ] **Step 2: Enemy data.** In `game/data/enemies.ts` add `perception: "omniscient",` to walker, runner, brute (all omniscient → no behavior change).

- [ ] **Step 3: Spawn init.** In `game/systems/wave.ts` `spawnZombie` push literal, add: `perception: t.perception ?? "omniscient", percept: "idle", lastSeenX: 0, lastSeenY: 0, searchT: 0,`.

- [ ] **Step 4: Snapshot type-satisfaction.** `game/net/snapshot.ts` `zombieFromSnap` builds a Zombie with all fields explicit — add the same five fields (`perception: "omniscient", percept: "idle", lastSeenX: 0, lastSeenY: 0, searchT: 0`) so `typecheck` passes. **Do NOT touch the binary encode/decode or SnapZombie** — these fields are not synced.

- [ ] **Step 5: Verify.** `cd /Users/sanosuguru/dev/quarantine && bun run typecheck && bun run lint && bun run test` → all pass (current suite count unchanged; behavior unchanged since all types are `omniscient`). Confirm the existing `snapshot.test.ts` round-trip still passes with the new `zombieFromSnap` fields.

- [ ] **Step 6: Commit.**
```bash
git add game/types.ts game/data/enemies.ts game/systems/wave.ts game/net/snapshot.ts
git commit -m "feat(ai): perception trait + host-only fields (all omniscient, no-op)"
```

---

### Task 2: Perception pure helpers (LOS + hearing) — TDD

**Files:** create `game/systems/perception.ts`, `game/systems/perception.test.ts`; modify `game/config.ts`.

**Interfaces:**
- Produces: `hasLineOfSight(ax, ay, bx, by, walls: Segment[]): boolean` (true if NO wall blocks the a→b segment); `heard(px, py, noiseRadius, zx, zy): boolean` (true if the zombie is within the player's current noise radius).

- [ ] **Step 1: Failing tests.** `game/systems/perception.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { hasLineOfSight, heard } from "./perception";
import type { Segment } from "../types";

describe("perception", () => {
  it("has LOS across open space", () => {
    expect(hasLineOfSight(0, 0, 100, 0, [])).toBe(true);
  });
  it("loses LOS through a wall", () => {
    const wall: Segment = { x1: 50, y1: -50, x2: 50, y2: 50 };
    expect(hasLineOfSight(0, 0, 100, 0, [wall])).toBe(false);
  });
  it("keeps LOS when the wall is off to the side", () => {
    const wall: Segment = { x1: 50, y1: 40, x2: 50, y2: 90 };
    expect(hasLineOfSight(0, 0, 100, 0, [wall])).toBe(true);
  });
  it("hears within the noise radius, not beyond", () => {
    expect(heard(0, 0, 120, 100, 0)).toBe(true);
    expect(heard(0, 0, 120, 200, 0)).toBe(false);
  });
  it("hearing is LOS-independent (heard through a wall)", () => {
    // heard() takes no walls: noise carries through walls by design (that's the point of hearing).
    expect(heard(0, 0, 150, 100, 0)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — fail** (`bun run test perception`).

- [ ] **Step 3: Implement `game/systems/perception.ts`.**
```ts
import { segmentHitsSegment } from "../engine/geometry";
import type { Segment } from "../types";

/** True if no wall blocks the straight segment a→b. */
export function hasLineOfSight(ax: number, ay: number, bx: number, by: number, walls: Segment[]): boolean {
  for (const w of walls) {
    if (segmentHitsSegment(ax, ay, bx, by, w.x1, w.y1, w.x2, w.y2)) return false;
  }
  return true;
}

/** True if the zombie is within a player's current noise radius (hearing, LOS-independent). */
export function heard(px: number, py: number, noiseRadius: number, zx: number, zy: number): boolean {
  const dx = zx - px;
  const dy = zy - py;
  return dx * dx + dy * dy <= noiseRadius * noiseRadius;
}
```
(Confirm `segmentHitsSegment`'s real signature in `geometry.ts` — the bullet-vs-wall code uses it as `(ax,ay,bx,by, x1,y1,x2,y2)`, returns true on intersection incl. collinear-touch.)

**Endpoint self-occlusion note:** `segmentHitsSegment` reports collinear-touch as a hit, so a zombie or player sitting exactly on a wall endpoint could read as "no LOS" against its own wall. In practice both are kept off walls by `resolveWalls`, so this is rare and self-corrects next frame; if playtest shows flicker, nudge the sampled endpoints a hair toward each other before the test. Not worth a guard up front — note it and move on.

- [ ] **Step 4: Run — pass.**

- [ ] **Step 5: Config.** `game/config.ts` `ai.perception`: `{ baseHearing: 60, nightSenseMul: 3, searchTime: 4, searchArriveDist: 40, losEveryFrames: 4, loseGraceMs: 700 }` (tune later; `loseGraceMs` = the sluggish hunt→search grace).

- [ ] **Step 6: Verify + commit.**
```bash
bun run typecheck && bun run lint && bun run test
git add game/systems/perception.ts game/systems/perception.test.ts game/config.ts
git commit -m "feat(ai): perception LOS + hearing pure helpers (TDD)"
```

---

### Task 3: Per-player noise on `Player` (host-only) — bump on fire/run/rummage

**Files:** `game/types.ts` (Player field), `game/engine/players.ts` (init in `makePlayer`), `game/systems/player.ts` (decay + run/rummage bumps + fire bump), `game/config.ts`.

**Interfaces:**
- Produces: `Player.noise: number` — host-only transient (like `searching`/`curMoveMul`; **NOT synced** — do not add to `SnapPlayer`/encode). Hearing radius for a player = `baseHearing + p.noise`.

- [ ] **Step 1: Player field.** In `game/types.ts` add `noise: number` to `Player` with a comment: "host-only transient hearing loudness (fire/run/rummage); NOT synced." In `game/engine/players.ts` `makePlayer`, init `noise: 0`. *(Putting it on `Player` — not a `state.playerNoise[]` array — is deliberate: the review showed `removePlayer` uses swap-and-pop, so an index-keyed array would misattribute noise after a co-op leave. Per-player fields on `Player` survive join/leave/down/revive automatically, matching the `searching` precedent.)*

- [ ] **Step 2: Decay + bumps.** In `sysPlayer` (per living player, per frame): decay `p.noise` toward 0 (`p.noise *= CONFIG.ai.perception.noise.decay`, or linear). Bump `p.noise` (clamped to `max`) when the player **fires** (add `noise.fire`, scaled by weapon loudness if a profile exists, else flat — do it where firing resolves, `player.ts` fire path), **runs/moves** (add `noise.run * (speedFraction)` while moving), and **rummages** (`p.searching` → add `noise.rummage`). Add CONFIG `ai.perception.noise`: `{ fire: 260, run: 70, rummage: 200, decay: 0.92, max: 400 }`.
  - **Tech-debt note (log it):** the existing cache `lure` (`ai.ts:187`) already reacts to night rummaging and is left as-is here (unifying it onto `p.noise` risks regressing its local pull). This leaves rummage noise double-sourced (lure + `p.noise`) — a known follow-up toward the spec's single noise model, flagged for the Stalker phase.

- [ ] **Step 3: Verify + commit.**
```bash
bun run typecheck && bun run lint && bun run test
git add game/types.ts game/engine/players.ts game/systems/player.ts game/config.ts
git commit -m "feat(ai): per-player host-only noise on Player (fire/run/rummage)"
```

---

### Task 4: Perception state machine in sysAI + assign `sight` + playtest

**Files:** `game/systems/ai.ts`, `game/data/enemies.ts` (assign), `game/config.ts` (tune).

**Interfaces:** consumes `hasLineOfSight`, `heard`, `state.playerNoise`, the trait fields.

- [ ] **Step 1: Detection + state machine for `sight` types.** In `sysAI` pass-1, branch on `z.perception`. **`omniscient` → the exact current code path (`z.chasing` latch untouched).** For `sight`:
  - **Detection scans ALL living players** (not just nearest — a teammate in the open should be seen even if the nearest player is behind a wall). Throttle the LOS/hearing check to every `losEveryFrames` using the existing `state.navTick` counter, id-staggered: run detection when `(state.navTick + z.id) % losEveryFrames === 0` (else keep last frame's `percept`). A player is **detected** if `dist ≤ z.sense * senseMul * (night ? nightSenseMul : 1)` AND `hasLineOfSight(z.x,z.y, p.x,p.y, state.walls)`, OR `heard(p.x, p.y, CONFIG.ai.perception.baseHearing + p.noise, z.x, z.y)`. Track the detected player for `lastSeen`/target.
  - **hunt** (sensitive): any player detected → `percept="hunt"`, `lastSeenX/Y = that player`, `searchT=0`.
  - **hunt→search** (sluggish): if none detected while hunting, only flip to `search` after a lose-grace (e.g. keep hunting for `loseGraceMs`), so clipping a corner doesn't drop the hunt.
  - **search**: steer toward `lastSeen`; `searchT += dt`; when within `searchArriveDist` OR `searchT > searchTime` → `idle`. Detected again → `hunt`.
  - **idle**: wander (today's non-chasing behavior), plus the **leash** (drift slowly toward the nearest player so it doesn't hog a `nightCapMax` slot far away, and stays re-detectable) — this protects night *pressure*, not the clock.
  - **THE INTEGRATION LINE (do not omit — see Composition note):** derive the `chasing` local that the rest of pass-1 consumes:
    ```ts
    const chasing = z.perception === "sight"
      ? (z.percept === "hunt" || z.percept === "search")
      : (z.chasing && target !== null); // omniscient: unchanged
    ```
    This `chasing` MUST flow into the existing heading, the **lunge gate**, **roamMul**, and **`NAV_STEER[z.nav]`** exactly as today — so a `sight`+`path` runner's flow-field pathing, lunge, and roam all engage while hunting/searching and stop when idle. For `sight` types set the movement `target` (and `dx/dy`) toward `lastSeen` during hunt/search.
- [ ] **Step 2: `omniscient` unchanged.** Guard so all existing (omniscient) types run the identical current code path — no regression. Verify walker/runner/brute (still omniscient here) behave exactly as before.
- [ ] **Step 3: Assign `sight`.** In `game/data/enemies.ts`, set `runner: perception "sight"` (the evadable hunter) and keep `walker`/`brute` `omniscient` (walker = night swarm pressure; brute = relentless). Starting point.
- [ ] **Step 4: Verify.** `bun run typecheck && bun run lint && bun run test` → green.
- [ ] **Step 5: Playtest feel-gate (human).** In `bun run dev`:
  1. A `sight` runner **loses you when you break line of sight** (duck behind a building) and goes to your last-known spot, then wanders/gives up — **and this works at night** (night stealth).
  2. It **hears** you when you fire/run/rummage nearby even without LOS (fair, not clairvoyant, not deaf).
  3. `hunt` triggers **fast** on sighting; `search`→give-up is **slow** (no instant "lost" when you clip a corner).
  4. `omniscient` walkers still **swarm** at night — night pressure intact; the horde still **clears by dawn** (no `sight` zombies parked forever).
  5. No regression to existing chase/sweep feel. Suite green.
  Any "no" → tune `CONFIG.ai.perception` (hot-reload) or fix.
- [ ] **Step 6: Commit.**
```bash
git add game/systems/ai.ts game/data/enemies.ts game/config.ts
git commit -m "feat(ai): sight perception state machine + assign runner sight"
```

---

## Self-Review

**Spec coverage (Perception substrate, host-side):** `perception` trait + hunt/search/idle replacing `chasing` for `sight` (Tasks 1,4) ✓; LOS via `segmentHitsSegment` (Task 2) ✓; hearing via per-player noise from fire/run/rummage (Tasks 2,3) ✓; night = `senseMul` bump not `autoAggro`-off, `sight` evadable at night (Task 4) ✓; night-clear invariant leash (Task 4 idle drift) ✓; asymmetric hunt/search cadence (Task 4) ✓; LOS throttle + id-stagger (Task 4) ✓; no-behavior-change until assign (Tasks 1–3 omniscient) ✓; pure helpers unit-tested, feel playtested (Tasks 2, 4) ✓. **Deferred (Foundation 2b-ii): `percept` in the snapshot wire format + client hunt/search audio/anim differentiation** — this plan is host-side only, no wire change, so co-op gets the stealth *behavior* (via interpolated positions) minus the audio nuance.

**Post-review corrections applied (rubber-duck):** (1) the `chasing` local is now explicitly derived from `percept` for sight types (Task 4 Step 1 "integration line") so 2a's `NAV_STEER.path`/lunge/roamMul don't silently die on a sight+path runner; (2) noise moved from `state.playerNoise[]` to **`Player.noise`** (swap-and-pop `removePlayer` would misattribute an index-keyed array); (3) night-clear framing corrected — night ends by clock (`siege.ts`), so the leash guards night *pressure* (cap-slot hogging), not the clock, and the `types.ts` never-reverts comment gets updated to omniscient-only; (4) detection scans ALL living players; (5) LOS throttle uses `state.navTick` (id-staggered); (6) percept-sync/client-audio consciously split to 2b-ii (spec had it in Phase 1); (7) LOS endpoint self-occlusion noted; (8) lure/`p.noise` rummage double-source logged as tech-debt.

**Placeholder scan:** all code concrete; CONFIG values are starting points flagged for playtest tuning; test-count assertions relaxed to "current suite".

**Type/name consistency:** `Perception`, `Percept`, `perception`, `percept`, `lastSeenX/Y`, `searchT`, `hasLineOfSight`, `heard`, `Player.noise`, `CONFIG.ai.perception`, `state.navTick` used consistently. `segmentHitsSegment(ax,ay,bx,by,x1,y1,x2,y2) => boolean` confirmed by review against `geometry.ts`.
