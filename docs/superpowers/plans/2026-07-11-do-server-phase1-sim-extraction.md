# DO Server — Phase 1: `sim/` Extraction + Event-Buffer Seam — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a pure, import-clean `sim/` module (the shared simulation truth for both the browser client and the future DO server), routing all audio/fx cues through a discrete `state.fxEvents` buffer, with **single-player feel byte-for-byte unchanged** and CI green.

**Architecture:** Sever the sim's hidden dependencies on `Audio`/`renderer` at the source. Systems stop calling `Audio.*`/`fx*()` directly and instead push discrete `FxEvent`s into `state.fxEvents`; a client-side `drainFxEvents(state)` maps them to the existing audio + particle calls. Single-player drains its own buffer each frame (identical cues); the DO (Phase 2) will serialize the buffer into snapshots and never render. Then physically relocate the pure closure into a top-level `sim/` with its own no-DOM `tsconfig.json`, so the boundary is compiler-enforced.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Bun, Vite, Vitest, Biome. No new dependencies.

**Scope:** This is **Phase 1 of sub-project 2a**. It introduces **no** transport, DO, or WebSocket code, and does **not** remove method C. Those land in the Phase 2 plan (authored after this phase is green). Spec: `docs/superpowers/specs/2026-07-11-do-authoritative-server-design.md` (§2, §Sequencing).

## Global Constraints

- **Single-player must stay feel-unchanged** throughout every task (the CLAUDE.md invariant). The `single` frame path in `main.ts` must produce the same cues, same frame.
- **`sim/` imports nothing from `game/engine/audio`, `game/engine/renderer`, `game/input`, `game/ui`, or any DOM/WebAudio global.** By the end, `sim/` type-checks under `lib: ["ES2022"]` (no DOM).
- **Data-driven, no special-case debt** (CLAUDE.md): the event buffer is the one seam; do not add per-cue bespoke branches outside `drainFxEvents`.
- **Swap-and-pop array removal**, world-space coords, mutable data types — existing conventions unchanged.
- **TDD:** pure logic (event emission, buffer helpers, snapshot round-trip) is unit-tested with Vitest; the effect sink (`drainFxEvents`) and feel are validated by playtest, not unit tests.
- Tests co-located as `*.test.ts`. Run `bun run typecheck`, `bun run test`, `bun run lint` before each commit; they are the pre-push gate.

## File Structure

Phase 1 works in two stages — **behavioral seam first (files stay in place), physical relocation last** — so the risky mechanical move happens only after behavior is proven.

- `game/types.ts` — add the `FxEvent` union + `fxEvents` field on `State`. (Later moves to `sim/`.)
- `game/state.ts` — initialize `fxEvents: []` in `newState()`; add pure `pushFx`/`clearFx` helpers (or place in a small `game/sim/events.ts`; see Task 1).
- `game/fx-drain.ts` **(new)** — `drainFxEvents(state)`: the client-side sink mapping each `FxEvent` to `Audio.*` + `fx*()`. Imports `Audio`/`fx`/`renderer` — **stays in `game/`, never enters `sim/`.**
- `game/systems/{bullets,ai,player,pickups,feel,stalker,assist,deployables}.ts` — replace `Audio.*`/`fx*()` calls with `pushFx(...)`.
- `game/game.ts` — replace `Audio.waveStart()`/`Audio.dawn()` transition calls + the `audioAmbience` battery `Audio.lightDie()` path with events; change `update()` to `update(state, dt)`; remove the inline `audioAmbience(dt)` call from the sim core.
- `game/main.ts` — call `drainFxEvents(state)` in the `single` frame path after the `update()` accumulator loop.
- `game/engine/shapes.ts` **(new)** — the `SHAPE` enum, moved out of `renderer.ts`; both `renderer.ts` and `data/enemies.ts` import it here.
- **`sim/`** (new top-level dir, created in Task 11) — the relocated pure closure + `sim/tsconfig.json`.

---

## Task 1: `FxEvent` types + buffer + pure helpers

**Files:**
- Modify: `game/types.ts` (add `FxEvent`, extend `State`)
- Create: `game/sim/events.ts` (pure `pushFx`/`clearFx`)
- Modify: `game/state.ts` (init `fxEvents`)
- Test: `game/sim/events.test.ts`

**Interfaces:**
- Produces: `type FxEvent` (discriminated union, `t` tag); `State.fxEvents: FxEvent[]`; `pushFx(state: State, e: FxEvent): void`; `clearFx(state: State): void`.
- The union starts minimal and grows as systems are converted (Tasks 4–9). Initial variants cover the combat core:

```ts
// carried data mirrors what today's call sites pass; visuals the client can
// reconstruct from tables (enemy type → color/glow/sprite) are referenced by
// index/id, not duplicated — keeps the event wire-friendly for Phase 2.
export type FxEvent =
  | { t: "kill"; x: number; y: number; type: string; big: boolean; dir: number; radius: number; hitDir: number }
  | { t: "impact"; x: number; y: number; ang: number; color: [number, number, number]; intensity: number }
  | { t: "hit"; x: number; y: number }
  | { t: "hurt"; x: number; y: number; local: boolean }
  | { t: "muzzle"; x: number; y: number; ang: number; color: [number, number, number]; weapon: string; melee: boolean }
  | { t: "audio"; cue: string; arg?: number | string };
```

- [ ] **Step 1: Write the failing test**

```ts
// game/sim/events.test.ts
import { describe, expect, it } from "vitest";
import { newState } from "../state";
import { clearFx, pushFx } from "./events";

describe("fxEvents buffer", () => {
  it("starts empty", () => {
    expect(newState().fxEvents).toEqual([]);
  });
  it("pushFx appends; clearFx empties", () => {
    const s = newState();
    pushFx(s, { t: "hit", x: 1, y: 2 });
    pushFx(s, { t: "hurt", x: 3, y: 4, local: true });
    expect(s.fxEvents).toHaveLength(2);
    clearFx(s);
    expect(s.fxEvents).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- events.test.ts`
Expected: FAIL — `Cannot find module './events'` and `fxEvents` missing on `State`.

- [ ] **Step 3: Add the type + field + helpers**

In `game/types.ts`, add the `FxEvent` union (above) and, on the `State` interface, add:

```ts
  /** discrete per-tick cue buffer: systems push, the client drains to audio/fx (see sim/events.ts) */
  fxEvents: FxEvent[];
```

Create `game/sim/events.ts`:

```ts
import type { FxEvent, State } from "../types";

/** Append a discrete cue. Systems call this instead of Audio/fx directly. */
export function pushFx(state: State, e: FxEvent): void {
  state.fxEvents.push(e);
}

/** Empty the buffer (called after the client drains it / the DO serializes it). */
export function clearFx(state: State): void {
  state.fxEvents.length = 0;
}
```

In `game/state.ts` `newState()`, add `fxEvents: []` to the returned object (place near the other array fields, e.g. beside `particles`/`decals`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- events.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add game/types.ts game/sim/events.ts game/sim/events.test.ts game/state.ts
git commit -m "feat(sim): add fxEvents buffer + pushFx/clearFx helpers"
```

---

## Task 2: `drainFxEvents` sink + wire into the single-player frame

**Files:**
- Create: `game/fx-drain.ts`
- Modify: `game/main.ts` (single path)

**Interfaces:**
- Consumes: `State.fxEvents`, `clearFx` (Task 1); the existing `Audio.*` (`game/engine/audio`) and `fx*()` (`game/systems/fx`) functions.
- Produces: `drainFxEvents(state: State): void` — maps each buffered event to audio + particles, then clears the buffer. This is the client-side effect sink; it lives in `game/` and is the ONLY consumer of the buffer on the client.

At this point **no system emits events yet** (systems still call `Audio`/`fx` directly), so `drainFxEvents` handles an empty buffer as a no-op and single-player is unchanged. Each system-conversion task (4–9) adds its variant's mapping here and removes the direct calls, so cues never disappear.

- [ ] **Step 1: Create the drain sink (initial variants)**

```ts
// game/fx-drain.ts
import { Audio } from "./engine/audio";
import { ENEMY_TYPES } from "./data/enemies";
import { clearFx } from "./sim/events";
import { fxImpact, fxKill } from "./systems/fx";
import type { State } from "./types";

const GREY: [number, number, number] = [0.5, 0.5, 0.5];

/** Client-side sink: turn the tick's discrete cues into audio + particles, then clear. */
export function drainFxEvents(state: State): void {
  for (const e of state.fxEvents) {
    switch (e.t) {
      case "kill": {
        const ty = ENEMY_TYPES[e.type];
        fxKill(
          state, e.x, e.y,
          (ty?.color ?? GREY), (ty?.glow ?? GREY),
          e.big, true, ty?.sprite ?? "", e.dir, e.radius, e.hitDir,
        );
        Audio.kill(e.big);
        break;
      }
      case "impact":
        fxImpact(state, e.x, e.y, e.ang, e.color, e.intensity);
        break;
      case "hit":
        Audio.hit();
        break;
      // hurt / muzzle / audio variants are added by their system-conversion tasks
    }
  }
  clearFx(state);
}
```

- [ ] **Step 2: Wire it into the single-player frame**

In `game/main.ts`, the `single` branch of `frame()` currently runs the accumulator loop. Add the drain **after** the loop (so all sub-step events for the frame are consumed once), guarded to run only while the sim advanced:

```ts
    if (Net.mode === "single") {
      if (!settingsOpen) {
        rAcc += Math.min(dt, 0.1);
        if (live) localPlayer(st).input = sampleLocalInput(st);
        while (rAcc >= step) {
          update(step);
          rAcc -= step;
        }
        drainFxEvents(st); // consume the tick's cues → audio/particles
      }
    }
```

Add the import at the top of `main.ts`: `import { drainFxEvents } from "./fx-drain";`

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no new errors; `drainFxEvents` is called and defined).

- [ ] **Step 4: Manual smoke (single-player unchanged)**

Run: `bun run dev`, start a game. Kills still spark/sound (via the systems' existing direct calls). The empty-buffer drain is a no-op. **No regression** — this task only adds an unused-yet sink.

- [ ] **Step 5: Commit**

```bash
git add game/fx-drain.ts game/main.ts
git commit -m "feat(fx): add drainFxEvents sink, wired into the single-player frame (no-op until systems emit)"
```

---

## Task 3: Move `SHAPE` out of `renderer.ts`

**Files:**
- Create: `game/engine/shapes.ts`
- Modify: `game/engine/renderer.ts` (import `SHAPE` from `shapes`), `game/data/enemies.ts` (import from `shapes`)
- Test: none (pure move; typecheck is the gate)

**Interfaces:**
- Produces: `game/engine/shapes.ts` exporting the `SHAPE` enum (identical values).

This severs the one data→renderer edge (`data/enemies.ts:1` imports `SHAPE` from `renderer`), which would otherwise drag WebGL into `sim/`.

- [ ] **Step 1: Read the current `SHAPE` definition**

Run: `grep -n "SHAPE" game/engine/renderer.ts`
Note the exact enum/const definition (values must be preserved byte-for-byte — the wire/shader depends on the indices).

- [ ] **Step 2: Create `shapes.ts` with the moved definition**

Create `game/engine/shapes.ts` containing the exact `SHAPE` definition copied from `renderer.ts` (same name, same numeric values, same `export`).

- [ ] **Step 3: Re-point both importers**

In `renderer.ts`: remove the local `SHAPE` definition, add `import { SHAPE } from "./shapes";` (keep a re-export `export { SHAPE } from "./shapes";` if other modules import it from `renderer`).
In `data/enemies.ts:1`: change the import to `import { SHAPE } from "../engine/shapes";`.

- [ ] **Step 4: Typecheck + test + lint**

Run: `bun run typecheck && bun run test && bun run lint`
Expected: PASS. `grep -rn "SHAPE" game/data` shows enemies imports from `engine/shapes`, not `engine/renderer`.

- [ ] **Step 5: Commit**

```bash
git add game/engine/shapes.ts game/engine/renderer.ts game/data/enemies.ts
git commit -m "refactor(engine): move SHAPE enum to shapes.ts (sever data→renderer edge)"
```

---

## Task 4: Convert `bullets.ts` cues to events

**Files:**
- Modify: `game/systems/bullets.ts`, `game/fx-drain.ts`
- Test: `game/systems/bullets.test.ts` (extend)

**Interfaces:**
- Consumes: `pushFx` (Task 1), the `kill`/`impact`/`hit` `FxEvent` variants (Task 1).
- The three call sites (verified): `bullets.ts:28` `fxImpact` (wall), `bullets.ts:47` `fxImpact` (barricade), `bullets.ts:55` `Audio.hit()`, `bullets.ts:77` `fxKill`, `bullets.ts:78` `Audio.kill(big)`.

- [ ] **Step 1: Write the failing test — a kill emits a `kill` event**

```ts
// game/systems/bullets.test.ts — add
import { pushFx } from "../sim/events"; // (only if needed for setup)
it("killing a zombie pushes a kill event, not a direct Audio/fx call", () => {
  const s = newState();
  // craft a zombie at low hp and a bullet overlapping it (reuse existing test helpers
  // in this file for spawning a zombie + bullet; set zombie.hp = 1, bullet.dmg = 999)
  const z = spawnTestZombie(s, 100, 100); // existing helper pattern in this test file
  z.hp = 1;
  spawnTestBullet(s, 100, 100, 999);
  sysBullets(s, 1 / 60);
  const kills = s.fxEvents.filter((e) => e.t === "kill");
  expect(kills).toHaveLength(1);
  expect(kills[0]).toMatchObject({ x: expect.any(Number), y: expect.any(Number), big: false });
});
```

(If this test file has no spawn helpers, construct the zombie/bullet inline using `spawnZombie`/the `Bullet` shape already used elsewhere in the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- bullets.test.ts`
Expected: FAIL — `s.fxEvents` is empty (kill still calls `Audio.kill`/`fxKill` directly).

- [ ] **Step 3: Replace the call sites with `pushFx`**

In `bullets.ts`:
- `:28` `fxImpact(state, b.x, b.y, Math.atan2(b.vy, b.vx), STONE)` → `pushFx(state, { t: "impact", x: b.x, y: b.y, ang: Math.atan2(b.vy, b.vx), color: STONE, intensity: 0 })`.
- `:47` the barricade `fxImpact(...)` → the equivalent `pushFx({ t: "impact", ... })` carrying the same args.
- `:55` `Audio.hit()` → `pushFx(state, { t: "hit", x: z.x, y: z.y })`.
- `:77`–`:78` `fxKill(state, z.x, z.y, z.color, z.glow, big, true, sprite, Math.atan2(z.vy, z.vx), z.r, hitDir); Audio.kill(big);` → `pushFx(state, { t: "kill", x: z.x, y: z.y, type: z.type, big, dir: Math.atan2(z.vy, z.vx), radius: z.r, hitDir })`.

Remove the now-unused `import { Audio }` and `fxImpact`/`fxKill` imports from `bullets.ts`. Add `import { pushFx } from "../sim/events";`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- bullets.test.ts`
Expected: PASS. Also confirm `grep -n "Audio\.\|fxKill\|fxImpact" game/systems/bullets.ts` returns nothing.

- [ ] **Step 5: Verify the drain still produces the cue (single-player)**

`drainFxEvents` already handles `kill`/`impact`/`hit` (Task 2). `bun run dev`, kill a zombie: spark + kill sound still fire (now via the buffer). No double-fire, no silence.

- [ ] **Step 6: Commit**

```bash
git add game/systems/bullets.ts game/systems/bullets.test.ts game/fx-drain.ts
git commit -m "refactor(sim): bullets emit fx events instead of calling Audio/fx"
```

---

## Task 5: Convert `ai.ts` cues to events

**Files:**
- Modify: `game/systems/ai.ts`, `game/fx-drain.ts`
- Test: `game/systems/ai.test.ts` (extend, if the file exists; else assert via a focused new test)

**Interfaces:**
- Call sites (verified): `ai.ts:342` `fxImpact(...WOOD)` (barricade push), `ai.ts:353` `fxHurt(state, target.x, target.y)`, `ai.ts:359` `Audio.hurt()` (player hit by zombie).
- Adds the `hurt` variant mapping to `drainFxEvents`.

- [ ] **Step 1: Write the failing test — a zombie hitting the local player emits a `hurt` event**

```ts
// game/systems/ai.test.ts — add
it("a zombie melee on the local player pushes a hurt event", () => {
  const s = newState();
  const p = localPlayer(s);
  const z = spawnZombie(s, p.x, p.y, "walker"); // adjacent → melee connects
  z.attackCd = 0;
  sysAI(s, 1 / 60);
  const hurts = s.fxEvents.filter((e) => e.t === "hurt");
  expect(hurts.length).toBeGreaterThanOrEqual(1);
  expect(hurts[0]).toMatchObject({ local: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- ai.test.ts`
Expected: FAIL — no `hurt` event (still `fxHurt`/`Audio.hurt` direct).

- [ ] **Step 3: Replace the call sites**

In `ai.ts`:
- `:342` `fxImpact(state, z.x, z.y, Math.atan2(-push.dy, -push.dx), WOOD)` → `pushFx(state, { t: "impact", x: z.x, y: z.y, ang: Math.atan2(-push.dy, -push.dx), color: WOOD, intensity: 0 })`.
- `:353`–`:359` `fxHurt(state, target.x, target.y); ... Audio.hurt();` → `pushFx(state, { t: "hurt", x: target.x, y: target.y, local: target.id === state.localId })`. (The single `hurt` event carries both the blood and the local-only audio decision; `drainFxEvents` plays `Audio.hurt()` only when `local`.)

Remove unused `Audio`/`fxImpact`/`fxHurt` imports; add `pushFx`.

- [ ] **Step 4: Add the `hurt` mapping to `drainFxEvents`**

In `game/fx-drain.ts`, add the case (import `fxHurt` from `./systems/fx`):

```ts
      case "hurt":
        fxHurt(state, e.x, e.y);
        if (e.local) Audio.hurt();
        break;
```

- [ ] **Step 5: Run test + smoke**

Run: `bun run test -- ai.test.ts` → PASS. `grep -n "Audio\.\|fxImpact\|fxHurt" game/systems/ai.ts` → empty. `bun run dev`: getting hit still flashes blood + plays the hurt cue.

- [ ] **Step 6: Commit**

```bash
git add game/systems/ai.ts game/systems/ai.test.ts game/fx-drain.ts
git commit -m "refactor(sim): ai emits fx events (impact/hurt) instead of Audio/fx"
```

---

## Task 6: Convert `player.ts` cues to events

**Files:**
- Modify: `game/systems/player.ts`, `game/fx-drain.ts`, `game/types.ts` (extend `FxEvent` with the player variants)
- Test: `game/systems/player.test.ts`

**Interfaces:**
- Call sites (verified): heal `Audio.heal()` `:88,:107,:383` + `fxMote :102` + `fxActionBurst :106`; `Audio.switchWeapon() :151`; reload `Audio.reload() :161` / `Audio.reloadDone() :170`; `Audio.dryFire() :192` + `fxDust :162`; pickup `Audio.pickup() :369` + `fxDust :362` + `fxActionBurst :368`; repair `fxImpact :262,:396` + `fxDust :397` + `fxActionBurst :400` + `Audio.repair() :402`; mate-heal `fxMote :382`.
- Extend `FxEvent` with generic building blocks so player cues don't each need a bespoke variant:

```ts
  | { t: "dust"; x: number; y: number; n: number }
  | { t: "mote"; x: number; y: number; color: [number, number, number] }
  | { t: "burst"; x: number; y: number; color: [number, number, number]; ring: boolean }
```

Player audio one-shots (`heal`/`reload`/`reloadDone`/`switchWeapon`/`dryFire`/`pickup`/`repair`) use the generic `{ t: "audio"; cue }` variant.

- [ ] **Step 1: Write the failing test — reload pushes an audio event**

```ts
// game/systems/player.test.ts — add
it("starting a reload pushes an audio:reload event", () => {
  const s = newState();
  const p = localPlayer(s);
  p.ammo = 0; p.reserve[p.weapon] = 30; p.input = { ...emptyInput(), reload: true };
  sysPlayer(s, 1 / 60);
  expect(s.fxEvents.some((e) => e.t === "audio" && e.cue === "reload")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test -- player.test.ts` → FAIL (no audio event).

- [ ] **Step 3: Replace all `player.ts` call sites**

Map each site to a `pushFx`:
- `Audio.heal()` → `pushFx(state, { t: "audio", cue: "heal" })` (all three sites).
- `Audio.switchWeapon()` → `{ t: "audio", cue: "switchWeapon" }`; `Audio.reload()` → `{ cue: "reload" }`; `Audio.reloadDone()` → `{ cue: "reloadDone" }`; `Audio.dryFire()` → `{ cue: "dryFire" }`; `Audio.pickup()` → `{ cue: "pickup" }`; `Audio.repair()` → `{ cue: "repair" }`.
- `fxMote(state, X, Y, C)` → `{ t: "mote", x: X, y: Y, color: C }`; `fxActionBurst(state, X, Y, C, RING)` → `{ t: "burst", x: X, y: Y, color: C, ring: RING }`; `fxDust(state, X, Y, N)` → `{ t: "dust", x: X, y: Y, n: N }`; `fxImpact(...)` → `{ t: "impact", ... }` (same args).

Remove unused `Audio`/`fx*` imports from `player.ts`; add `pushFx`. **Do not** touch `integrateMovement` or any state math.

- [ ] **Step 4: Add the mappings to `drainFxEvents`**

Import `fxDust`, `fxMote`, `fxActionBurst` from `./systems/fx`. Add:

```ts
      case "dust": fxDust(state, e.x, e.y, e.n); break;
      case "mote": fxMote(state, e.x, e.y, e.color); break;
      case "burst": fxActionBurst(state, e.x, e.y, e.color, e.ring); break;
      case "audio":
        // map the cue string to the Audio one-shot
        (Audio as unknown as Record<string, (a?: unknown) => void>)[e.cue]?.(e.arg);
        break;
```

(If the dynamic `Audio[cue]` indexing trips `noImplicitAny`/lint, use an explicit `switch (e.cue)` over the known cues — `heal`/`reload`/`reloadDone`/`switchWeapon`/`dryFire`/`pickup`/`repair` — calling each `Audio.*` directly. Prefer the explicit switch; it is lint-clean and greppable.)

- [ ] **Step 5: Run test + smoke**

Run: `bun run test -- player.test.ts` → PASS. `grep -n "Audio\.\|fx[A-Z]" game/systems/player.ts` → empty. `bun run dev`: reload/heal/switch/pickup/repair all still sound + spark.

- [ ] **Step 6: Commit**

```bash
git add game/systems/player.ts game/systems/player.test.ts game/fx-drain.ts game/types.ts
git commit -m "refactor(sim): player emits fx events (audio/dust/mote/burst/impact)"
```

---

## Task 7: Convert `pickups.ts`, `assist.ts`, `deployables.ts`, `stalker.ts` cues to events

**Files:**
- Modify: `game/systems/{pickups,assist,deployables,stalker}.ts`, `game/fx-drain.ts`
- Test: `game/systems/pickups.test.ts` (extend)

**Interfaces:**
- Call sites (verified): `pickups.ts:59` `fxPickup` + `:60` `Audio.pickup()`; `assist.ts:39` `fxActionBurst`; `deployables.ts:62` `fxKill` + `:63` `fxImpact`; `stalker.ts:99` `fxHurt` + `:103` `Audio.hurt()`.
- Extend `FxEvent` with `{ t: "pickup"; x; y; glow: [number,number,number] }` for the pickup glow (or reuse `burst`). Deployable destruction uses `kill`; RTB uses `impact`. Stalker uses the existing `hurt`.

- [ ] **Step 1: Write the failing test — collecting a pickup pushes a pickup event**

```ts
// game/systems/pickups.test.ts — add
it("auto-collecting a pickup pushes a pickup event", () => {
  const s = newState();
  const p = localPlayer(s);
  spawnPickup(s, p.x, p.y, "ammo"); // within grab radius
  sysPickups(s, 1 / 60);
  expect(s.fxEvents.some((e) => e.t === "pickup")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails** — `bun run test -- pickups.test.ts` → FAIL.

- [ ] **Step 3: Replace the call sites**

- `pickups.ts`: `fxPickup(state, pk.x, pk.y, def.glow)` + `Audio.pickup()` → `pushFx(state, { t: "pickup", x: pk.x, y: pk.y, glow: def.glow })` (the drain plays both the glow fx and `Audio.pickup()`).
- `assist.ts:39` `fxActionBurst(...)` → `{ t: "burst", ... }` (same args).
- `deployables.ts:62` `fxKill(...)` → `{ t: "kill", ... }` with `type: ""`/`big: true` matching the current args (machine, no flesh sprite — carry `type: ""` and let the drain skip the sprite when empty); `:63` `fxImpact(...)` → `{ t: "impact", ... }`.
- `stalker.ts:99`–`:103` `fxHurt(...)` + `Audio.hurt()` → `pushFx(state, { t: "hurt", x: target.x, y: target.y, local: target.id === state.localId })`.

Remove unused imports; add `pushFx` to each file.

- [ ] **Step 4: Add the `pickup` mapping to `drainFxEvents`**

Import `fxPickup` from `./systems/fx`:

```ts
      case "pickup":
        fxPickup(state, e.x, e.y, e.glow);
        Audio.pickup();
        break;
```

Confirm the `kill` mapping handles `type: ""` (the `ENEMY_TYPES[""]` lookup returns undefined → `GREY`/no sprite, which matches the machine-destruction look).

- [ ] **Step 5: Run test + smoke** — `bun run test -- pickups.test.ts` → PASS. Grep each converted system for `Audio.`/`fx[A-Z]` → empty. `bun run dev`: pickups, revive burst, turret destruction, stalker grab all still fire.

- [ ] **Step 6: Commit**

```bash
git add game/systems/pickups.ts game/systems/assist.ts game/systems/deployables.ts game/systems/stalker.ts game/systems/pickups.test.ts game/fx-drain.ts game/types.ts
git commit -m "refactor(sim): pickups/assist/deployables/stalker emit fx events"
```

---

## Task 8: Convert `feel.ts` (fire feel) to events

**Files:**
- Modify: `game/systems/feel.ts`, `game/fx-drain.ts`
- Test: `game/systems/feel.test.ts` (create if absent)

**Interfaces:**
- `feel.ts` (`applyFireFeel`) is called by BOTH the sim (host/DO fire) AND client prediction (`client.ts` calls `applyFireFeel` for the local shot). Call sites: `:27` `Audio.melee()`, `:31` `fxMuzzle(...)`, `:33` `Audio.shot(p.weapon)`.
- After the split: `applyFireFeel` keeps the pure state mutation (recoil/muzzle/shake numbers) and pushes a `muzzle` event; it imports no `Audio`/`fx`. The `muzzle` event carries `weapon`+`melee` so the drain plays `Audio.shot(weapon)` or `Audio.melee()` and the muzzle particles.

- [ ] **Step 1: Write the failing test — firing pushes a muzzle event and still mutates recoil**

```ts
// game/systems/feel.test.ts
import { describe, expect, it } from "vitest";
import { effWeapon } from "../data/arsenal";
import { localPlayer } from "../engine/players";
import { newState } from "../state";
import { applyFireFeel } from "./feel";

describe("applyFireFeel", () => {
  it("pushes a muzzle event and applies recoil (no direct audio)", () => {
    const s = newState();
    const p = localPlayer(s);
    applyFireFeel(s, p, effWeapon(p, p.weapon));
    expect(s.fxEvents.some((e) => e.t === "muzzle")).toBe(true);
    expect(p.muzzle).toBeGreaterThan(0); // state mutation preserved
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun run test -- feel.test.ts` → FAIL.

- [ ] **Step 3: Replace the call sites in `feel.ts`**

- `:31` `fxMuzzle(state, tipX, tipY, p.aim, wd.color)` and `:27` `Audio.melee()` / `:33` `Audio.shot(p.weapon)` → a single `pushFx(state, { t: "muzzle", x: tipX, y: tipY, ang: p.aim, color: wd.color, weapon: p.weapon, melee: wd.melee })`.
- Keep every recoil/muzzle/shake state mutation exactly as-is.
- Remove `Audio`/`fxMuzzle` imports; add `pushFx`.

- [ ] **Step 4: Add the `muzzle` mapping to `drainFxEvents`**

Import `fxMuzzle` from `./systems/fx`:

```ts
      case "muzzle":
        if (e.melee) Audio.melee();
        else Audio.shot(e.weapon);
        if (!e.melee) fxMuzzle(state, e.x, e.y, e.ang, e.color);
        break;
```

(Match the current behavior: `fxMuzzle` fires for guns; melee has no muzzle spark. If melee currently draws a muzzle spark too, keep it — mirror the pre-change branch exactly.)

- [ ] **Step 5: Verify client prediction still hears its own shot**

`client.ts` calls `applyFireFeel` then reads `lp.muzzle`/recoil for prediction. It no longer plays audio via `applyFireFeel`. Add a drain of the local player's fire cue in the client path — but that is Phase 2 (client rewire). **For Phase 1, the client path is unchanged and still networked via method C; method-C clients already re-derive shot audio in `client.ts` `effects()`/prediction.** Confirm no Phase-1 regression: single-player fire (which now routes muzzle→drain) sounds correct.

- [ ] **Step 6: Run test + smoke** — `bun run test -- feel.test.ts` → PASS. `grep -n "Audio\.\|fxMuzzle" game/systems/feel.ts` → empty. `bun run dev`: firing/melee sounds + muzzle flash intact.

- [ ] **Step 7: Commit**

```bash
git add game/systems/feel.ts game/systems/feel.test.ts game/fx-drain.ts
git commit -m "refactor(sim): feel.ts splits — pure recoil/muzzle math + muzzle event"
```

---

## Task 9: Convert the `update()` transition + battery cues; lift `audioAmbience`

**Files:**
- Modify: `game/game.ts`
- Test: `game/game.test.ts` (create a focused test if absent)

**Interfaces:**
- Sites in `game.ts`: `:195` `Audio.waveStart()` (on `"night"`), `:199` `Audio.dawn()` (on `"dawn"`), `:242` `Audio.lightDie()` (battery→0, inside `audioAmbience`). Add `{ t: "audio"; cue }` events `"waveStart"`/`"dawn"`/`"lightDie"` (and the NIGHT/DAY banner as a `{ t: "announce"; label: string; day: number }` event so the client shows it — extend `FxEvent`).
- After this task the sim core (`update`) is free of `Audio`; `audioAmbience` moves entirely to the client (`clientAmbience` already exists and is the client's ambience path).

- [ ] **Step 1: Write the failing test — the night transition pushes a nightfall cue**

```ts
// game/game.test.ts — focused
it("the dawn→night transition pushes waveStart + NIGHT announce events", () => {
  const s = newState();
  // drive sysSiege to the night edge (reuse the siege test setup: set phaseT to the
  // day length so sysSiege returns "night" this step)
  forceSiegeToNightEdge(s); // helper mirroring waves/siege tests
  update(s, 1 / 60);
  expect(s.fxEvents.some((e) => e.t === "audio" && e.cue === "waveStart")).toBe(true);
  expect(s.fxEvents.some((e) => e.t === "announce" && e.label === "NIGHT")).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (no events; also `update` signature changes in Task 10, so this test uses `update(s, dt)` — if Task 10 not yet done, temporarily call `update(dt)` and adjust in Task 10).

> Note: Tasks 9 and 10 touch the same function. If executing strictly in order, write this test against the current `update(dt)` signature and update the call in Task 10. Alternatively, do Task 10 first. The reviewer may merge 9+10 into one task if preferred.

- [ ] **Step 3: Replace the cue calls with events**

- `:195` `Audio.waveStart()` → `pushFx(state, { t: "audio", cue: "waveStart" })`.
- `:194` `announce("NIGHT", state.day)` → `pushFx(state, { t: "announce", label: "NIGHT", day: state.day })` (the client's drain calls `announce`).
- `:199` `Audio.dawn()` → `pushFx(state, { t: "audio", cue: "dawn" })`; likewise the DAY announce sites.
- `:242` `Audio.lightDie()` (in `audioAmbience`) → this moves with `audioAmbience` to the client (Step 4), so it stays an `Audio` call there — OR, since battery is per-player state synced in Phase 2, emit `{ t: "audio", cue: "lightDie" }` from the sim when a player's battery crosses 0. **Choose the event form** (consistent seam): emit it from the sim at the battery-zero edge (move that edge-detection out of `audioAmbience` into `sysPlayer`, pushing the event).

- [ ] **Step 4: Lift `audioAmbience` out of the sim core**

Remove the `audioAmbience(dt)` call from `update()` (`game.ts:191`). `audioAmbience` is a client-perception routine (dread/heartbeat/groan from `localPlayer`) — it belongs with `clientAmbience`. Confirm the single-player path drives ambience: `main.ts` single branch must call the client ambience routine each frame (today single-player gets ambience via `update`→`audioAmbience`; after the lift, call `clientAmbience(dt)` — or the shared ambience function — in the single branch, same as the client branch does). Wire it right after `drainFxEvents(st)` in the single branch.

- [ ] **Step 5: Add the `announce`/`waveStart`/`dawn`/`lightDie` mappings to `drainFxEvents`**

Extend the `audio` switch with `waveStart`/`dawn`/`lightDie` → `Audio.waveStart()`/`Audio.dawn()`/`Audio.lightDie()`, and add the `announce` case → `announce(e.label, e.day)` (import `announce` from `game.ts` or its UI module).

- [ ] **Step 6: Run test + smoke**

Run: `bun run test -- game.test.ts` → PASS. `grep -n "Audio\.\|audioAmbience(" game/game.ts` shows `Audio` only inside `clientAmbience`/`drainFxEvents`-adjacent client code, and `audioAmbience` is no longer called from `update()`. `bun run dev`: NIGHT/DAY banner + wave-start/dawn stings + battery-die cue + dread ambience all intact in single-player.

- [ ] **Step 7: Commit**

```bash
git add game/game.ts game/game.test.ts game/fx-drain.ts
git commit -m "refactor(sim): update() emits transition/battery events; audioAmbience lifted to the client"
```

---

## Task 10: `update(state, dt)` explicit signature

**Files:**
- Modify: `game/game.ts` (`update`, and its callers in `main.ts`), `game/net/host.ts` (host tick caller)
- Test: existing tests updated to `update(state, dt)`

**Interfaces:**
- Produces: `export function update(state: State, dt: number): void` — no longer reads the module-level `getState()` singleton internally; the caller passes the state. `getState()` remains for `game/`'s own convenience (the singleton the browser client uses), but the sim function is parameterized.

- [ ] **Step 1: Change the signature**

In `game.ts`, change `export function update(dt: number)` → `export function update(state: State, dt: number)`. Inside, replace the implicit module `state` references so they use the parameter (the body already names the local `state`; ensure it binds to the parameter, not the module singleton — rename the module singleton accessor usage inside `update` to the param).

- [ ] **Step 2: Update callers**

- `main.ts` single branch: `update(step)` → `update(st, step)` (where `st = getState()`).
- `main.ts` host worker tick: `update(step)` → `update(getState(), step)`.
- Any test calling `update(dt)` → `update(s, dt)`.

- [ ] **Step 3: Typecheck + test + lint**

Run: `bun run typecheck && bun run test && bun run lint`
Expected: PASS. `bun run dev`: single-player behaves identically.

- [ ] **Step 4: Commit**

```bash
git add game/game.ts game/main.ts game/net/host.ts game/**/*.test.ts
git commit -m "refactor(sim): update(state, dt) — explicit state, no singleton read in the sim core"
```

---

## Task 11: Relocate the pure closure into `sim/` with a no-DOM tsconfig

**Files:**
- Create: `sim/tsconfig.json`; move the pure closure into `sim/`
- Modify: root `tsconfig.json` (reference/include `sim`), all import paths that crossed the boundary, `vite.config.ts` if a path alias is used
- Test: the full suite runs from the new locations

**Interfaces:**
- Produces: `sim/` containing `state.ts`, `types.ts`, `config.ts`, `systems/*`, `data/*`, `snapshot.ts`, `events.ts`, and the pure engine helpers (`math`, `geometry`, `spatialHash`, `players`, `steering`, `navfield`, `lights`, `fragment`), plus the `update` sim core. `sim/tsconfig.json` uses `lib: ["ES2022"]` (no DOM, no `@cloudflare/workers-types`).

> This is the mechanical, high-churn step. Do it **last**, after behavior is proven (Tasks 1–10), so any breakage here is purely structural (import paths), never behavioral. Consider doing it in a worktree.

- [ ] **Step 1: Create `sim/tsconfig.json`**

```jsonc
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "types": [],
    "noEmit": true
  },
  "include": ["."]
}
```

- [ ] **Step 2: Move the files**

`git mv` the pure closure into `sim/` preserving subdir structure (e.g. `git mv game/systems sim/systems`, `game/data sim/data`, `game/state.ts sim/state.ts`, `game/types.ts sim/types.ts`, `game/config.ts sim/config.ts`, `game/net/snapshot.ts sim/snapshot.ts`, `game/sim/events.ts sim/events.ts`, and the pure `game/engine/{math,geometry,spatialHash,players,steering,navfield,lights,fragment}.ts` → `sim/engine/`). Leave `game/engine/{audio,renderer,shapes,spriteAssets,...}` and `game/{fx-drain,game,main,input,ui}.ts` in `game/`.

- [ ] **Step 3: Rewire imports**

Update import specifiers across `game/` and `sim/` to the new paths. Use the compiler as the guide: run `bun run typecheck` and fix each unresolved path. `game/` imports the sim via relative paths (`../sim/...`) or a `@sim/*` alias if you add one to both `tsconfig.json` and `vite.config.ts` (relative is fewer moving parts — prefer it unless the depth is unwieldy).

- [ ] **Step 4: Add `sim` to the root project + typecheck the boundary**

Root `tsconfig.json` `include` already covers `game`; add `"sim"`. Then run the **boundary gate**:

```bash
bunx tsc --noEmit -p sim/tsconfig.json
```

Expected: PASS. **If it fails**, it has found a real DOM/Audio/renderer edge dragged into `sim/` — fix by moving the offending symbol to `game/` or severing the import (do NOT relax the `lib`). This is the compiler-enforced boundary doing its job.

- [ ] **Step 5: Full gate**

Run: `bun run typecheck && bun run test && bun run lint && bun run build`
Expected: all PASS. Vitest picks up the co-located tests at their new `sim/**` paths.

- [ ] **Step 6: Single-player feel playtest (the phase's acceptance gate)**

`bun run dev`. Play a full day→night→dawn cycle. Verify **byte-for-byte feel**: movement, fire/melee, kills (spark+shake+sound), hits, hurt, pickups, reload/switch, repair, NIGHT/DAY banners, wave-start/dawn stings, battery-die cue, dread ambience — all identical to before Phase 1. This is a feel gate, not a unit test; record the result honestly.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(sim): relocate the pure closure into top-level sim/ with a no-DOM tsconfig (compiler-enforced boundary)"
```

---

## Task 12: Extend the snapshot round-trip test for `fxEvents`

**Files:**
- Modify: `sim/snapshot.ts` (encode/decode `fxEvents`), `sim/snapshot.test.ts`

**Interfaces:**
- Consumes: `State.fxEvents`, `FxEvent` (Task 1+).
- Produces: `encodeSnapshot`/`decode` carry the tick's `fxEvents`; the round-trip test asserts events survive. This is the one **non-idempotent** payload (events must not be dropped) — Phase 2 relies on it, but the encode/decode + test land here since `snapshot.ts` is now in `sim/`.

> Phase-1 note: nothing consumes wire-carried events yet (no DO). This task only makes the snapshot format event-capable and proves the round-trip, so Phase 2 can send them without re-touching the format.

- [ ] **Step 1: Write the failing round-trip test**

```ts
// sim/snapshot.test.ts — add
it("round-trips fxEvents", () => {
  const s = newState();
  s.fxEvents.push({ t: "kill", x: 10, y: 20, type: "walker", big: false, dir: 1, radius: 12, hitDir: 0.5 });
  s.fxEvents.push({ t: "audio", cue: "dawn" });
  const back = decode(encodeSnapshot(s, 7));
  expect(back.fxEvents).toHaveLength(2);
  expect(back.fxEvents[0]).toMatchObject({ t: "kill", type: "walker" });
  expect(back.fxEvents[1]).toMatchObject({ t: "audio", cue: "dawn" });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`fxEvents` not in the decoded snapshot).

- [ ] **Step 3: Encode/decode `fxEvents`**

In `snapshot.ts`, add an events section: write a count (`u8`/`u16`), then per event a variant tag byte + its fields (quantize positions with the existing int16 helpers; strings via a small enum for `cue`/`type` using the existing `ENEMY_ORDER`-style index lists). Add `fxEvents` to the decoded `Snapshot` and to `captureSnapshot`/`applySnapshot` as appropriate (on decode, populate `snap.fxEvents`; `applySnapshot` leaves them for the client drain, it does not itself replay them).

- [ ] **Step 4: Run test to verify it passes** — `bun run test -- snapshot.test.ts` → PASS.

- [ ] **Step 5: Full gate + commit**

```bash
bun run typecheck && bun run test && bun run lint
git add sim/snapshot.ts sim/snapshot.test.ts
git commit -m "feat(sim): snapshot carries fxEvents (event-capable wire format + round-trip test)"
```

---

## Self-Review

**1. Spec coverage (§2 extraction items):**
- Event buffer + `drainFxEvents` → Tasks 1, 2, 4–9. ✓
- Sever `Audio`/`fx` from all sim systems → Tasks 4–8 (bullets, ai, player, pickups/assist/deployables/stalker, feel) + Task 9 (`update` transitions). ✓
- `update(state, dt)` explicit → Task 10. ✓
- Lift `audioAmbience` from the sim core → Task 9. ✓
- Relocate `SHAPE` → Task 3. ✓
- Top-level `sim/` + no-DOM tsconfig, compiler-enforced boundary → Task 11. ✓
- Snapshot event-capable + round-trip test → Task 12. ✓
- SP feel byte-for-byte + CI green (Global Constraints) → verified per task + Task 11 Step 6 gate. ✓
- **Out of scope (correctly):** transport, DO, WebSocket, method-C removal, reconcile retune → Phase 2 plan. ✓

**2. Placeholder scan:** No "TBD"/"handle appropriately". Test bodies are concrete; where a test needs an existing spawn helper, the step names the fallback (construct inline). Task 9 flags its ordering overlap with Task 10 explicitly rather than hand-waving.

**3. Type consistency:** `FxEvent` union grows monotonically (Tasks 1, 6, 7, 9) — variants added, never renamed. `pushFx`/`clearFx`/`drainFxEvents` names are stable across all tasks. `update(state, dt)` signature (Task 10) is reflected in Task 12's test calls. `SHAPE` keeps identical values (Task 3).

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-11-do-server-phase1-sim-extraction.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?** (Per your flow: first the plan goes to a rubber-duck blind-spot review, then we execute.)
