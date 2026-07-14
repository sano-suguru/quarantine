# DO Server 2b② Milestone B — Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DO-authoritative arena survive sleep and restarts — persist the communal cycle state to Durable Object storage at cycle boundaries and when the arena empties, and reconstruct it on the next cold start, so an empty arena freezes (and stops billing) and a worker deploy / eviction resumes from the last boundary instead of resetting to Day 1.

**Architecture:** A single small `CycleBlob` (communal fields only) is written via the DO storage KV API. The `Arena` DO gains a constructor that `blockConcurrencyWhile`-loads the blob into an in-memory `saved` cache on cold start; `stop()` refreshes that cache (and storage) before nulling state; `ensureRunning()` reconstructs from the cache when present, else starts a fresh Day-1. Thaw re-arms the current phase's spawner WITHOUT `startDay`/`startNight` (those would overwrite the restored clock and re-stock caches). Per M-A's core insight, no connected client ever observes a freeze/thaw (the arena is empty during a freeze; a crash-thaw drops all clients, which re-join fresh), so there is no client-side work in M-B.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess`), Vitest (co-located `*.test.ts`, `node` env), the headless `sim/` closure, the `worker/` Cloudflare Durable Object (SQLite-backed, KV storage API), Biome, Bun.

## Global Constraints

Copied verbatim from the spec (`docs/superpowers/specs/2026-07-14-do-server-2b2-persistence-design.md` §M-B) and the CF grounding — every task's requirements implicitly include these:

- **Communal-only persistence.** Persist/restore exactly `day`, `phase`, `phaseT`, `salvageBanked`, `kills`, `barricades[].hp`, `caches[].looted`. **Do NOT persist** per-player bodies/gear/money/wlevel, `owned`/`unlockedCards` (DO-side `owned` is always starters — `unlockProvider()` returns `{}` server-side), `caches[].searchT` (transient), `breachT`/`stalker`/`nextId`, or any ephemeral entity (zombies/bullets/pickups/particles/decals). Players spawn fresh on join, exactly as today.
- **Never persist a `breached`/`resetting` phase.** The persist path is skipped while `phase` is `breached` or `resetting` (a transient, non-resumable beat). The blob always holds a `day` or `night` phase; thaw resumes to a coherent phase. A crash mid-beat thaws to the last `day`/`night` boundary.
- **Thaw must NOT call `startDay`/`startNight`.** Both overwrite `phaseT` and `startDay` calls `restockCaches` (which resets `looted`/`searchT`) — either would destroy the restored frozen clock and cache state. Re-arm only the ambient spawner (`startWave` for night / roamer seeding for day).
- **The DO never globally pauses** — `state.paused`/`state.inShop` never set server-side.
- **`sim/` stays headless** — no DOM/WebGL/audio/storage imports; enforced by `sim/tsconfig.json`. `CycleBlob` serialize/deserialize + the thaw re-arm are pure and live in `sim/`; all `ctx.storage` access lives in `worker/arena.ts`.
- **Storage write mechanics:** writes are fire-and-forget with `.catch(log)` — never `await` inside the synchronous `step()` loop. Writes are rare (phase boundaries are minutes apart); the output gate's held-until-durable delay adds at most a one-tick broadcast delay at a boundary — accepted.
- **Load must not throw out of `blockConcurrencyWhile`** (that aborts/resets the DO) — wrap in try/catch; on any failure (missing/corrupt/unknown-`schemaVersion`) fall back to "no saved state" → fresh Day-1.
- **No `!` non-null assertions** anywhere — CI runs `biome check --error-on-warnings`; `!` fails the lint gate. Use the repo's `as (typeof arr)[number]` cast style in tests and explicit `const x = arr[i]; if (x) …` guards in code.
- **Empty-arena hibernate = no extra code.** Once `stop()` clears the interval and sockets close, the DO satisfies the hibernation conditions and stops incurring duration billing; the next `fetch` cold-starts the constructor. The Hibernation WebSocket API is deliberately NOT adopted (standard WS API stays).

**CF facts (verified via Cloudflare docs):** `Arena` is already a SQLite-backed DO (`worker/wrangler.toml` migration v3 `new_sqlite_classes`), so `ctx.storage.get`/`put` (KV API) are available. Cold start reruns the constructor. `PRAGMA user_version` is unsupported → track schema via a `schemaVersion` field in the blob.

**Testing/commands:**
- One test file: `bunx vitest run <path>`. Full suite: `bun run test`.
- Typecheck (root): `bun run typecheck`. Worker typecheck (as CI runs it): `bunx tsc --noEmit --project worker/tsconfig.json`. Build: `bun run build`. Lint: `bun run lint`.

**This is Milestone B of 2b②. M-A (soft-reset) is merged.** M-B has no client changes.

---

## File Structure

- `sim/net/persist.ts` — NEW. `SCHEMA_VERSION`, `CycleBlob` type, `serializeCycle(state)`, `applyCycle(state, blob)`. Pure/headless.
- `sim/net/persist.test.ts` — NEW. Round-trip + field coverage + version stamp.
- `sim/systems/siege.ts` — MODIFY. Extract `seedRoamers(state)` from `startDay`; add `rearmThaw(state)`.
- `sim/systems/siege.test.ts` — MODIFY. Tests for `rearmThaw` (night arms wave without touching phaseT; day seeds roamers without touching caches).
- `worker/arena.ts` — MODIFY. Constructor + `ctx.storage` + `saved` cache + `load()`; `ensureRunning` reconstruct-or-fresh; `persist()`; wire persist into `step()` boundaries + `stop()`.
- (No `game/` changes — M-B is server-only.)

---

## Task 1: `CycleBlob` + serialize/deserialize (pure)

The persisted shape and its pure round-trip, in a new headless module.

**Files:**
- Create: `sim/net/persist.ts`
- Test: `sim/net/persist.test.ts`

**Interfaces:**
- Produces:
  - `SCHEMA_VERSION: number` (start at `1`)
  - `interface CycleBlob { schemaVersion: number; day: number; phase: SiegePhase; phaseT: number; salvageBanked: number; kills: number; barricades: number[]; caches: boolean[]; }`
  - `serializeCycle(state: State): CycleBlob`
  - `applyCycle(state: State, blob: CycleBlob): void` — overlays the blob's communal fields onto an existing (freshly `newState()`d) state; index-aligned `barricades[i].hp` / `caches[i].looted`.

- [ ] **Step 1: Write the failing test**

Create `sim/net/persist.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { newState } from "../state";
import { CONFIG } from "../config";
import { SCHEMA_VERSION, serializeCycle, applyCycle } from "./persist";

describe("serializeCycle", () => {
  it("captures the communal fields and stamps the schema version", () => {
    const s = newState();
    s.day = 5;
    s.phase = "night";
    s.phaseT = 12.5;
    s.salvageBanked = 240;
    s.kills = 88;
    const b0 = s.barricades[0] as (typeof s.barricades)[number];
    b0.hp = 3;
    const c0 = s.caches[0] as (typeof s.caches)[number];
    c0.looted = true;

    const blob = serializeCycle(s);
    expect(blob.schemaVersion).toBe(SCHEMA_VERSION);
    expect(blob.day).toBe(5);
    expect(blob.phase).toBe("night");
    expect(blob.phaseT).toBe(12.5);
    expect(blob.salvageBanked).toBe(240);
    expect(blob.kills).toBe(88);
    expect(blob.barricades.length).toBe(s.barricades.length);
    expect(blob.barricades[0]).toBe(3);
    expect(blob.caches.length).toBe(s.caches.length);
    expect(blob.caches[0]).toBe(true);
  });
});

describe("applyCycle", () => {
  it("round-trips the communal state onto a fresh state", () => {
    const src = newState();
    src.day = 7;
    src.phase = "night";
    src.phaseT = 9;
    src.salvageBanked = 100;
    src.kills = 42;
    (src.barricades[1] as (typeof src.barricades)[number]).hp = 17;
    (src.caches[0] as (typeof src.caches)[number]).looted = true;
    const blob = serializeCycle(src);

    const dst = newState(); // fresh: day 1, full barricades, unlooted caches
    applyCycle(dst, blob);

    expect(dst.day).toBe(7);
    expect(dst.phase).toBe("night");
    expect(dst.phaseT).toBe(9);
    expect(dst.salvageBanked).toBe(100);
    expect(dst.kills).toBe(42);
    expect((dst.barricades[1] as (typeof dst.barricades)[number]).hp).toBe(17);
    expect((dst.caches[0] as (typeof dst.caches)[number]).looted).toBe(true);
    // untouched communal defaults remain
    expect((dst.barricades[0] as (typeof dst.barricades)[number]).hp).toBe(CONFIG.siege.boardMaxHp);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run sim/net/persist.test.ts`
Expected: FAIL — module `./persist` not found.

- [ ] **Step 3: Implement `sim/net/persist.ts`**

```ts
import type { SiegePhase, State } from "../types";

/** Bump when CycleBlob's shape changes; the loader treats an unknown version as "no saved state". */
export const SCHEMA_VERSION = 1;

/**
 * The persisted communal cycle (2b②). Communal-only: no per-player bodies/economy, no ephemeral
 * entities, no transient detection state. Players spawn fresh on join; per-player SALVAGE/unlocks
 * are client localStorage. See the M-B spec for why owned/searchT/breachT/stalker/nextId are excluded.
 */
export interface CycleBlob {
  schemaVersion: number;
  day: number;
  phase: SiegePhase;
  phaseT: number;
  salvageBanked: number;
  kills: number;
  barricades: number[]; // hp per opening, index-aligned to HOME.openings (newState order)
  caches: boolean[]; // looted per cache, index-aligned to newState() caches
}

export function serializeCycle(state: State): CycleBlob {
  return {
    schemaVersion: SCHEMA_VERSION,
    day: state.day,
    phase: state.phase,
    phaseT: state.phaseT,
    salvageBanked: state.salvageBanked,
    kills: state.kills,
    barricades: state.barricades.map((b) => b.hp),
    caches: state.caches.map((c) => c.looted),
  };
}

/** Overlay a blob's communal fields onto an already-freshly-built state (from newState()). */
export function applyCycle(state: State, blob: CycleBlob): void {
  state.day = blob.day;
  state.phase = blob.phase;
  state.phaseT = blob.phaseT;
  state.salvageBanked = blob.salvageBanked;
  state.kills = blob.kills;
  blob.barricades.forEach((hp, i) => {
    const bar = state.barricades[i];
    if (bar) bar.hp = hp;
  });
  blob.caches.forEach((looted, i) => {
    const c = state.caches[i];
    if (c) c.looted = looted;
  });
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run sim/net/persist.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add sim/net/persist.ts sim/net/persist.test.ts
git commit -m "feat(2b②-B): CycleBlob + serializeCycle/applyCycle (communal-only persistence shape)"
```

---

## Task 2: `seedRoamers` extraction + `rearmThaw` (pure)

The thaw re-arm that restores the phase's ambient horde WITHOUT disturbing the restored clock/caches.

**Files:**
- Modify: `sim/systems/siege.ts` (extract `seedRoamers`; `startDay` calls it; add `rearmThaw`)
- Test: `sim/systems/siege.test.ts`

**Interfaces:**
- Consumes: `startWave(state, n)` (`sim/systems/wave.ts`), `spawnZombie` (already imported in siege.ts), `CONFIG.siege.roamersPerDay`.
- Produces:
  - `seedRoamers(state: State): void` — seeds `CONFIG.siege.roamersPerDay` wanderers (the loop lifted verbatim from `startDay`).
  - `rearmThaw(state: State): void` — `phase==="night"` → `startWave(state, state.day)`; `phase==="day"` → `seedRoamers(state)`; touches neither `phaseT` nor `caches`.

- [ ] **Step 1: Write the failing test**

Add to `sim/systems/siege.test.ts` (reuse the file's existing imports/helpers; import `rearmThaw`, `startWave` as needed):
```ts
import { rearmThaw } from "./siege";

describe("rearmThaw", () => {
  it("night: arms the wave without touching phaseT or caches", () => {
    const s = newState();
    s.phase = "night";
    s.day = 4;
    s.phaseT = 20;
    (s.caches[0] as (typeof s.caches)[number]).looted = true;
    rearmThaw(s);
    expect(s.phaseT).toBe(20); // clock preserved
    expect((s.caches[0] as (typeof s.caches)[number]).looted).toBe(true); // caches preserved
    expect(s.wave.def).not.toBeNull(); // wave armed (startWave ran)
    expect(s.zombies.length).toBe(0); // startWave arms the spawner; it doesn't spawn synchronously
  });

  it("day: seeds roamers without touching phaseT or caches", () => {
    const s = newState();
    s.phase = "day";
    s.phaseT = 15;
    (s.caches[0] as (typeof s.caches)[number]).looted = true;
    rearmThaw(s);
    expect(s.phaseT).toBe(15);
    expect((s.caches[0] as (typeof s.caches)[number]).looted).toBe(true);
    expect(s.zombies.length).toBe(CONFIG.siege.roamersPerDay);
  });
});
```
(If `s.wave.def` is not the right "armed" signal, assert against whatever `startWave` sets — read `sim/systems/wave.ts` `startWave` and match its observable effect; the intent is "the night spawner is armed, phaseT and caches are untouched.")

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run sim/systems/siege.test.ts`
Expected: FAIL — `rearmThaw` not exported.

- [ ] **Step 3: Extract `seedRoamers` and add `rearmThaw`**

In `sim/systems/siege.ts`, refactor `startDay` to call a new `seedRoamers` (behavior identical), and add `rearmThaw`:
```ts
/** Seed the day's sparse wanderers. Extracted from startDay so thaw can re-seed without
 *  re-running startDay's phaseT reset + cache restock. */
export function seedRoamers(state: State): void {
  for (let i = 0; i < CONFIG.siege.roamersPerDay; i++) {
    const type = i % 4 === 3 ? "runner" : "walker";
    spawnZombie(state, type, 1, 1, { chasing: false, aroundPlayer: false });
  }
}

export function startDay(state: State): void {
  state.phase = "day";
  state.phaseT = CONFIG.siege.dayDuration;
  restockCaches(state);
  seedRoamers(state);
}

/**
 * Re-arm the current phase's ambient spawner after a thaw, WITHOUT touching the restored clock
 * or caches (startDay/startNight would overwrite phaseT and restock caches). Night: arm the wave.
 * Day: seed roamers. (breached/resetting are never persisted, so they never reach here.)
 */
export function rearmThaw(state: State): void {
  if (state.phase === "night") startWave(state, state.day);
  else if (state.phase === "day") seedRoamers(state);
}
```
(Confirm `startWave` is imported in `siege.ts` — it already imports from `./wave`; add `startWave` to that import if not present.)

- [ ] **Step 4: Run to verify pass**

Run: `bunx vitest run sim/systems/siege.test.ts`
Expected: PASS (the new `rearmThaw` tests plus all existing siege tests — `startDay` behavior is unchanged by the extraction).

- [ ] **Step 5: Typecheck + lint + commit**

```bash
bun run typecheck && bun run lint
git add sim/systems/siege.ts sim/systems/siege.test.ts
git commit -m "feat(2b②-B): extract seedRoamers + rearmThaw (phaseT/caches-preserving thaw re-arm)"
```

---

## Task 3: DO persistence wiring (constructor, load, freeze, thaw)

Wire storage into the `Arena` DO: cold-start load, boundary/last-leave writes, reconstruct-on-thaw. Verified by typecheck (root + worker) + build + full suite + the robustness gate (DO code is not unit-tested, per project discipline).

**Files:**
- Modify: `worker/arena.ts`

**Interfaces:**
- Consumes: `serializeCycle`/`applyCycle`/`CycleBlob`/`SCHEMA_VERSION` (Task 1), `rearmThaw` (Task 2), existing `newState`/`startDay`.

- [ ] **Step 1: Add the constructor, storage handle, `saved` cache, and `load()`**

In `worker/arena.ts`:
- Add imports:
```ts
import { type CycleBlob, SCHEMA_VERSION, applyCycle, serializeCycle } from "../sim/net/persist";
import { rearmThaw, resetArena, startDay } from "../sim/systems/siege";
```
(merge `rearmThaw` into the existing `siege` import line).
- Add fields + constructor to the `Arena` class:
```ts
  private ctx: DurableObjectState;
  private saved: CycleBlob | null = null;

  constructor(ctx: DurableObjectState, _env: unknown) {
    this.ctx = ctx;
    // Cold start: hydrate the frozen cycle before any request is processed. Must not throw
    // (that would abort the DO) — a missing/corrupt/stale blob just means "fresh Day-1".
    ctx.blockConcurrencyWhile(async () => {
      try {
        const blob = await ctx.storage.get<CycleBlob>("cycle");
        this.saved = blob && blob.schemaVersion === SCHEMA_VERSION ? blob : null;
      } catch {
        this.saved = null;
      }
    });
  }
```

- [ ] **Step 2: Reconstruct-or-fresh in `ensureRunning`**

Replace the `if (!this.state) { … }` block in `ensureRunning()`:
```ts
    if (!this.state) {
      const s = newState();
      s.running = true;
      if (this.saved) {
        applyCycle(s, this.saved); // restore the frozen communal cycle (day/phase/phaseT/…)
        rearmThaw(s); // re-arm the phase's spawner WITHOUT touching restored phaseT/caches
      } else {
        startDay(s); // brand-new arena → fresh Day-1
      }
      this.state = s;
    }
```
(`this.saved` stays set; it is refreshed by `persist()` and only read while `state` is null.)

- [ ] **Step 3: Add `persist()` and call it at boundaries + last-leave**

Add a method:
```ts
  /** Snapshot the communal cycle to the in-memory cache + DO storage. Skipped during the
   *  transient breached/resetting beat (never resume into it). Fire-and-forget: the sync step
   *  loop must not await; a rare one-tick broadcast delay at a boundary is acceptable. */
  private persist(): void {
    const s = this.state;
    if (!s || s.phase === "breached" || s.phase === "resetting") return;
    this.saved = serializeCycle(s);
    this.ctx.storage.put("cycle", this.saved).catch((e) => console.log("[arena] persist failed", e));
  }
```
In `step()`, the `if (outcome === "dawn") { … sysDawn … } else if (outcome === "reset") { resetArena(s); }` block **already exists** (added in M-A) — DO NOT re-add or duplicate it. Add exactly **one new line** immediately after that existing block (before the existing `clearFx(s);` call):
```ts
    if (outcome === "dawn" || outcome === "night" || outcome === "reset") this.persist();
```
This captures the post-transition state: `"night"` is returned the frame `startNight` already ran (state is night, `phaseT = nightDuration`); `"dawn"` after `sysDawn` (day++/`startDay`); `"reset"` after `resetArena` (Day-1). `"breached"`/`null` don't persist (and `persist()` itself also guards breached/resetting). The one-line addition is the entire change to `step()`'s outcome handling.

- [ ] **Step 4: Persist on last-leave in `stop()`**

In `stop()`, persist the live state BEFORE nulling it (and drop the stale comment):
```ts
  private stop(): void {
    this.persist(); // freeze the cycle to storage before discarding in-memory state
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    this.state = null;
    this.tick = 0;
    …unchanged (metrics reset, peers.clear)…
  }
```
Replace the old `this.state = null; // 2a: … (persistence = 2b)` comment accordingly.

- [ ] **Step 5: Verify (all must pass)**

```bash
bun run typecheck
bunx tsc --noEmit --project worker/tsconfig.json
bun run build
bun run test
bun run lint
```
Expected: all pass, 0 lint warnings. If `DurableObjectState` is not resolved, confirm `worker/tsconfig.json` pulls in `@cloudflare/workers-types` (it already must, since the DO uses `WebSocketPair`/`Response`); do not add a new dependency.

- [ ] **Step 6: Commit**

```bash
git add worker/arena.ts
git commit -m "feat(2b②-B): DO persistence — cold-start load, boundary/last-leave writes, thaw reconstruct"
```

- [ ] **Step 7: Robustness gate (blocking, manual — record results honestly)**

**Prerequisite:** confirm `wrangler dev` persists local storage across a restart — recent wrangler defaults to a `.wrangler/state` dir; if the resume can't be observed, pass `--persist-to`. Without persistence on, the restart test proves nothing.

With `bun run dev:coop`:
1. **Restart-resume:** play a few days (let it reach day 2-3, damage some barricades), then Ctrl-C and restart the worker mid-day. Reconnect to the same arena code and confirm it resumes at the last phase boundary (day count, barricade hp, SALVAGE watermark) — NOT Day 1.
2. **Freeze/rejoin-resume:** solo-play to day 2+, leave (close the tab), wait, then rejoin the same code. Confirm the day/world resumed (not reset to Day 1), and the clock did not advance while you were gone.
3. **Fresh arena:** connect to a brand-new arena code and confirm it still starts at Day 1.
4. **Post-reset persist:** trigger a breach → after the Day-1 rebuild, restart the worker and confirm it resumes at the reset Day-1 (not the pre-breach day).

If any fails, debug before declaring M-B done. This gate blocks "M-B complete".

---

## Self-Review (completed against the spec §M-B)

- **Spec coverage:** cold-start load + `blockConcurrencyWhile` (Task 3 Step 1); `CycleBlob` KV format, communal-only, excludes owned/searchT/per-player (Task 1); write cadence phase-boundary + last-leave, skip breached/resetting (Task 3 Steps 3-4); thaw reconstruct without `startDay`/`startNight` (Task 2 `rearmThaw` + Task 3 Step 2); empty-hibernate = no extra code (the existing `stop()` already clears the interval + peers; adding the persist is the only change); load-failure → fresh Day-1 (Task 3 Step 1 try/catch + version guard). §M-B's "grace interaction" and "output-gate" notes are honored by writing only in `stop()` (after grace, when `peers.size===0`) and by fire-and-forget.
- **Placeholder scan:** none — every code step carries full code.
- **Type consistency:** `CycleBlob`/`SCHEMA_VERSION`/`serializeCycle`/`applyCycle` (Task 1) consumed verbatim by Task 3; `rearmThaw`/`seedRoamers` (Task 2) consumed by Task 3; `this.saved: CycleBlob | null`, `this.ctx: DurableObjectState`. Blob field names match `State` fields.
- **No client work** — confirmed against M-A's core insight (no connected client observes a freeze/thaw). No `game/` files touched.

## Out of scope (later sub-projects)

Matchmaking/arena pooling (keeps `idFromName`), DO-side leaderboard submission, per-player progression persistence (needs account identity), delta/partial snapshots. The `breached → resetting` beat and Day-1 rebuild already shipped in M-A.
