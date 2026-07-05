# Stalker Phase 1.5 — Phantom Perception Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fake perception cues — fleeting stalker-shaped silhouettes and non-localizable phantom footsteps — that fill the quiet of a stalker night with doubt while a real approach stays legible.

**Architecture:** A new render/audio-only module `game/systems/stalkerPhantom.ts` (sibling to `stalkerFx.ts`), driven from `game.ts:draw()` off the same `dread` value `stalkerFx` returns. Silhouettes ship first (Stage 1), phantom steps second (Stage 2). The real-footfall lockout is owned by `stalkerFx` (the footfall's firer). Nothing touches sim state, `state.particles`, or the snapshot — each co-op client re-derives its own phantoms locally, exactly like `darts`/`stalkerFx`.

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess), Vitest, WebGL2 renderer (`R.spriteQuad`/`R.glow`), procedural Web Audio (`game/engine/audio.ts`), Biome, `CONFIG` tuning tree.

**Spec:** `docs/superpowers/specs/2026-07-06-stalker-phantom-perception-design.md`

## Global Constraints

Every task's requirements implicitly include these (verbatim from the spec):
- **Render/audio-only.** No sim state mutated; nothing written to `state.zombies`/`state.stalker`/`state.particles` or any sim field; nothing added to the snapshot. Single-player stays byte-for-byte safe. Same guarantee as `darts` (module-level array in `game.ts`, not `state.particles`).
- **No hitbox, no damage, ever.** Fakes are perception distortion, not entities.
- **Net-agnostic.** `stalkerPhantom.ts` imports NOTHING from `game/net/`. Co-op clients re-derive locally from the already-synced `state.stalker` + local player.
- **Coverage-exclude** `game/systems/stalkerPhantom.ts` (feel code, like `stalkerFx.ts`/`ai.ts`/`fx.ts`).
- **Gate (identical to `stalkerFx` + a state filter):** phantoms run only when `state.stalker` is non-null AND `state.phase === "night"` AND `sk.state` is `"lull"` or `"aggro"` (exclude `"stagger"`/`"retreat"` — no phantom spam at tension-release beats). The `Stalker` type has **no `present` field**.
- **Fairness (Stage 2):** the phantom step is a fixed **centre pan**, a **flat low volume** (never distance-scaled), and a **distinct timbre** from `Audio.stalkerFootfall`; it is never paired with a real footfall, and it is suppressed while `stalkerFx`'s lockout is live.
- **Lockout owner:** `stalkerFx` sets the lockout when it fires the real footfall and exposes `phantomStepLocked(now)`. Do not duplicate `stalkerFx`'s footfall-interval logic.
- **Draw-side dt:** use the `ddt` game.ts already computes (`state.time` delta, clamped ≤ 0.1) for all life/timer updates — never `dt`.

---

### Task 1: `stalkerPhantom.ts` core — silhouettes + pure rate helper

Creates the module with the Stage-1 (silhouette-only) behavior and the one pure, unit-tested helper. No `game.ts` wiring yet (that is Task 2), so this task is self-contained and its deliverable is the tested `phantomRateScale` plus a compiling module.

**Files:**
- Create: `game/systems/stalkerPhantom.ts`
- Create: `game/systems/stalkerPhantom.test.ts`
- Modify: `game/config.ts` (add silhouette fields to the `stalker` block, after `bulletFlinch` at `game/config.ts:365`)

**Interfaces:**
- Consumes: `CONFIG.stalker` (new fields below); `CONFIG.flashlight` (`range`, `halfAngle`); `Player`, `State` from `../types`; `state.stalker` (`{ x, y, face, state, staggerT, contactCd, vis }`, `state` ∈ `"lull"|"aggro"|"stagger"|"retreat"`).
- Produces:
  - `interface Phantom { x: number; y: number; face: number; life: number; maxLife: number }`
  - `export function phantomRateScale(dread: number, exp: number): number`
  - `export function sysStalkerPhantom(state: State, lp: Player, ddt: number, dread: number): readonly Phantom[]`
  - `export function resetStalkerPhantom(): void`

- [ ] **Step 1: Add the silhouette CONFIG fields**

In `game/config.ts`, inside the `stalker: { … }` block, immediately after the `bulletFlinch: 0.18, …` line (`game/config.ts:365`), add:

```ts
    // --- phantom perception (Phase 1.5, stalkerPhantom.ts) — fake cues, render/audio-only ---
    phantomMax: 2, // concurrent fake silhouette cap
    phantomLife: 0.32, // fake silhouette lifetime (s), with sinusoidal fade in/out
    phantomSpawnIntervalMax: 5, // mean seconds between silhouette spawns at the ambient max rate (dread≈0)
    phantomDreadExp: 1.5, // shaping exponent k for the (1-dread)^k rate falloff
    phantomAlphaMax: 0.5, // peak silhouette alpha at mid-life
```

- [ ] **Step 2: Write the failing test for the pure rate helper**

Create `game/systems/stalkerPhantom.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { phantomRateScale } from "./stalkerPhantom";

describe("phantomRateScale", () => {
  it("is 1 at zero dread (the quiet → max fake rate)", () => {
    expect(phantomRateScale(0, 1.5)).toBeCloseTo(1, 6);
  });
  it("is 0 at full dread (real approach → fakes suppressed)", () => {
    expect(phantomRateScale(1, 1.5)).toBeCloseTo(0, 6);
  });
  it("with exp=1 falls off linearly", () => {
    expect(phantomRateScale(0.25, 1)).toBeCloseTo(0.75, 6);
  });
  it("clamps out-of-range dread", () => {
    expect(phantomRateScale(-0.5, 1.5)).toBeCloseTo(1, 6);
    expect(phantomRateScale(2, 1.5)).toBeCloseTo(0, 6);
  });
  it("is monotonically non-increasing in dread", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let d = 0; d <= 1.0001; d += 0.1) {
      const v = phantomRateScale(d, 1.5);
      expect(v).toBeLessThanOrEqual(prev + 1e-9);
      prev = v;
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test -- stalkerPhantom`
Expected: FAIL — `phantomRateScale` is not exported / module not found.

- [ ] **Step 4: Implement the module (silhouette-only)**

Create `game/systems/stalkerPhantom.ts`:

```ts
/**
 * stalkerPhantom — render/audio-only fake perception cues for the Stalker (Phase 1.5).
 *
 * Produces fleeting stalker-shaped silhouettes (Stage 1) and, later, non-localizable phantom
 * footsteps (Stage 2). Fakes drift during the quiet and recede as `dread` rises, so the real
 * localizable footfall always cuts through.
 *
 * RENDER/AUDIO ONLY — no sim state mutated, nothing written to state.particles or any sim field.
 * Mirrors `stalkerFx` / `darts`: module-level bookkeeping, re-derived per client each draw frame,
 * NOTHING synced. Single-player stays byte-for-byte safe. NO imports from game/net.
 *
 * Called from game.ts `draw()` after `stalkerFx` (so it reads the same `dread`).
 */

import { CONFIG } from "../config";
import type { Player, State } from "../types";

const SCFG = CONFIG.stalker;
const FLC = CONFIG.flashlight;

/** One fleeting fake silhouette (render-only; NO hitbox, NOT in state.particles). */
export interface Phantom {
  x: number;
  y: number;
  face: number; // faces the local player
  life: number; // remaining seconds (counts down from maxLife)
  maxLife: number;
}

// Module-level bookkeeping only (no sim state — reset via resetStalkerPhantom).
const phantoms: Phantom[] = [];

/** Reset per-run bookkeeping so stale phantoms/timers don't carry across runs. Call from resetAtmosphere. */
export function resetStalkerPhantom(): void {
  phantoms.length = 0;
}

/**
 * Ambient fake rate as a function of dread: 1 at dread=0 (the quiet), 0 at dread=1 (real approach).
 * Pure — the one unit-tested helper. `exp` (k) shapes the falloff.
 */
export function phantomRateScale(dread: number, exp: number): number {
  const d = Math.max(0, Math.min(1, dread));
  return (1 - d) ** exp;
}

/** Spawn one fake silhouette near the local player's vision edge (mirrors spawnDart's placement). */
function spawnPhantom(lp: Player): void {
  const side = Math.random() < 0.5 ? -1 : 1;
  const dist = FLC.range * (0.5 + Math.random() * 0.45);
  const ang = lp.aim + side * FLC.halfAngle * (0.8 + Math.random() * 0.6); // near / just outside the cone edge
  const x = lp.x + Math.cos(ang) * dist;
  const y = lp.y + Math.sin(ang) * dist;
  phantoms.push({
    x,
    y,
    face: Math.atan2(lp.y - y, lp.x - x), // look toward the player
    life: SCFG.phantomLife,
    maxLife: SCFG.phantomLife,
  });
}

/**
 * Update fake silhouettes for this draw frame and return the active list to draw.
 * Stage 1: silhouettes only. (Phantom steps are added in Stage 2.)
 *
 * @param state read-only (stalker + phase)
 * @param lp    local player (localPlayer(state))
 * @param ddt   render-side dt (state.time delta, clamped ≤ 0.1 by game.ts)
 * @param dread the dread value stalkerFx computed this frame (0..1)
 * @returns     active phantom silhouettes to draw (game.ts owns the renderer)
 */
export function sysStalkerPhantom(
  state: State,
  lp: Player,
  ddt: number,
  dread: number,
): readonly Phantom[] {
  const sk = state.stalker;
  const active =
    !!sk && state.phase === "night" && (sk.state === "lull" || sk.state === "aggro");
  if (!active) {
    // Stalker gone / day / staggered / retreating: clear fakes so nothing lingers into the quiet-after.
    if (phantoms.length) phantoms.length = 0;
    return phantoms;
  }

  // Age out existing silhouettes (swap-and-pop not needed — small array, order irrelevant).
  for (let i = phantoms.length - 1; i >= 0; i--) {
    const p = phantoms[i] as Phantom;
    p.life -= ddt;
    if (p.life <= 0) phantoms.splice(i, 1);
  }

  // Maybe spawn (continuous-probability model, like darts): mean interval phantomSpawnIntervalMax at
  // dread≈0, scaled toward 0 as dread rises.
  const scale = phantomRateScale(dread, SCFG.phantomDreadExp);
  if (
    phantoms.length < SCFG.phantomMax &&
    Math.random() < (ddt / SCFG.phantomSpawnIntervalMax) * scale
  ) {
    spawnPhantom(lp);
  }

  return phantoms;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- stalkerPhantom`
Expected: PASS (5 tests).

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add game/systems/stalkerPhantom.ts game/systems/stalkerPhantom.test.ts game/config.ts
git commit -m "feat(stalker): phantom-perception module — fake silhouettes + rate helper"
```

---

### Task 2: Wire silhouettes into `game.ts` draw + reset; coverage-exclude the module

Makes Stage 1 real: silhouettes spawn, drift, fade, and render. Ends with the **Stage 1 human playtest gate** (feel gate #1).

**Files:**
- Modify: `game/game.ts` (import at `game/game.ts:41`; call in `draw()` after `stalkerFx` at `game/game.ts:449`; draw loop after the `--- stalker ---` block at `game/game.ts:632`; reset in `resetAtmosphere` at `game/game.ts:157`)
- Modify: `vite.config.ts` (coverage exclude list, after `"game/systems/stalkerFx.ts"` — note: `stalkerFx` was added to the exclude list earlier; if absent, add it too; the group is at `vite.config.ts:60`)

**Interfaces:**
- Consumes: `sysStalkerPhantom`, `resetStalkerPhantom` (Task 1); `stalkerDread` local (already computed at `game/game.ts:449`); `SPRITE_SCALE` (`game/game.ts:59`), `SPRITE_FACE_OFFSET` (`game/game.ts:63`), `R.spriteLayer`/`R.spriteQuad`.
- Produces: nothing consumed by later tasks (pure wiring).

- [ ] **Step 1: Import the module**

In `game/game.ts`, next to the existing stalkerFx import (`game/game.ts:41`):

```ts
import { resetStalkerFx, stalkerFx } from "./systems/stalkerFx";
import { resetStalkerPhantom, sysStalkerPhantom } from "./systems/stalkerPhantom";
```

- [ ] **Step 2: Call the module in `draw()` and capture the list**

In `draw()`, right after the stalkerFx call (`game/game.ts:449`, `const stalkerDread = stalkerFx(state, lp, ddt);`), add:

```ts
  // fake perception cues (silhouettes now; phantom steps in Stage 2) — render/audio-only.
  const phantoms = sysStalkerPhantom(state, lp, ddt, stalkerDread);
```

- [ ] **Step 3: Draw the silhouettes**

In `draw()`, immediately after the `--- stalker ---` block closes (the `}` that ends `if (state.stalker) { … }` at `game/game.ts:632`), add:

```ts
  // --- fake stalker silhouettes (Phase 1.5): dark, low-alpha, no hitbox; fade in/out over life ---
  if (phantoms.length) {
    const phLayer = R.spriteLayer("stalker");
    if (phLayer >= 0) {
      const phSz = 32 * 2 * SPRITE_SCALE; // same logical size as the real stalker draw
      for (const p of phantoms) {
        const u = 1 - p.life / p.maxLife; // 0 at spawn → 1 at death
        const a = Math.sin(Math.PI * u) * CONFIG.stalker.phantomAlphaMax; // fade in then out
        if (a <= 0) continue;
        // cold, near-black tint — reads as "a shape at the edge of the light," not a lit body
        R.spriteQuad(p.x, p.y, phSz, phSz, p.face + SPRITE_FACE_OFFSET, phLayer, 0.14, 0.17, 0.3, a);
      }
    }
  }
```

- [ ] **Step 4: Reset in `resetAtmosphere`**

In `resetAtmosphere` (`game/game.ts:143`), next to `resetStalkerFx();` (`game/game.ts:157`):

```ts
  resetStalkerFx();
  resetStalkerPhantom();
```

- [ ] **Step 5: Coverage-exclude the module**

In `vite.config.ts`, in the "feel/visual systems" exclude group (`vite.config.ts:60`, alongside `game/systems/stalkerFx.ts`), add the line:

```ts
        "game/systems/stalkerPhantom.ts",
```

- [ ] **Step 6: Typecheck, lint, and full test/coverage**

Run: `bun run typecheck && bun run lint && bun run coverage`
Expected: typecheck clean; lint clean; coverage passes its thresholds (the new module is excluded, `stalkerPhantom.test.ts` still runs).

- [ ] **Step 7: Commit**

```bash
git add game/game.ts vite.config.ts
git commit -m "feat(stalker): render fake silhouettes in draw() + reset + coverage-exclude"
```

- [ ] **Step 8: STAGE 1 HUMAN PLAYTEST GATE (feel gate #1)**

Hand off to the human: play a stalker night. **Gate #1 — doubt in the quiet:** during a lull (real stalker far/absent-from-cone), do the fleeting silhouettes at the edge of the beam make you second-guess ("いる…？")? Also confirm no silhouettes appear right after a ward (`stagger`) or grab/withdraw (`retreat`), and none by day. If it's too frequent/rare or reads wrong, retune `CONFIG.stalker.phantom*` before Stage 2. Do NOT proceed to Task 3 until the human confirms.

---

### Task 3: `Audio.stalkerPhantomStep` primitive + `stalkerFx` lockout ownership

Adds the non-localizable phantom-step sound and the lockout that keeps a real footfall from being muddied. No consumer yet (that is Task 4), but the lockout is unit-testable and the audio primitive is manually audible.

**Files:**
- Modify: `game/engine/audio.ts` (add `stalkerPhantomStep`, export it in the returned object near `stalkerFootfall` at `game/engine/audio.ts:362`)
- Modify: `game/systems/stalkerFx.ts` (module lockout var + set on footfall fire at `game/systems/stalkerFx.ts:119`; export `phantomStepLocked`; clear in `resetStalkerFx` at `game/systems/stalkerFx.ts:33`)
- Modify: `game/config.ts` (add `phantomStepLockout` to the `stalker` block, in the phantom group from Task 1)
- Modify: `game/systems/stalkerPhantom.test.ts` (add lockout tests)

**Interfaces:**
- Consumes: `Audio` singleton; `CONFIG.stalker.phantomStepLockout`; `stalkerFx`'s existing footfall fire (`game/systems/stalkerFx.ts:119`).
- Produces:
  - `Audio.stalkerPhantomStep(): void`
  - `export function phantomStepLocked(now: number): boolean` (from `stalkerFx.ts`)

- [ ] **Step 1: Add the `phantomStepLockout` CONFIG field**

In `game/config.ts`, in the phantom group added in Task 1 (after `phantomAlphaMax`), add:

```ts
    phantomStepLockout: 0.6, // s after a real footfall during which no phantom step fires (owned by stalkerFx)
```

- [ ] **Step 2: Write the failing lockout tests**

Add these imports at the **top** of `game/systems/stalkerPhantom.test.ts` (import declarations must precede the existing `describe`), beneath the existing `import { phantomRateScale } from "./stalkerPhantom";`:

```ts
import { newState } from "../state";
import { phantomStepLocked, resetStalkerFx, stalkerFx } from "./stalkerFx";
```

Then append this new `describe` block at the **bottom** of the file:

```ts
describe("stalkerFx phantom-step lockout", () => {
  it("is not locked after reset", () => {
    resetStalkerFx();
    expect(phantomStepLocked(0)).toBe(false);
    expect(phantomStepLocked(100)).toBe(false);
  });

  it("locks right after a real footfall fires, then expires", () => {
    const s = newState();
    s.phase = "night";
    // Close + unlit ⇒ dread≈1 ⇒ stalkerFx fires a footfall on the first call (footfallT starts at 0).
    s.stalker = { x: 30, y: 0, face: 0, state: "aggro", staggerT: 0, contactCd: 0, vis: 1 };
    const lp = s.players[0];
    if (!lp) throw new Error("no local player");
    lp.lightOn = false; // ensure the stalker is "unlit" from the local player
    resetStalkerFx();
    stalkerFx(s, lp, 1); // ddt=1 ⇒ footfallT ≤ 0 ⇒ footfall fires ⇒ lockout set at now=s.time (0)
    expect(phantomStepLocked(s.time)).toBe(true); // within the 0.6s window
    expect(phantomStepLocked(s.time + 5)).toBe(false); // well past the window
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun run test -- stalkerPhantom`
Expected: FAIL — `phantomStepLocked` is not exported from `stalkerFx`.

- [ ] **Step 4: Add the lockout to `stalkerFx.ts`**

In `game/systems/stalkerFx.ts`, add a module var beside the existing timers (`game/systems/stalkerFx.ts:29-30`):

```ts
let footfallT = 0; // countdown to the next footfall sound (render-side only)
let stalkerHbT = 0; // countdown to the next stalker-dread heartbeat
let lastFootfallT = Number.NEGATIVE_INFINITY; // state.time of the last real footfall (owns the phantom-step lockout)
```

In `resetStalkerFx` (`game/systems/stalkerFx.ts:33`):

```ts
export function resetStalkerFx(): void {
  footfallT = 0;
  stalkerHbT = 0;
  lastFootfallT = Number.NEGATIVE_INFINITY;
}
```

At the footfall fire site (`game/systems/stalkerFx.ts:119`, right after `Audio.stalkerFootfall(pan, vol);`), record the time:

```ts
    Audio.stalkerFootfall(pan, vol);
    lastFootfallT = state.time; // arm the phantom-step lockout (this module owns it)
```

Add the exported query (place it just above `stalkerFx`, after `localFlickerNoise`):

```ts
/**
 * True while a real footfall fired recently — the phantom-step suppressor. `stalkerFx` owns this
 * because it is the real footfall's firer; `stalkerPhantom` reads it before firing a fake step so
 * the real localizable cue is never muddied on the same beat.
 */
export function phantomStepLocked(now: number): boolean {
  return now - lastFootfallT < CONFIG.stalker.phantomStepLockout;
}
```

(`CONFIG` is already imported in `stalkerFx.ts:19`.)

- [ ] **Step 5: Add the `stalkerPhantomStep` audio primitive**

In `game/engine/audio.ts`, after `stalkerFootfall` (ends `game/engine/audio.ts:257`), add:

```ts
/**
 * Phantom (fake) footstep — Phase 1.5. Footfall-LIKE so it plausibly reads as the stalker, but
 * engineered to fail both localization tests: fixed CENTRE pan (never panned) and a duller, lower
 * timbre than stalkerFootfall, at a FLAT low volume (no distance argument — it must never mimic the
 * real cue's approach-tracking loudness). The learnable rule: a step that gets louder as it repeats
 * is real; a flat, centred, dull step is a lie.
 */
function stalkerPhantomStep(): void {
  if (!ctx || !master) return;
  const now = ctx.currentTime;
  const vol = 0.16; // flat, low — deliberately not distance-scaled
  // Low, dull thud: lower and slower-decaying than the real footfall (60→28Hz); no high scrape layer.
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(46, now);
  o.frequency.exponentialRampToValueAtTime(24, now + 0.2);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(vol * 0.6, now + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);
  // A soft lowpass gives it a muffled, "somewhere / everywhere" quality; NO stereo panner (centred).
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 180;
  o.connect(g).connect(lp).connect(master);
  o.start(now);
  o.stop(now + 0.28);
}
```

Then add it to the returned singleton object (`game/engine/audio.ts:362`, next to `stalkerFootfall`):

```ts
  stalkerFootfall,
  stalkerPhantomStep,
  stalkerStinger,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun run test -- stalkerPhantom`
Expected: PASS (silhouette + lockout tests).

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add game/engine/audio.ts game/systems/stalkerFx.ts game/config.ts game/systems/stalkerPhantom.test.ts
git commit -m "feat(stalker): phantom-step audio primitive + stalkerFx-owned lockout"
```

---

### Task 4: Phantom steps in `stalkerPhantom` (Stage 2)

Extends `sysStalkerPhantom` to fire non-localizable phantom steps on a jittered timer, gated by the dread rate scale and the lockout. Ends with the **Stage 2 human playtest gate** (feel gate #2).

**Files:**
- Modify: `game/systems/stalkerPhantom.ts` (add step timer + audio fire; import `Audio` and `phantomStepLocked`)
- Modify: `game/config.ts` (add `phantomStepIntervalMax` to the phantom group)

**Interfaces:**
- Consumes: `Audio.stalkerPhantomStep` (Task 3); `phantomStepLocked` from `./stalkerFx` (Task 3); `CONFIG.stalker.phantomStepIntervalMax`; `state.time`.
- Produces: nothing new (behavior only).

- [ ] **Step 1: Add the `phantomStepIntervalMax` CONFIG field**

In `game/config.ts`, in the phantom group (after `phantomStepLockout`), add:

```ts
    phantomStepIntervalMax: 4, // mean seconds between phantom steps at the ambient max rate (dread≈0)
```

- [ ] **Step 2: Import Audio and the lockout query in the module**

At the top of `game/systems/stalkerPhantom.ts`, add imports (keep `import { CONFIG }` first):

```ts
import { CONFIG } from "../config";
import { Audio } from "../engine/audio";
import type { Player, State } from "../types";
import { phantomStepLocked } from "./stalkerFx";
```

- [ ] **Step 3: Add the step timer module var**

Beside `const phantoms: Phantom[] = [];`:

```ts
const phantoms: Phantom[] = [];
let stepT = 0; // countdown to the next phantom step (render/audio-side only)
```

Update `resetStalkerPhantom`:

```ts
export function resetStalkerPhantom(): void {
  phantoms.length = 0;
  stepT = 0;
}
```

- [ ] **Step 4: Fire phantom steps in `sysStalkerPhantom`**

In the **inactive** branch, drain the step timer so it doesn't fire immediately on re-activation. Replace:

```ts
  if (!active) {
    // Stalker gone / day / staggered / retreating: clear fakes so nothing lingers into the quiet-after.
    if (phantoms.length) phantoms.length = 0;
    return phantoms;
  }
```

with:

```ts
  if (!active) {
    // Stalker gone / day / staggered / retreating: clear fakes so nothing lingers into the quiet-after.
    if (phantoms.length) phantoms.length = 0;
    stepT = Math.max(stepT, SCFG.phantomStepIntervalMax * 0.5); // don't fire the instant it re-activates
    return phantoms;
  }
```

Then, in the **active** path, after the silhouette spawn block and before `return phantoms;`, add the step logic (note `scale` is already computed above for the silhouettes):

```ts
  // Phantom steps (Stage 2): a footfall-like but non-localizable sound on a jittered rhythm.
  // Gated by the same dread scale (quiet → likely; approach → suppressed) AND by the real-footfall
  // lockout so a fake never lands on the same beat as the real localizable cue.
  stepT -= ddt;
  if (stepT <= 0) {
    stepT = SCFG.phantomStepIntervalMax * (0.6 + Math.random() * 0.8); // jittered interval
    if (Math.random() < scale && !phantomStepLocked(state.time)) {
      Audio.stalkerPhantomStep();
    }
  }
```

- [ ] **Step 5: Typecheck and full test suite**

Run: `bun run typecheck && bun run test`
Expected: typecheck clean; all tests pass (the existing `stalkerPhantom.test.ts` still passes — `phantomRateScale` and the lockout are unchanged).

- [ ] **Step 6: Lint**

Run: `bun run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add game/systems/stalkerPhantom.ts game/config.ts
git commit -m "feat(stalker): non-localizable phantom steps (dread- + lockout-gated)"
```

- [ ] **Step 8: STAGE 2 HUMAN PLAYTEST GATE (feel gate #2 + #3) — test on MONO + a dense night**

Hand off to the human. **Gate #2 — real cuts through (mono, dense night):** when the stalker actually approaches, does the real footfall's rising, approach-tracking loudness read as clearly real and distinct from the flat-volume phantom steps — *even on mono output and amid the crowd's groans/screeches*? **Gate #3 — not noisy:** are fakes rare/subtle enough to unsettle rather than annoy, with no phantom-step spam right after a ward/grab? If gate #2 fails, retune the discriminators (phantom-step volume/timbre, `phantomStepLockout`, `phantomStepIntervalMax`) or cut the phantom step — Stage 1 still stands. Only after the human confirms is Phase 1.5 done.

---

## Notes for the executor

- **Playtest gates are human, not automated.** Tasks 2 and 4 each end with a hand-off; do not self-certify feel. The tuning constants are first guesses — expect to iterate `CONFIG.stalker.phantom*` from playtest feedback.
- **Deferred (do NOT build here):** `phantomDreadSmooth` (EMA on dread) — add only if playtest shows rate jank when sweeping light; map loop/hide geometry; cumulative `menace` (Phase 2).
- **Single-player is what gets played** — verify SP feel at both gates; co-op re-derives locally by construction (no new wire state), so it needs no snapshot changes.
- **Intentional deviation from the spec's `phantomStepVol`:** the spec listed `phantomStepVol` as a `CONFIG.stalker` field, but the plan hardcodes the phantom-step level inside `Audio.stalkerPhantomStep` (like every other `audio.ts` primitive, whose envelope levels are inline). This is deliberate — it makes the fairness invariant ("flat, never distance-scaled") structurally unbreakable (no caller can pass a volume) and keeps audio levels where the rest live. If a reviewer wants it tunable, promote the inline `0.16` to `CONFIG.stalker.phantomStepVol` and pass it in; the invariant is preserved as long as it is never a distance function.
