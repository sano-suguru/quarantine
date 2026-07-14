# DO Server 2b② Milestone A — Soft-Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `night → breached → resetting → day1` soft-reset failure stake to the DO-authoritative arena — a breach fires when the fortress interior is overrun, a short frozen beat plays, then the communal world rebuilds to a fresh Day-1, with clients re-deriving the reset off the synced `phase` field (no new wire event).

**Architecture:** `sysSiege` drives the whole clock including the reset machine (day/night/breached/resetting branches); `stepSim` skips the gameplay systems while a reset phase is active (freeze) but always runs `sysSiege`. Breach detection is a pure predicate over an indoor-zombie count with a short sustain. The DO reacts to `stepSim`'s widened return (`"reset"` → rebuild the world, symmetric with the existing `"dawn"` → `sysDawn`). Clients detect the reset on the `resetting → day` phase edge and hard-clear their interpolation buffer so the wholesale entity-id churn doesn't misfire as mass-kill/mass-spawn fx.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess`), Vitest (co-located `*.test.ts`, `node` env), the headless `sim/` closure, the `worker/` Cloudflare Durable Object, Biome, Bun.

## Global Constraints

Copied verbatim from the spec (`docs/superpowers/specs/2026-07-14-do-server-2b2-persistence-design.md`) — every task's requirements implicitly include these:

- **The DO never globally pauses** — `state.paused` / `state.inShop` are never set server-side. The reset freeze is `stepSim` gating the gameplay systems, NOT `paused`.
- **Derive-first fx** — no `fxEvents` and no new control message on the wire for the reset; it is signalled by the synced `phase` field + the client's phase-edge handling.
- **`sim/` stays headless** — no DOM/WebGL/audio/storage imports; enforced by `sim/tsconfig.json`. New sim logic (breach predicate, state machine, `resetArena`) is pure/headless.
- **Systems stay net-agnostic** — state + events, never importing net code.
- **Tune through `CONFIG`**, not the systems. New siege constants live in `CONFIG.siege`.
- **Swap-and-pop / array clears** for entity removal; order not preserved.
- **Feel-first** — breach reachability, the failure beat, and reset coherence are validated by the M-A playtest gate, not just by compilation.
- **PROTOCOL_VERSION 19 → 20** — the snapshot `phase` wire encoding changes; a stale client must be rejected by the existing hello `v` gate.

**Persistence (freeze/thaw, SQLite, empty-hibernate) is M-B — explicitly out of this plan.** M-A merges without persistence; a DO restart still resets to Day 1 (same as 2b①, no regression).

**Testing/commands:**
- Run one test file: `bunx vitest run <path>` (e.g. `bunx vitest run sim/systems/siege.test.ts`).
- Typecheck: `bun run typecheck`. Build: `bun run build`. Lint (auto on commit): `bun run lint`.
- Full test suite: `bun run test`.

---

## File Structure

- `sim/config.ts` — add four `CONFIG.siege` constants (breach tuning + reset-phase durations).
- `sim/types.ts` — widen `SiegePhase`; add transient `State.breachT`.
- `sim/state.ts` — initialize `breachT: 0` in `newState()`.
- `sim/data/map.ts` — export `HW`/`HH` (currently module-private) for the indoor test.
- `sim/systems/siege.ts` — `isFortressBreached` (pure predicate), `enterBreached`, the widened `sysSiege` with breached/resetting branches + breach detection; `resetArena` (the Day-1 rebuild).
- `sim/step.ts` — freeze-gate the gameplay systems; widen the return type; pass the new siege outcomes through.
- `sim/snapshot.ts` — 2-bit `phase` encode/decode.
- `sim/net/protocol.ts` — bump `PROTOCOL_VERSION` to 20.
- `sim/systems/siegeEdge.ts` — `siegeEdgeCue` branches for `breached`/`resetting`; `isArenaResetEdge` pure helper.
- `game/net/client.ts` — `onSnap` reset handling (uses `isArenaResetEdge`): clear buffers + skip the churn-frame `effects()`.
- `worker/arena.ts` — react to `stepSim`'s `"reset"` outcome (`resetArena`); the wider union in the `step()` switch.
- Tests (co-located, extend existing): `sim/systems/siege.test.ts`, `sim/step.test.ts`, `sim/snapshot.test.ts`, `sim/systems/siegeEdge.test.ts`.

---

## Task 1: Breach detection — `isFortressBreached` + `sysSiege` night accumulation

Adds the SiegePhase values, CONFIG constants, the transient `breachT`, the `HW`/`HH` export, the pure predicate, and the `night`-branch detection that fires `"breached"`.

**Files:**
- Modify: `sim/types.ts` (`SiegePhase` line 514; `State` — add `breachT`)
- Modify: `sim/config.ts` (`CONFIG.siege` block, after `respawnDelay` ~line 254)
- Modify: `sim/state.ts` (`newState()` return object)
- Modify: `sim/data/map.ts` (export `HW`/`HH`, lines 11-12)
- Modify: `sim/systems/siege.ts` (`isFortressBreached`, `enterBreached`, `sysSiege` night branch + widened return)
- Test: `sim/systems/siege.test.ts`

**Interfaces:**
- Produces:
  - `SiegePhase = "day" | "night" | "breached" | "resetting"`
  - `CONFIG.siege.breachZombies: number`, `breachSustain: number`, `breachedDuration: number`, `resettingDuration: number`
  - `State.breachT: number` (transient, not snapshotted, not persisted)
  - `export const HW: number`, `export const HH: number` (from `sim/data/map.ts`)
  - `isFortressBreached(indoorCount: number): boolean`
  - `enterBreached(state: State): void`
  - `sysSiege(state, dt)` return type widens to `"night" | "dawn" | "breached" | "reset" | null` (only `"night" | "dawn" | "breached" | null` are produced in this task; `"reset"` arrives in Task 2)

- [ ] **Step 1: Widen `SiegePhase` and add `breachT`**

In `sim/types.ts`, line 514:
```ts
/** Day = lit scavenge window; night = the horde siege; breached = the frozen "fortress fell"
 *  beat; resetting = the brief Day-1 rebuild window. */
export type SiegePhase = "day" | "night" | "breached" | "resetting";
```
In `sim/types.ts`, in `interface State`, next to `phaseT` (~line 567), add:
```ts
  /** breach-detection sustain accumulator (counts up while the interior is overrun, decays below
   *  threshold). Server-only + transient — NOT snapshotted, NOT persisted (like flow/navTick). */
  breachT: number;
```

- [ ] **Step 2: Add CONFIG constants**

In `sim/config.ts`, inside the `siege:` object, after `respawnDelay: 17,` (~line 254):
```ts
    // --- soft-reset (2b②-M-A) ---
    breachZombies: 14, // interior (HOME-rect) zombie count that reads as "fortress overrun"
    breachSustain: 1.5, // seconds the interior must stay overrun before the breach fires (anti-flicker)
    breachedDuration: 3, // seconds of the frozen "FORTRESS FALLEN" beat
    resettingDuration: 0.5, // brief rebuild hold; >= one broadcast interval so clients see the edge
```

- [ ] **Step 3: Initialize `breachT` in `newState()`**

In `sim/state.ts`, in the returned object (near `phaseT`/`kills`), add:
```ts
    breachT: 0,
```

- [ ] **Step 4: Export `HW`/`HH` from the map**

In `sim/data/map.ts`, lines 11-12, change:
```ts
const HW = 180;
const HH = 150;
```
to:
```ts
/** HOME half-extents (the fortress interior is |x| < HW && |y| < HH). Exported for breach detection. */
export const HW = 180;
export const HH = 150;
```

- [ ] **Step 5: Write the failing test for `isFortressBreached` + breach detection**

In `sim/systems/siege.test.ts`, add (adjust imports to match the file's existing style):
```ts
import { isFortressBreached, sysSiege, startNight } from "./siege";
import { newState } from "../state";
import { CONFIG } from "../config";

function nightState() {
  const s = newState();
  s.running = true;
  startNight(s); // phase="night", phaseT=nightDuration(day)
  return s;
}

describe("isFortressBreached", () => {
  it("is false below the threshold and true at/above it", () => {
    expect(isFortressBreached(CONFIG.siege.breachZombies - 1)).toBe(false);
    expect(isFortressBreached(CONFIG.siege.breachZombies)).toBe(true);
    expect(isFortressBreached(CONFIG.siege.breachZombies + 5)).toBe(true);
  });
});

describe("sysSiege breach detection", () => {
  it("fires 'breached' after the interior stays overrun for breachSustain, and freezes the clock there", () => {
    const s = nightState();
    // place enough zombies inside the HOME rect to be overrun
    for (let i = 0; i < CONFIG.siege.breachZombies + 2; i++) {
      s.zombies.push({ ...s.zombies[0], id: 1000 + i, x: 0, y: 0, hp: 10 } as (typeof s.zombies)[number]);
    }
    let out: ReturnType<typeof sysSiege> = null;
    // step past the sustain window
    const steps = Math.ceil(CONFIG.siege.breachSustain / (1 / 60)) + 2;
    for (let i = 0; i < steps && out !== "breached"; i++) out = sysSiege(s, 1 / 60);
    expect(out).toBe("breached");
    expect(s.phase).toBe("breached");
    expect(s.phaseT).toBeCloseTo(CONFIG.siege.breachedDuration, 5);
  });

  it("does not fire when the interior is empty (breachT decays)", () => {
    const s = nightState();
    for (let i = 0; i < 30; i++) expect(sysSiege(s, 1 / 60)).not.toBe("breached");
    expect(s.breachT).toBe(0);
  });
});
```
(If `s.zombies[0]` doesn't exist in a fresh night state, construct a minimal zombie literal matching `Zombie` instead — copy the shape from an existing `spawnZombie` test helper in the file.)

- [ ] **Step 6: Run the test to verify it fails**

Run: `bunx vitest run sim/systems/siege.test.ts`
Expected: FAIL — `isFortressBreached` not exported / `sysSiege` never returns `"breached"`.

- [ ] **Step 7: Implement the predicate + detection**

In `sim/systems/siege.ts`:
- Add imports at top: `import { HW, HH } from "../data/map";`
- Add the pure predicate (near `nightMaxZombies`):
```ts
/** Overrun test: the interior holds at least this many zombies. Pure — the caller counts. */
export function isFortressBreached(indoorCount: number): boolean {
  return indoorCount >= CONFIG.siege.breachZombies;
}

/** Enter the frozen failure beat. */
export function enterBreached(state: State): void {
  state.phase = "breached";
  state.phaseT = CONFIG.siege.breachedDuration;
  state.breachT = 0;
}
```
- Widen the `sysSiege` signature return type to `"night" | "dawn" | "breached" | "reset" | null`.
- In the `night` branch, after the `sysWave(...)` call and before the `phaseT -= dt` dawn check, insert:
```ts
  // breach: the interior being overrun for breachSustain seconds falls the fortress
  let indoor = 0;
  for (const z of state.zombies) if (Math.abs(z.x) < HW && Math.abs(z.y) < HH) indoor++;
  state.breachT = isFortressBreached(indoor)
    ? state.breachT + dt
    : Math.max(0, state.breachT - dt);
  if (state.breachT >= CONFIG.siege.breachSustain) {
    enterBreached(state);
    return "breached";
  }
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bunx vitest run sim/systems/siege.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `bun run typecheck`
Expected: PASS (the widened `SiegePhase` may surface exhaustiveness gaps elsewhere — if so they are addressed by later tasks; if `bun run typecheck` fails now, the only expected breakage is the new `sysSiege` return union not yet handled by `stepSim`/`sysSiege`'s own remaining branches, which Task 2 completes. If a *different* file errors, fix it here.)

- [ ] **Step 10: Commit**

```bash
git add sim/types.ts sim/config.ts sim/state.ts sim/data/map.ts sim/systems/siege.ts sim/systems/siege.test.ts
git commit -m "feat(2b②-A): breach detection — isFortressBreached + sysSiege interior-overrun trigger"
```

---

## Task 2: Reset state machine — `sysSiege` breached/resetting branches + `stepSim` freeze-gating

Completes the server-side machine: the frozen phases count down and hand off, and `stepSim` skips the gameplay systems while frozen.

**Files:**
- Modify: `sim/systems/siege.ts` (`sysSiege` breached + resetting branches)
- Modify: `sim/step.ts` (freeze-gate; widen return; pass new outcomes)
- Test: `sim/systems/siege.test.ts`, `sim/step.test.ts`

**Interfaces:**
- Consumes: `enterBreached`, the widened `sysSiege` return (Task 1).
- Produces:
  - `sysSiege` now also returns `"reset"` (when `resetting` elapses); sets `phase="resetting"` when `breached` elapses.
  - `stepSim(state, dt)` return type: `"night" | "dawn" | "breached" | "reset" | null`; skips `sysPlayer/sysAssist/sysRespawn/sysAI/sysStalker/sysDeployables/sysBullets/sysPickups` when `phase` is `breached` or `resetting`.

- [ ] **Step 1: Write the failing test for the frozen-phase transitions + gating**

In `sim/systems/siege.test.ts`:
```ts
describe("sysSiege reset machine", () => {
  it("breached counts down to resetting, resetting counts down to 'reset'", () => {
    const s = newState();
    s.running = true;
    s.phase = "breached";
    s.phaseT = CONFIG.siege.breachedDuration;
    // exhaust breached
    let out: ReturnType<typeof sysSiege> = null;
    for (let i = 0; i < Math.ceil(CONFIG.siege.breachedDuration * 60) + 2; i++) out = sysSiege(s, 1 / 60);
    expect(s.phase).toBe("resetting");
    // exhaust resetting
    for (let i = 0; i < Math.ceil(CONFIG.siege.resettingDuration * 60) + 2 && out !== "reset"; i++)
      out = sysSiege(s, 1 / 60);
    expect(out).toBe("reset");
  });
});
```
In `sim/step.test.ts`:
```ts
import { stepSim } from "./step";
import { newState } from "./state";
import { CONFIG } from "./config";

describe("stepSim freeze during reset phases", () => {
  it("does not advance gameplay while phase is 'breached', but the reset clock ticks", () => {
    const s = newState();
    s.running = true;
    s.phase = "breached";
    s.phaseT = CONFIG.siege.breachedDuration;
    // a zombie that would move if sysAI ran
    s.zombies.push({ ...(s.zombies[0] ?? {}), id: 999, x: 500, y: 0 } as (typeof s.zombies)[number]);
    const zx = s.zombies[s.zombies.length - 1]!.x;
    const t0 = s.phaseT;
    stepSim(s, 1 / 60);
    expect(s.zombies[s.zombies.length - 1]!.x).toBe(zx); // sysAI skipped
    expect(s.phaseT).toBeLessThan(t0); // sysSiege ran
  });
});
```
(Construct the zombie literal to satisfy `Zombie` — reuse the shape from Task 1's helper.)

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run sim/systems/siege.test.ts sim/step.test.ts`
Expected: FAIL — `resetting`/`reset` unhandled; `stepSim` still moves zombies during `breached`.

- [ ] **Step 3: Add the breached/resetting branches to `sysSiege`**

In `sim/systems/siege.ts`, at the end of `sysSiege` (after the `night` branch, before the final `return null`), add:
```ts
  if (state.phase === "breached") {
    state.phaseT -= dt;
    if (state.phaseT <= 0) {
      state.phase = "resetting";
      state.phaseT = CONFIG.siege.resettingDuration;
    }
    return null;
  }
  if (state.phase === "resetting") {
    state.phaseT -= dt;
    if (state.phaseT <= 0) return "reset";
    return null;
  }
```

- [ ] **Step 4: Freeze-gate `stepSim`**

In `sim/step.ts`, widen the signature return type to `"night" | "dawn" | "breached" | "reset" | null`, then gate the gameplay systems and pass the new outcomes:
```ts
export function stepSim(state: State, dt: number): "night" | "dawn" | "breached" | "reset" | null {
  if (!state.running || state.paused) return null;
  let sdt = dt;
  if (state.hitstopT > 0) {
    state.hitstopT -= dt;
    sdt = dt * CONFIG.feel.hitstopScale;
  }
  state.time += sdt;
  const frozen = state.phase === "breached" || state.phase === "resetting";
  if (!frozen) {
    sysPlayer(state, sdt);
    sysAssist(state, sdt);
    sysRespawn(state, sdt);
    sysAI(state, sdt);
    if (state.stalker) sysStalker(state, sdt);
    sysDeployables(state, sdt);
    sysBullets(state, sdt);
    sysPickups(state, sdt);
  }
  const ev = sysSiege(state, sdt);
  if (ev === "night") {
    spawnStalker(state);
    pushFx(state, { t: "announce", label: "NIGHT", day: state.day });
    pushFx(state, { t: "audio", cue: "waveStart" });
    return "night";
  }
  if (ev === "dawn") {
    if (state.stalker) state.stalker.state = "retreat";
    pushFx(state, { t: "audio", cue: "dawn" });
    return "dawn";
  }
  if (ev === "breached") return "breached";
  if (ev === "reset") return "reset";
  return null;
}
```

- [ ] **Step 5: Run to verify pass**

Run: `bunx vitest run sim/systems/siege.test.ts sim/step.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS (`worker/arena.ts` still compiles: its `outcome === "dawn"` check narrows against the wider union fine; the `"reset"` handler is Task 6).

- [ ] **Step 7: Commit**

```bash
git add sim/systems/siege.ts sim/step.ts sim/systems/siege.test.ts sim/step.test.ts
git commit -m "feat(2b②-A): reset state machine — breached/resetting branches + stepSim freeze-gating"
```

---

## Task 3: `resetArena` — the Day-1 rebuild

The world-reaction the DO runs on `"reset"`, symmetric with `sysDawn`. Headless + unit-tested.

**Files:**
- Modify: `sim/systems/siege.ts` (add `resetArena`)
- Test: `sim/systems/siege.test.ts`

**Interfaces:**
- Consumes: `startDay` (existing), `revivePlayer` (existing, `sim/engine/players.ts`), `CONFIG.siege.boardMaxHp`.
- Produces: `resetArena(state: State): void`.

- [ ] **Step 1: Write the failing test**

In `sim/systems/siege.test.ts`:
```ts
import { resetArena } from "./siege";

describe("resetArena", () => {
  it("rebuilds a fresh Day-1: clears the horde, restores barricades/economy, revives players", () => {
    const s = newState();
    s.running = true;
    s.day = 6;
    s.phase = "resetting";
    s.kills = 120;
    s.salvageBanked = 300;
    s.breachT = 5;
    s.zombies.push({ ...(s.zombies[0] ?? {}), id: 5, x: 0, y: 0 } as (typeof s.zombies)[number]);
    s.bullets.push({} as (typeof s.bullets)[number]);
    for (const b of s.barricades) b.hp = 1;
    const p = s.players[0]!;
    p.hp = 0;

    resetArena(s);

    expect(s.day).toBe(1);
    expect(s.phase).toBe("day");
    expect(s.zombies.length).toBe(0);
    expect(s.bullets.length).toBe(0);
    expect(s.kills).toBe(0);
    expect(s.salvageBanked).toBe(0);
    expect(s.breachT).toBe(0);
    expect(s.barricades.every((b) => b.hp === CONFIG.siege.boardMaxHp)).toBe(true);
    expect(p.hp).toBe(p.maxHp); // revived
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run sim/systems/siege.test.ts`
Expected: FAIL — `resetArena` not exported.

- [ ] **Step 3: Implement `resetArena`**

In `sim/systems/siege.ts` (import `revivePlayer` from `../engine/players`):
```ts
/**
 * Soft-reset the arena to a fresh Day-1 (run by the DO on stepSim's "reset"). Communal only:
 * the horde/economy/barricades reset and every player is revived at the fortress; per-player
 * SALVAGE/unlocks are client-side meta and untouched. Symmetric with sysDawn.
 */
export function resetArena(state: State): void {
  state.day = 1;
  state.zombies.length = 0;
  state.bullets.length = 0;
  state.pickups.length = 0;
  state.particles.length = 0;
  state.decals.length = 0;
  for (const b of state.barricades) b.hp = CONFIG.siege.boardMaxHp;
  state.kills = 0;
  state.salvageBanked = 0;
  state.breachT = 0;
  for (const p of state.players) revivePlayer(state, p); // fortress spawn, full hp, clears downT
  startDay(state); // phase="day", phaseT=dayDuration, restock caches, seed roamers
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run sim/systems/siege.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add sim/systems/siege.ts sim/systems/siege.test.ts
git commit -m "feat(2b②-A): resetArena — communal Day-1 rebuild on soft-reset"
```

---

## Task 4: Snapshot 2-bit `phase` + PROTOCOL_VERSION bump

Four phase values need two flag bits. `night`/`day` keep their current encoding (indices 1/0 → bit2), `breached`/`resetting` use bit3.

**Files:**
- Modify: `sim/snapshot.ts` (encode ~line 636, decode ~line 1241)
- Modify: `sim/net/protocol.ts` (line 3)
- Test: `sim/snapshot.test.ts`

**Interfaces:**
- Consumes: the widened `SiegePhase` (Task 1).
- Produces: `phase` round-trips through `encode`/`decode` for all four values; `PROTOCOL_VERSION === 20`.

- [ ] **Step 1: Write the failing test**

In `sim/snapshot.test.ts`:
```ts
import { captureSnapshot, encode, decode } from "./snapshot";
import { newState } from "./state";
import type { SiegePhase } from "./types";

describe("snapshot phase 2-bit round-trip", () => {
  it("preserves all four phases through encode/decode", () => {
    for (const phase of ["day", "night", "breached", "resetting"] as SiegePhase[]) {
      const s = newState();
      s.phase = phase;
      const round = decode(encode(captureSnapshot(s, 1)));
      expect(round.phase).toBe(phase);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run sim/snapshot.test.ts`
Expected: FAIL — `breached`/`resetting` decode as `day`/`night`.

- [ ] **Step 3: Implement the 2-bit encode/decode**

In `sim/snapshot.ts`, add a shared index table near the top of the encode/decode region (module scope):
```ts
// phase occupies flag bits 2-3 (index 0-3). day/night keep their pre-2b② single-bit values
// (0/1 → bit2), breached/resetting add bit3. Byte length is unchanged.
const PHASE_ORDER = ["day", "night", "breached", "resetting"] as const;
```
Replace the encode flag byte (line 635-636):
```ts
  // flags: bit0 isFull, bit1 paused, bits2-3 phase index (see PHASE_ORDER)
  w.u8((snap.isFull ? 1 : 0) | (snap.paused ? 2 : 0) | (PHASE_ORDER.indexOf(snap.phase) << 2));
```
Replace the decode phase field (line 1241):
```ts
    phase: PHASE_ORDER[(flags >> 2) & 3] ?? "day",
```

- [ ] **Step 4: Bump the protocol version**

In `sim/net/protocol.ts`, line 3:
```ts
export const PROTOCOL_VERSION = 20;
```

- [ ] **Step 5: Run to verify pass**

Run: `bunx vitest run sim/snapshot.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add sim/snapshot.ts sim/net/protocol.ts sim/snapshot.test.ts
git commit -m "feat(2b②-A): snapshot 2-bit phase encoding + PROTOCOL_VERSION 20"
```

---

## Task 5: `siegeEdgeCue` + `isArenaResetEdge` — pure client-cue helpers

The cue derivation gains breached/resetting branches; a pure `isArenaResetEdge` lets Task 6's client wiring stay a thin call over a tested core.

**Files:**
- Modify: `sim/systems/siegeEdge.ts`
- Test: `sim/systems/siegeEdge.test.ts`

**Interfaces:**
- Consumes: the widened `SiegePhase`.
- Produces:
  - `siegeEdgeCue(prev, next, day)` — `next==="breached"` → fallen-fortress cue; `next==="resetting"` → `[]`; `night`/`day` unchanged.
  - `isArenaResetEdge(prev: SiegePhase | null, next: SiegePhase): boolean` — true only on `resetting → day` (the entity-churn frame).

- [ ] **Step 1: Write the failing test**

In `sim/systems/siegeEdge.test.ts`:
```ts
import { siegeEdgeCue, isArenaResetEdge } from "./siegeEdge";

describe("siegeEdgeCue reset phases", () => {
  it("fires the fallen cue on night→breached", () => {
    const cues = siegeEdgeCue("night", "breached", 3);
    expect(cues.some((c) => c.t === "announce")).toBe(true);
  });
  it("is silent on breached→resetting", () => {
    expect(siegeEdgeCue("breached", "resetting", 3)).toEqual([]);
  });
  it("still fires DAY on the normal night→day dawn", () => {
    const cues = siegeEdgeCue("night", "day", 4);
    expect(cues.some((c) => c.t === "announce" && (c as { label: string }).label === "DAY")).toBe(true);
  });
});

describe("isArenaResetEdge", () => {
  it("is true only on resetting→day", () => {
    expect(isArenaResetEdge("resetting", "day")).toBe(true);
    expect(isArenaResetEdge("breached", "resetting")).toBe(false);
    expect(isArenaResetEdge("night", "day")).toBe(false);
    expect(isArenaResetEdge(null, "day")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run sim/systems/siegeEdge.test.ts`
Expected: FAIL — `isArenaResetEdge` not exported; `breached`/`resetting` fall through to the DAY cue.

- [ ] **Step 3: Implement**

Rewrite `sim/systems/siegeEdge.ts`:
```ts
import type { FxEvent, SiegePhase } from "../types";

/**
 * Client-side derivation of the siege one-shots from the synced phase edge. The DO carries no
 * fxEvents (derive-first); the client tracks the last-seen phase and replays the cue when it flips.
 * prev=null (first snapshot / post-reset) yields nothing, so a drop-in shows no banner.
 */
export function siegeEdgeCue(prev: SiegePhase | null, next: SiegePhase, day: number): FxEvent[] {
  if (prev === null || prev === next) return [];
  if (next === "night") {
    return [
      { t: "announce", label: "NIGHT", day },
      { t: "audio", cue: "waveStart" },
    ];
  }
  if (next === "breached") {
    return [
      { t: "announce", label: "FORTRESS FALLEN", day },
      { t: "audio", cue: "breach" },
    ];
  }
  if (next === "resetting") return []; // silent rebuild hold
  // next === "day": the normal dawn banner (also the resetting→day frame, but the client nulls
  // prevPhase on reset via isArenaResetEdge before this runs, so no banner fires on a reset).
  return [
    { t: "announce", label: "DAY", day },
    { t: "audio", cue: "dawn" },
  ];
}

/** The entity-churn frame: the DO rebuilds the world on resetting→day, so the client must
 *  hard-clear its interp buffer here (else the wholesale id churn misfires as mass kill/spawn fx). */
export function isArenaResetEdge(prev: SiegePhase | null, next: SiegePhase): boolean {
  return prev === "resetting" && next === "day";
}
```
Note: `{ t: "audio", cue: "breach" }` uses a cue string the audio layer may not implement yet — that is fine (an unknown cue is a no-op in the audio sink); the fallen-fortress *audio* design is a feel-gate item, not a blocker. Keep the `announce` banner regardless.

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run sim/systems/siegeEdge.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add sim/systems/siegeEdge.ts sim/systems/siegeEdge.test.ts
git commit -m "feat(2b②-A): siegeEdgeCue breached/resetting cues + isArenaResetEdge helper"
```

---

## Task 6: Client `onSnap` reset handling

On the `resetting → day` frame, hard-clear the interp buffer and skip that frame's diff-derived fx so the entity-id churn doesn't burst mass-kill/mass-spawn. Client code — verified by typecheck/build + the M-A feel-gate (client net layer is not unit-tested, per project discipline); the decision core (`isArenaResetEdge`) is already tested in Task 5.

**Files:**
- Modify: `game/net/client.ts` (`onSnap`, ~lines 174-183)

**Interfaces:**
- Consumes: `isArenaResetEdge` (Task 5), the existing `resetNet()` (`client.ts:236`).

- [ ] **Step 1: Add the import**

In `game/net/client.ts`, extend the siegeEdge import (line 20):
```ts
import { isArenaResetEdge, siegeEdgeCue } from "../../sim/systems/siegeEdge";
```

- [ ] **Step 2: Wire the reset frame in `onSnap`**

In `game/net/client.ts`, replace the block at lines 174-183:
```ts
      this.reconcile(snap);
      if (this.prev) this.effects(this.prev, snap);
      const cues = siegeEdgeCue(this.prevPhase, snap.phase, snap.day);
      this.prevPhase = snap.phase;
      if (cues.length) {
        const st = getState();
        for (const c of cues) st.fxEvents.push(c);
        drainFxEvents(st); // banner + sting via the existing sink
      }
      this.prev = snap;
```
with:
```ts
      this.reconcile(snap);
      // On the soft-reset churn frame (resetting→day) the whole entity set is replaced at once;
      // hard-clear the interp buffer + prediction so prev→next diffing doesn't fire a phantom
      // mass-kill/mass-spawn burst, and skip this frame's effects()/cue entirely. resetNet() nulls
      // prev/prevPhase/lastTick, so the day-1 snapshot below re-seeds the buffer cleanly.
      if (isArenaResetEdge(this.prevPhase, snap.phase)) {
        this.resetNet();
        this.prev = snap;
        this.prevPhase = snap.phase;
        return;
      }
      if (this.prev) this.effects(this.prev, snap);
      const cues = siegeEdgeCue(this.prevPhase, snap.phase, snap.day);
      this.prevPhase = snap.phase;
      if (cues.length) {
        const st = getState();
        for (const c of cues) st.fxEvents.push(c);
        drainFxEvents(st); // banner + sting via the existing sink
      }
      this.prev = snap;
```
Note: `resetNet()` sets `lastTick = -1` and empties `buf`; the `this.buf.push({snap})` above already ran, so `buf` is cleared to `[]` for one frame and `render()` early-returns until the next day-1 snapshot arrives (~one broadcast interval — imperceptible). Setting `this.prev = snap` after `resetNet` means the *next* day-1 snapshot diffs against a clean day-1 prev (few/no entities), so no phantom fx.

- [ ] **Step 3: Typecheck + build**

Run: `bun run typecheck && bun run build`
Expected: PASS (build confirms the client bundle compiles).

- [ ] **Step 4: Commit**

```bash
git add game/net/client.ts
git commit -m "feat(2b②-A): client hard-clears interp on the resetting→day churn frame"
```

---

## Task 7: DO wiring + integration + feel-gate

The DO reacts to the new `stepSim` outcomes; then the blocking playtest gate.

**Files:**
- Modify: `worker/arena.ts` (`step()` switch, ~lines 89-100; import `resetArena`)

**Interfaces:**
- Consumes: `resetArena` (Task 3), the widened `stepSim` return (Task 2).

- [ ] **Step 1: React to `"reset"` in the DO step loop**

In `worker/arena.ts`, add the import (with the other `sim/systems/*` imports):
```ts
import { resetArena, startDay } from "../sim/systems/siege";
```
(merge with the existing `startDay` import line if present).

In `step()`, extend the outcome handling (the current block only handles `"dawn"`):
```ts
    const outcome = stepSim(s, 1 / CONFIG.simHz);
    if (outcome === "dawn") {
      const payouts = sysDawn(s);
      for (const { pid, salvage } of payouts) {
        if (salvage <= 0) continue;
        const peer = [...this.peers.values()].find((p) => p.decided && p.pid === pid);
        if (peer) this.send(peer.ws, { t: "banked", salvage });
      }
    } else if (outcome === "reset") {
      // fortress fell → rebuild to a fresh Day-1. Communal only; per-player SALVAGE is client meta.
      // (M-B will persist the settled Day-1 here.)
      resetArena(s);
    }
    // "breached"/"night"/null need no DO reaction — the frozen tableau keeps broadcasting and the
    // client derives the beat + reset from the synced phase edge.
```

- [ ] **Step 2: Typecheck + build the worker + game**

Run: `bun run typecheck && bun run build`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `bun run test`
Expected: PASS (all existing + new tests).

- [ ] **Step 4: Commit**

```bash
git add worker/arena.ts
git commit -m "feat(2b②-A): DO reacts to stepSim 'reset' → resetArena"
```

- [ ] **Step 5: Feel-gate (blocking, manual — record the result honestly)**

Run `bun run dev:coop`, connect (Start → `.../arena/MAIN`). Confirm:
1. **Breach fires:** stop defending during a night and let the interior fill; a breach actually triggers (does not require a crowd — solo-reachable with `breachZombies: 14`; if unreachable solo, lower the constant and note it).
2. **The beat reads:** the `breached` phase shows a "FORTRESS FALLEN" banner + the world freezes (bodies/zombies stall) for ~3s — reads as a horror payoff, not a hang.
3. **Clean reset:** the world cuts to a fresh Day-1 with **no mass-kill/mass-spawn fx burst** and no spurious DAY banner, for a player present through the reset. Then open a second client mid-reset and after Day-1 to confirm a fresh joiner sees a coherent Day-1.
4. **Cycle continues:** Day-1 proceeds normally (day/night, shop, respawn all still work).

If any of 1-3 fails on feel, tune `breachZombies`/`breachSustain`/`breachedDuration`/`resettingDuration` in `CONFIG.siege` and re-run. This gate blocks "M-A done".

---

## Self-Review (completed against the spec)

- **Spec coverage:** §M-A.1 (Task 1 SiegePhase), §M-A.2 breach detection (Tasks 1: predicate + `HW`/`HH` export + `breachT` owner in sysSiege night branch), §M-A.3 state machine + freeze (Task 2) + `"reset"` handler/`resetArena` (Tasks 3, 7) + 2-bit phase/PROTOCOL bump (Task 4), §M-A.4 two-edge client (Tasks 5 `siegeEdgeCue`/`isArenaResetEdge`, 6 client wiring), §M-A.5 meta/joins (no code — joins during resetting use the unchanged `spawnFresh`; meta is client localStorage, untouched), feel-gate (Task 7 Step 5). Testing section items map to Tasks 1/2/3/4/5.
- **Correction folded in vs the spec's M-A.4 prose:** the client `resetNet` fires on the **`resetting → day` edge** (`isArenaResetEdge`), not `breached → resetting` — because the DO rebuilds the world (the entity-id churn) atomically on the resetting→day1 transition; through `breached` and `resetting` the frozen tableau's entities are still present, so there is no churn to suppress until day-1. The spec's §M-A.3 "`"reset"` handler → startDay on resetting-elapse" already implies this; §M-A.4's edge label is superseded by this plan.
- **Placeholder scan:** none — every code step carries full code.
- **Type consistency:** `SiegePhase` union, `sysSiege`/`stepSim` return union `"night"|"dawn"|"breached"|"reset"|null`, `isFortressBreached(indoorCount)`, `enterBreached(state)`, `resetArena(state)`, `isArenaResetEdge(prev,next)`, `PHASE_ORDER`, `CONFIG.siege.{breachZombies,breachSustain,breachedDuration,resettingDuration}`, `State.breachT`, exported `HW`/`HH` — all consistent across tasks.

## Out of scope (M-B, next plan)

Persistence: `Arena` constructor + `ctx.storage`, the `CycleBlob` KV format, phase-boundary/last-leave writes, `blockConcurrencyWhile` cold-start thaw (with the phaseT/caches-preserving re-arm — NOT `startDay`/`startNight`), empty-arena hibernate. The `resetArena` call in Task 7 is where M-B will add the settled-Day-1 persist write.
