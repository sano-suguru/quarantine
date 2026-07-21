# Occupancy Real-Time Density Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shared arena's threat and in-run reward track *live* occupancy in real time (day and night), so the same product reads as solo-horror at low population and co-op mowing at high population — tuned so a lone cold arrival is fair and a big party is dense-but-not-punished, and so the co-op showcase never induces a soft-reset.

**Architecture:** Extend the *existing* occupancy machinery (`waveDef(n, players)` / `startWave`, which today scales the batch linearly but is evaluated once at night start) into a continuously re-evaluated, EMA-smoothed budget driven by the live non-absent player count. Separate the *count* axis (~linear spawn budget) from the *per-person difficulty* axis (sublinear via a gentle toughness/composition shift). Make the concurrent-zombie cap and the breach threshold occupancy-linked (the breach co-scale is mandatory — without it, opening the horde for a big party trips the fixed 14-zombie breach and soft-resets the world). Scale in-run bounty with occupancy while leaving the cross-run SALVAGE meta occupancy-neutral. All changes live in `sim/` (headless, unit-testable); numeric values are first-pass and **locked by playtest on `dev:coop`**, not by tests.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Bun, Vitest. Pure `sim/` module (no DOM/WebGL/audio; `lib: ES2022`, `types: []`).

## Global Constraints

- **`sim/` is a pure headless closure** — no DOM, WebGL, or audio imports. Enforced by `sim/tsconfig.json`; a stray import fails `bun run typecheck` + CI.
- **Data-driven, no special-case paths** — all new tuning lives in `CONFIG` (`sim/config.ts`) and rides existing data (`waveDef`, `ENEMY_TYPES`, bounty). Do not carve one-off branches.
- **Only pure/deterministic code is unit-tested.** New pure functions (`liveCount`, `waveDef`, `nightMaxZombies`, `isFortressBreached`, `scaledBounty`) get co-located `*.test.ts`. The *feel* (density curves, EMA constant, cap/breach coefficients) is validated by playtest, not tests. Initial values in this plan are starting points.
- **No wire/protocol change.** `state.wave.effCount` is server-only transient (like `breachT`/`flow`) — NOT snapshotted, NOT persisted. `PROTOCOL_VERSION` is untouched.
- **Cross-run SALVAGE meta stays occupancy-neutral** — `salvageEarned`/`salvageShare` are NOT modified by this plan (decision 6). Only in-run `bounty` scales with occupancy.
- **`maxPlayers = 12`** — occupancy curves are bounded so the concurrent-zombie cap stays within the full-only snapshot budget at 12 players. Full 32-scaling (delta/interest-management) is out of scope.
- **Commit after every task.** Pre-commit runs `biome check --write` on staged files; pre-push runs `typecheck` + `test`.

## File Structure

- **`sim/config.ts`** (modify) — add occupancy tuning knobs under `econ` (bounty scale, tough-shift) and `siege` (cap-per-player + ceiling, breach-per-player), plus a `wave` EMA rate. One block, verbatim values below.
- **`sim/systems/wave.ts`** (modify) — export `liveCount(state)`; `startWave` seeds `state.wave.effCount`; `sysWave` EMA-updates `effCount` and re-derives `def` each tick from it.
- **`sim/data/waves.ts`** (modify) + **`sim/data/waves.test.ts`** (modify) — `waveDef(n, players)` adds an occupancy-linked composition shift (toward runner/brute) and a gentle sublinear toughness bump, keeping batch ~linear.
- **`sim/systems/siege.ts`** (modify) + **`sim/systems/siege.test.ts`** (create) — `nightMaxZombies(day, players)` modest occupancy raise under a ceiling; `isFortressBreached(indoorCount, players)` occupancy-linked threshold; `sysSiege` passes `liveCount(state)` to both.
- **`sim/systems/economy.ts`** (modify) + **`sim/systems/economy.test.ts`** (create) — `scaledBounty(base, players)` pure helper; `killZombie` (`sim/systems/bullets.ts`) applies it.
- **`sim/types.ts`** (modify) — add `effCount: number` to the `Wave` interface.

---

### Task 1: `liveCount` helper + `effCount` field

Extract the "non-absent player count, floored at 1" currently inlined in `startWave`, and add the EMA state field it will feed.

**Files:**
- Modify: `sim/systems/wave.ts` (export `liveCount`; use it in `startWave`)
- Modify: `sim/types.ts` (add `effCount` to `Wave`)
- Test: `sim/systems/wave.test.ts` (create)

**Interfaces:**
- Produces: `liveCount(state: State): number` — non-absent player count, min 1.
- Produces: `Wave.effCount: number` — EMA-smoothed effective player count (server-only transient).

- [ ] **Step 1: Write the failing test**

Create `sim/systems/wave.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { newState } from "../state";
import { addPlayer } from "../engine/players";
import { liveCount } from "./wave";

describe("liveCount", () => {
  it("is 1 for a single player", () => {
    const s = newState();
    expect(liveCount(s)).toBe(1);
  });

  it("counts non-absent players and floors at 1", () => {
    const s = newState();
    addPlayer(s, 1, 0, 0);
    addPlayer(s, 2, 0, 0);
    expect(liveCount(s)).toBe(3); // newState seeds player 0 + 2 added
    const p = s.players.find((pl) => pl.id === 2);
    if (p) p.absent = true;
    expect(liveCount(s)).toBe(2); // absent excluded
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- sim/systems/wave.test.ts`
Expected: FAIL — `liveCount` is not exported.

(Confirm `newState()` seeds exactly one player and `addPlayer(state, id)` exists in `sim/engine/players.ts`; if `newState` seeds zero players, adjust the first assertion to add one player first. Read `sim/engine/players.ts` and `sim/state.ts` before writing the implementation.)

- [ ] **Step 3: Implement `liveCount` and use it in `startWave`; add `effCount`**

In `sim/systems/wave.ts`, add near the top (after imports):

```typescript
/** Non-absent player count, floored at 1 (single-player = 1). The occupancy input for
 *  every occupancy-linked curve (wave batch/toughness, night cap, breach threshold). */
export function liveCount(state: State): number {
  return state.players.filter((p) => !p.absent).length || 1;
}
```

Replace `startWave`'s body:

```typescript
export function startWave(state: State, n: number): void {
  const players = liveCount(state);
  state.wave = { n, def: waveDef(n, players), spawnT: 0, effCount: players };
}
```

In `sim/types.ts`, add to the `Wave` interface (after `spawnT`):

```typescript
interface Wave {
  n: number;
  def: WaveDefinition | null;
  spawnT: number;
  /** EMA-smoothed effective non-absent player count; drives real-time density re-eval.
   *  Server-only transient — NOT snapshotted, NOT persisted (like breachT/flow). */
  effCount: number;
}
```

Add `effCount` to every `Wave` object literal. There are two shapes: the `state.wave = { … }` assignment in `startWave` (done above), and the `wave: { n: 0, def: null, spawnT: 0 }` literal inside `newState` (`sim/state.ts` ~line 92) — grepping `state.wave = {` will MISS the `newState` one, so rely on `bun run typecheck`: because `Wave.effCount` is non-optional, the compiler flags every literal missing it. Add `effCount: 1` to the `newState` literal.

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `bun run test -- sim/systems/wave.test.ts` → PASS
Run: `bun run typecheck` → no errors

- [ ] **Step 5: Commit**

```bash
git add sim/systems/wave.ts sim/systems/wave.test.ts sim/types.ts sim/state.ts
git commit -m "feat(density): liveCount helper + wave.effCount EMA field"
```

---

### Task 2: Occupancy config knobs

Add all occupancy tuning in one `CONFIG` block so no magic numbers live in systems.

**Files:**
- Modify: `sim/config.ts`

**Interfaces:**
- Produces: `CONFIG.econ.bountyPerPlayer`, `CONFIG.econ.toughPerPlayer`, `CONFIG.siege.nightCapPerPlayer`, `CONFIG.siege.nightCapPlayerMax`, `CONFIG.siege.breachPerPlayer`, `CONFIG.wave.effCountEase`.

- [ ] **Step 1: Add the knobs**

In `sim/config.ts`, inside `econ` (after `waveCountPerPlayer`):

```typescript
    // in-run bounty scales with squad size so per-head earnings keep pace with the scaled
    // threat (sublinear vs waveCountPerPlayer → a big party earns a little less per head).
    // Cross-run SALVAGE meta is deliberately NOT scaled (stays occupancy-neutral).
    bountyPerPlayer: 0.35,
    // per-extra-player shift of the night composition toward tougher types (runner/brute) +
    // a gentle flat hp bump — the TOUGHNESS / threat-TEXTURE axis (individuals get a bit
    // harder), NOT the per-person easing. Per-person load actually EASES via the nightMaxZombies
    // cap growing sublinearly vs headcount (85 zombies / 12p ≈ 7-per-head vs 45 solo). ⚠ Coupling:
    // raising nightCapPlayerMax weakens that cap-driven easing and lets this toughness surface as
    // harder-per-person — tune the two together. sqrt(extra) keeps the texture bump sublinear.
    toughPerPlayer: 0.12,
```

Inside `siege` (after `nightCapMax`):

```typescript
    // modest occupancy raise of the concurrent-zombie cap: more players → a denser floor,
    // bounded by nightCapPlayerMax so the crowd stays within the full-only snapshot budget at
    // maxPlayers=12. Full high-cap density + 32-scaling (delta snapshots) is out of scope.
    nightCapPerPlayer: 6, // extra concurrent zombies per player beyond the first
    nightCapPlayerMax: 40, // ceiling on the occupancy contribution to the cap
    // breach threshold MUST scale with occupancy: opening the horde for a big party would
    // otherwise trip the fixed interior count and soft-reset the world exactly at high pop.
    breachPerPlayer: 3, // interior-zombie breach threshold gains this per player beyond the first
```

Inside `net`? No — add a new top-level `wave` block after `input` (before `feel`):

```typescript
  wave: {
    // real-time density: effCount eases toward the live non-absent count at this rate (per sec)
    // so a join/leave burst ramps the spawn budget smoothly instead of jerking. Playtest-tuned.
    effCountEase: 0.5,
  },
```

- [ ] **Step 2: Verify typecheck**

Run: `bun run typecheck`
Expected: no errors (config is data; consumers added in later tasks).

- [ ] **Step 3: Commit**

```bash
git add sim/config.ts
git commit -m "feat(density): occupancy tuning knobs (bounty/tough/cap/breach/ema)"
```

---

### Task 3: `waveDef` occupancy composition shift + sublinear toughness

Extend `waveDef(n, players)` so more players shift the composition toward runner/brute and add a gentle sublinear hp/speed bump, while the batch stays ~linear (unchanged formula).

**Files:**
- Modify: `sim/data/waves.ts`
- Test: `sim/data/waves.test.ts`

**Interfaces:**
- Consumes: `CONFIG.econ.waveCountPerPlayer` (existing batch slope), `CONFIG.econ.toughPerPlayer` (Task 2).
- Produces: `waveDef(n: number, players = 1): WaveDefinition` — same shape; weights/hpScale/spdScale now occupancy-aware, batch unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `sim/data/waves.test.ts` (keep existing tests — the day-only behavior at `players=1` must still hold):

```typescript
  it("shifts composition toward tougher types with squad size", () => {
    // at players=1 the day-only weights are unchanged (regression guard)
    expect(weight(waveDef(4, 1), "runner")).toBeCloseTo(4.8, 5); // (4-1)*1.6
    // more players raises runner/brute weight relative to walker
    const solo = waveDef(4, 1);
    const party = waveDef(4, 6);
    const soloRunnerFrac = weight(solo, "runner") / weight(solo, "walker");
    const partyRunnerFrac = weight(party, "runner") / weight(party, "walker");
    expect(partyRunnerFrac).toBeGreaterThan(soloRunnerFrac);
  });

  it("adds a gentle sublinear hp/speed bump with squad size", () => {
    const solo = waveDef(10, 1);
    const party = waveDef(10, 6);
    expect(party.hpScale).toBeGreaterThan(solo.hpScale);
    expect(party.spdScale).toBeGreaterThanOrEqual(solo.spdScale);
    // sublinear: the 6-player bump is less than 5× a single-step bump (not linear in players)
    const perStep = waveDef(10, 2).hpScale - solo.hpScale;
    expect(party.hpScale - solo.hpScale).toBeLessThan(perStep * 5);
  });

  it("leaves batch scaling linear (unchanged)", () => {
    expect(waveDef(1, 3).batch).toBe(2); // round(1 * (1 + 2*0.5)) — regression guard
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test -- sim/data/waves.test.ts`
Expected: FAIL — new composition/toughness assertions fail (behavior not yet added).

- [ ] **Step 3: Implement the occupancy shift**

Replace `sim/data/waves.ts` `waveDef` body:

```typescript
export function waveDef(n: number, players = 1): WaveDefinition {
  const extra = Math.max(0, Math.max(1, players) - 1); // players beyond the first
  const mul = 1 + extra * CONFIG.econ.waveCountPerPlayer; // batch: ~linear (the mowing axis)
  // toughness/texture: sublinear via sqrt(extra). This makes INDIVIDUALS a bit tougher (harder),
  // NOT the per-person easing — per-person load eases via the sublinear nightMaxZombies cap.
  const tough = 1 + Math.sqrt(extra) * CONFIG.econ.toughPerPlayer;
  const weights: { type: string; w: number }[] = [{ type: "walker", w: 6 + n * 2.4 }];
  // composition shift: runner/brute weights rise with `tough`, walker stays flat → the mix
  // tilts toward tougher types as the party grows (qualitative, not just hp inflation).
  if (n >= 2) weights.push({ type: "runner", w: (n - 1) * 1.6 * tough });
  if (n >= 4) weights.push({ type: "brute", w: Math.floor(n / 3) * tough });
  const batch = Math.max(1, Math.round((1 + Math.floor(n / 3)) * mul));
  const interval = Math.max(0.45, 1.3 - n * 0.04);
  const hpScale = (1 + n * 0.1) * tough; // gentle flat bump layered on the day curve
  const spdScale = 1 + n * 0.015; // speed stays day-driven (sublinear tough on hp only)
  return { weights, batch, interval, hpScale, spdScale };
}
```

(Note: the existing `players=1` tests still pass — `extra=0` → `tough=1`, so weights/hp/spd are unchanged. The `spdScale` party test uses `toBeGreaterThanOrEqual` to allow the deliberate no-change.)

- [ ] **Step 4: Run tests to verify pass**

Run: `bun run test -- sim/data/waves.test.ts` → PASS (old + new)

- [ ] **Step 5: Commit**

```bash
git add sim/data/waves.ts sim/data/waves.test.ts
git commit -m "feat(density): waveDef occupancy composition shift + sublinear toughness"
```

---

### Task 4: Real-time density re-eval (EMA) in `sysWave`

Make the wave budget track live occupancy each tick (EMA-smoothed), instead of frozen at night start.

**Files:**
- Modify: `sim/systems/wave.ts`
- Test: `sim/systems/wave.test.ts`

**Interfaces:**
- Consumes: `liveCount` (Task 1), `waveDef` (Task 3), `CONFIG.wave.effCountEase` (Task 2), `Wave.effCount` (Task 1).
- Produces: `sysWave(state, dt, cap)` re-derives `state.wave.def` from the EMA'd `effCount` each tick.

- [ ] **Step 1: Write the failing test**

Add to `sim/systems/wave.test.ts`:

```typescript
import { CONFIG } from "../config";
import { sysWave } from "./wave";
import { startWave } from "./wave";

describe("sysWave real-time density", () => {
  it("eases effCount toward live occupancy and re-derives the def", () => {
    const s = newState();
    startWave(s, 5);
    const batch0 = s.wave.def?.batch ?? 0;
    // three more players join mid-night
    addPlayer(s, 1, 0, 0);
    addPlayer(s, 2, 0, 0);
    addPlayer(s, 3, 0, 0);
    // advance several ticks; effCount should ease up (not jump) toward 4
    for (let i = 0; i < 120; i++) sysWave(s, 1 / 60, 999);
    expect(s.wave.effCount).toBeGreaterThan(1);
    expect(s.wave.effCount).toBeLessThanOrEqual(4);
    expect(s.wave.def?.batch ?? 0).toBeGreaterThan(batch0); // denser budget as the party grew
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- sim/systems/wave.test.ts`
Expected: FAIL — `effCount` stays at its seeded value; `def.batch` unchanged.

- [ ] **Step 3: Implement the EMA re-eval**

In `sim/systems/wave.ts`, replace `sysWave`:

```typescript
export function sysWave(state: State, dt: number, cap: number): void {
  // real-time density: ease effCount toward the live count, then re-derive the def so the
  // budget tracks who's actually here (day+night joins/leaves), smoothed against bursts.
  const target = liveCount(state);
  const k = Math.min(1, CONFIG.wave.effCountEase * dt);
  state.wave.effCount += (target - state.wave.effCount) * k;
  state.wave.def = waveDef(state.wave.n, Math.round(state.wave.effCount));
  const def = state.wave.def;
  if (!def) return;
  if (state.zombies.length >= cap) return;
  state.wave.spawnT -= dt;
  if (state.wave.spawnT <= 0) {
    const batch = Math.min(def.batch, cap - state.zombies.length);
    for (let i = 0; i < batch; i++)
      spawnZombie(state, pickWeighted(def.weights), def.hpScale, def.spdScale);
    state.wave.spawnT = def.interval;
  }
}
```

(`waveDef` is pure and cheap; re-deriving per tick is fine. `Math.round(effCount)` keeps the def stepping through integer player counts so `waveDef`'s integer-indexed composition stays well-defined; the EMA on `effCount` is what smooths the transition.)

- [ ] **Step 4: Run test to verify pass**

Run: `bun run test -- sim/systems/wave.test.ts` → PASS

**Caution — existing siege.test.ts interaction:** the existing `sysSiege` breach test sets `state.wave.def = null` to "disable the spawner". The new `sysWave` re-arms `def` every tick, so spawns resume — but they land on the off-screen spawn-ring (`spawnZombie` places outside HOME), never inside the interior, so `indoor` count and `breachT` accumulation are unaffected and the test still passes. When you touch that test in Tasks 5/6, update its comment to reflect that the spawner can no longer be disabled by nulling `def` (it re-arms), and that the test relies on ring-placement not reaching the interior. Do not assert on `state.zombies.length` in that test.

- [ ] **Step 5: Commit**

```bash
git add sim/systems/wave.ts sim/systems/wave.test.ts
git commit -m "feat(density): real-time EMA re-eval of the wave budget from live occupancy"
```

---

### Task 5: Occupancy-linked night cap

Raise the concurrent-zombie cap modestly with occupancy, bounded by a ceiling that keeps the crowd within the full-snapshot budget at 12 players.

**Files:**
- Modify: `sim/systems/siege.ts`
- Test: `sim/systems/siege.test.ts` (**MODIFY — this file already EXISTS with ~308 lines of core siege regression tests. Do NOT recreate/overwrite it. APPEND a new, distinctly-named describe block. Recreating it would silently delete the existing suite and still go green.**)

**Interfaces:**
- Consumes: `CONFIG.siege.nightCapPerPlayer`, `nightCapPlayerMax`, `nightCapMax` (existing ceiling).
- Produces: `nightMaxZombies(day: number, players = 1): number`.

- [ ] **Step 1: Write the failing test**

Open the EXISTING `sim/systems/siege.test.ts`. It already has a `describe("nightMaxZombies", …)` block whose tests call `nightMaxZombies(day)` with ONE arg — those stay valid (the new signature defaults `players = 1`, backward-compatible). Reuse the file's existing imports (add `CONFIG` from `../config` and `nightMaxZombies` from `./siege` to the import list only if not already imported). **Append a NEW block with a distinct name** so it does not collide with the existing one:

```typescript
describe("nightMaxZombies — occupancy", () => {
  it("is the day-only value for a single player (regression)", () => {
    expect(nightMaxZombies(1, 1)).toBe(CONFIG.siege.nightCapBase); // 45
    expect(nightMaxZombies(5, 1)).toBe(CONFIG.siege.nightCapBase + 4 * CONFIG.siege.nightCapPerDay);
  });

  it("raises the cap with squad size, bounded by nightCapPlayerMax", () => {
    expect(nightMaxZombies(1, 4)).toBe(45 + 3 * CONFIG.siege.nightCapPerPlayer);
    // the occupancy contribution is clamped
    const big = nightMaxZombies(1, 12);
    expect(big - 45).toBeLessThanOrEqual(CONFIG.siege.nightCapPlayerMax);
  });

  it("never exceeds the hard ceiling nightCapMax", () => {
    expect(nightMaxZombies(30, 12)).toBeLessThanOrEqual(CONFIG.siege.nightCapMax);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- sim/systems/siege.test.ts`
Expected: FAIL — `nightMaxZombies` takes one arg; the 2-arg calls mis-scale.

- [ ] **Step 3: Implement the occupancy cap**

In `sim/systems/siege.ts`, replace `nightMaxZombies`:

```typescript
/** Living-zombie cap during the night: day-scaled, plus a modest occupancy raise (bounded by
 *  nightCapPlayerMax so the crowd stays within the full-snapshot budget at maxPlayers), all
 *  under the hard perf/snapshot ceiling nightCapMax. */
export function nightMaxZombies(day: number, players = 1): number {
  const s = CONFIG.siege;
  const dayCap = s.nightCapBase + (day - 1) * s.nightCapPerDay;
  const occ = Math.min(s.nightCapPlayerMax, Math.max(0, players - 1) * s.nightCapPerPlayer);
  return Math.min(s.nightCapMax, dayCap + occ);
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `bun run test -- sim/systems/siege.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add sim/systems/siege.ts sim/systems/siege.test.ts
git commit -m "feat(density): occupancy-linked night cap (bounded, under the hard ceiling)"
```

---

### Task 6: Occupancy-linked breach threshold (mandatory co-scale)

Scale the interior-overrun breach threshold with occupancy so opening the horde for a big party does not trip the fixed 14-zombie breach and soft-reset the world.

**Files:**
- Modify: `sim/systems/siege.ts` (`isFortressBreached` + its caller in `sysSiege`)
- Test: `sim/systems/siege.test.ts`

**Interfaces:**
- Consumes: `CONFIG.siege.breachZombies` (base), `breachPerPlayer` (Task 2), `liveCount` (Task 1).
- Produces: `isFortressBreached(indoorCount: number, players = 1): boolean`.

- [ ] **Step 1: Write the failing test**

Append to the EXISTING `sim/systems/siege.test.ts` (add `isFortressBreached` to the `./siege` import if not already present). The file already has an `isFortressBreached` block with 1-arg calls — those stay valid (default `players = 1`). **Append a NEW distinctly-named block:**

```typescript
describe("isFortressBreached — occupancy", () => {
  it("uses the base threshold for a single player (regression)", () => {
    expect(isFortressBreached(CONFIG.siege.breachZombies - 1, 1)).toBe(false);
    expect(isFortressBreached(CONFIG.siege.breachZombies, 1)).toBe(true); // 14
  });

  it("raises the threshold with squad size (a big party is not more fragile)", () => {
    const players = 6;
    const raised = CONFIG.siege.breachZombies + (players - 1) * CONFIG.siege.breachPerPlayer;
    expect(isFortressBreached(CONFIG.siege.breachZombies, players)).toBe(false); // 14 no longer breaches
    expect(isFortressBreached(raised - 1, players)).toBe(false);
    expect(isFortressBreached(raised, players)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- sim/systems/siege.test.ts`
Expected: FAIL — `isFortressBreached` ignores `players`.

- [ ] **Step 3: Implement the occupancy threshold + wire the caller**

In `sim/systems/siege.ts`, replace `isFortressBreached`:

```typescript
/** Overrun test: the interior holds at least the occupancy-scaled threshold. Pure — the caller
 *  counts the interior zombies and passes the live player count. Scaling with players is
 *  MANDATORY: without it, opening the horde for a big party trips the fixed count and soft-
 *  resets the world exactly where the party should be thriving. */
export function isFortressBreached(indoorCount: number, players = 1): boolean {
  const s = CONFIG.siege;
  const threshold = s.breachZombies + Math.max(0, players - 1) * s.breachPerPlayer;
  return indoorCount >= threshold;
}
```

Add the import at the top of `sim/systems/siege.ts` (it already imports from `./wave`):

```typescript
import { liveCount, spawnZombie, startWave, sysWave } from "./wave";
```

In `sysSiege`, update the breach check call (currently `isFortressBreached(indoor)`) and pass the live count to `sysWave`'s cap:

```typescript
  if (state.phase === "night") {
    sysWave(state, dt, nightMaxZombies(state.day, liveCount(state)));
    let indoor = 0;
    for (const z of state.zombies) if (Math.abs(z.x) < HW && Math.abs(z.y) < HH) indoor++;
    state.breachT = isFortressBreached(indoor, liveCount(state))
      ? state.breachT + dt
      : Math.max(0, state.breachT - dt);
    if (state.breachT >= CONFIG.siege.breachSustain) {
      enterBreached(state);
      return "breached";
    }
    state.phaseT -= dt;
    if (state.phaseT > 0) return null;
    return "dawn";
  }
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `bun run test -- sim/systems/siege.test.ts` → PASS
Run: `bun run typecheck` → no errors

- [ ] **Step 5: Commit**

```bash
git add sim/systems/siege.ts sim/systems/siege.test.ts
git commit -m "feat(density): occupancy-linked breach threshold + wire live count into sysSiege"
```

---

### Task 7: In-run bounty scales with occupancy (meta stays neutral)

Scale in-run bounty with occupancy so per-head earnings keep pace with the scaled threat, while leaving the cross-run SALVAGE meta untouched.

**Files:**
- Modify: `sim/systems/economy.ts` (add `scaledBounty`)
- Modify: `sim/systems/bullets.ts` (`killZombie` applies it)
- Test: `sim/systems/economy.test.ts` (create)

**Interfaces:**
- Consumes: `CONFIG.econ.bountyPerPlayer` (Task 2), `liveCount` (Task 1).
- Produces: `scaledBounty(base: number, players: number): number` — integer, `>= base`.

- [ ] **Step 1: Write the failing test**

Create `sim/systems/economy.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { scaledBounty } from "./economy";

describe("scaledBounty", () => {
  it("is the base amount for a single player", () => {
    expect(scaledBounty(20, 1)).toBe(20);
  });

  it("scales up with squad size and stays integer", () => {
    const v = scaledBounty(20, 5);
    expect(v).toBe(Math.round(20 * (1 + 4 * CONFIG.econ.bountyPerPlayer)));
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- sim/systems/economy.test.ts`
Expected: FAIL — `scaledBounty` not exported.

- [ ] **Step 3: Implement `scaledBounty` and apply it in `killZombie`**

In `sim/systems/economy.ts`, add (above `awardBounty`):

```typescript
/** Scale an in-run bounty by squad size so per-head earnings keep pace with the occupancy-
 *  scaled threat. Cross-run SALVAGE meta is deliberately NOT scaled (stays occupancy-neutral).
 *  Integer out (money is integer). */
export function scaledBounty(base: number, players: number): number {
  return Math.round(base * (1 + Math.max(0, players - 1) * CONFIG.econ.bountyPerPlayer));
}
```

In `sim/systems/bullets.ts`, add `liveCount` to the `./wave` import? No — `bullets.ts` does not import wave. Import `liveCount` from `./wave` and `scaledBounty` from `./economy` (which is already imported for `awardBounty`). Update the imports and the `awardBounty` call in `killZombie`:

```typescript
import { awardBounty, scaledBounty } from "./economy";
import { liveCount } from "./wave";
```

Replace the bounty line in `killZombie`:

```typescript
  awardBounty(state, z.x, z.y, scaledBounty(z.bounty, liveCount(state)));
```

(Confirm no import cycle: `wave.ts` imports `config`/`enemies`/`waves`/`geometry`/`math`/`state`/`types` — not `bullets` or `economy` — so `bullets → wave` is acyclic. Run `bun run typecheck` to confirm.)

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `bun run test -- sim/systems/economy.test.ts` → PASS
Run: `bun run typecheck` → no errors

- [ ] **Step 5: Commit**

```bash
git add sim/systems/economy.ts sim/systems/economy.test.ts sim/systems/bullets.ts
git commit -m "feat(density): in-run bounty scales with occupancy (SALVAGE meta stays neutral)"
```

---

### Task 8: Full suite + feel-gate handoff

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `bun run test`
Expected: PASS (all existing + new tests).

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck` → no errors
Run: `bun run lint` → no errors

- [ ] **Step 3: Feel-gate playtest (human, on `dev:coop`)**

This is the acceptance gate — the numeric values above are first-pass and are **tuned here, not asserted in tests**. Hand off to the user to play `bun run dev:coop` and verify:
1. **Solo cold arrival feels alive and fair** — density=1 is a complete horror scene, not brutal, not empty.
2. **Low-pop transition (2–3)** feels natural, no cliff.
3. **Big-party density** reads as SAS3 mowing (within the 12-player cap) and is dense-but-not-punished (bounty keeps pace).
4. **Breach still REACHABLE but not runaway at high pop** — two-sided check: (a) a big party defending normally does NOT trip Day→1 (the co-scale holds); AND (b) if a 12-player arena *deliberately lets its openings fall*, the interior CAN still reach the scaled threshold (14 + 11×3 = 47) and soft-reset — confirm breach isn't tuned so high it's unreachable (the interior geometrically holds ~120, so 47 is possible, but through 4 narrow openings it's demanding — verify it actually fires when earned, else `breachPerPlayer` is too high).
5. **Real-time transitions are smooth** — a mid-night join/leave ramps the budget without a visible spawn-rate jerk (EMA).
6. **Dread survives at low population** (the genre slider).

Record results honestly. Adjust `CONFIG` values (`bountyPerPlayer`, `toughPerPlayer`, `nightCapPerPlayer`/`nightCapPlayerMax`, `breachPerPlayer`, `effCountEase`) per feel and re-commit as tuning follow-ups. **Watch the cap↔toughness coupling** (Task 2 comment): if a big party feels too easy and you raise `nightCapPlayerMax`, the cap-driven per-person easing weakens and `toughPerPlayer` surfaces as harder-per-person — tune the pair together.

**Note — existing absolute-value tests:** a few pre-existing tests pin exact numbers against base constants: `sim/data/waves.test.ts` (`waveDef(1,3).batch === 2` depends on `waveCountPerPlayer = 0.5`) and `sim/systems/siege.test.ts` (`nightMaxZombies`/`isFortressBreached` base values). If tuning changes those base constants, update those pinned assertions in the same commit — they are regression guards, not failures.

- [ ] **Step 4: Commit any tuning adjustments**

```bash
git add sim/config.ts
git commit -m "tune(density): feel-gate playtest adjustments"
```

---

## Self-Review

**Spec coverage (this plan = the density core of the spec §3):**
- Real-time EMA re-eval of the HORDE budget → Tasks 1, 4 — **NIGHT only** (the horde exists only at night; `sysWave` runs in `sysSiege`'s night branch). In-run bounty (Task 7) scales day AND night (any kill). So "real-time day+night" holds for reward; **horde density is night-scoped** (correct — there is no day horde). Occupancy-scaling the sparse day `seedRoamers` is a **deferred minor nicety**, not done here (roamers are intentionally sparse respite; a mid-day join adding roamers would need continuous day spawning that doesn't exist). Claim corrected from the earlier "day+night ✓".
- Count ~linear (batch `mul`) vs per-person load EASED — Task 3 + Task 5. ⚠ The per-person easing is **emergent from the sublinear `nightMaxZombies` cap** (85/12p ≈ 7-per-head vs 45 solo), NOT from `toughPerPlayer` (which makes individuals slightly *harder* — the toughness/texture axis). These are coupled: raising `nightCapPlayerMax` weakens the easing and surfaces harder-per-person. Documented in Task 2's config comment and the Task 8 tuning note.
- Toughness composition-shift primary + gentle flat HP → Task 3. ✓
- In-run reward scales, cross-run SALVAGE neutral → Task 7 (bounty scaled; `salvageEarned`/`salvageShare` untouched). **Rationale it's already neutral:** dawn splits the delta `floor((day*8 + kills*0.15 − banked)/present)` — the `day*8` term is DIVIDED by headcount (per-capita shrinks with more players) and the `kills` term is ~constant per-capita, so per-player meta accrual is not inflated by squad size. Leaving it untouched is correct. ✓
- Modest occupancy `nightMaxZombies` raise bounded by full-snapshot budget → Task 5. ✓
- Mandatory `breachZombies` occupancy co-scale → Task 6. ✓
- Genre-slider + feel gates → Task 8. ✓

**Out of this plan (deferred — see handoff):** safe-arrival spawn grace (own plan), perimeter pressure (needs a design sub-pass — the "open more openings with headcount" mechanism is underspecified), full-arena graceful UX (own slice), apex punctuation (low priority), pacing knob. Named launch risks (apac-ne latency, ads-pause, offline fallback) are non-code / other sub-projects.

**Placeholder scan:** none — every code step shows full code; every value is concrete.

**Type consistency:** `liveCount(state)` (Task 1) used in Tasks 4, 6, 7. `Wave.effCount` (Task 1) used in Task 4. `waveDef(n, players)` (Task 3) used in Tasks 1, 4. `nightMaxZombies(day, players)` (Task 5) and `isFortressBreached(indoorCount, players)` (Task 6) used in `sysSiege` (Task 6). `scaledBounty(base, players)` (Task 7) used in `killZombie`. Config knobs (Task 2) consumed by Tasks 3, 5, 6, 7. Consistent.
