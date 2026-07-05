# Enemy Navigation (Foundation 2a) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give enemies a data-driven navigation gradient — `none` (beeline, today's dumb), `avoid` (steer around walls), `path` (flow-field route through openings to the player) — so smarter types stop smearing on walls and route through doors, while dumb types stay dumb.

**Architecture:** A host-side pure **flow field** (grid, multi-source BFS/Dijkstra from all living players over walkable cells, rebuilt every N frames) gives coarse routing; per-agent **steering whiskers** handle wall-avoidance and the final opening traversal. `ai.ts` pass-1 heading is extracted into a `steerHeading(z, state)` dispatch over the `nav` trait. Pure modules are unit-tested; AI *feel* is playtested.

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess), Bun, Vitest, Biome.

## Global Constraints

- **This is sim/AI, NOT pure render.** Only the host runs `update()`/AI; clients interpolate snapshots and never re-simulate → **no RNG seeding needed**, and the flow field is **host-only transient state** (not in `state` snapshot, not synced). Real invariant: **do not regress existing ballistics/movement/camera/crowd-sweep feel**; systems stay **net-agnostic** (no net imports).
- **No behavior change until traits are assigned.** Every enemy type starts at `nav: "none"` reproducing today's exact heading; the crowd only changes when Task 5 assigns non-`none` traits.
- **Data-driven, dispatch not branches.** `nav` selects a heading helper via a table (`NAV_STEER[z.nav]`, uniform signature `(z, state) => {hx, hy}`) — the same "data selects behavior" pattern as `phaseMods` / deployables capability-blocks. No per-type `if` chains in the movement body.
- **Pure helpers are unit-tested** (CLAUDE.md tests pure/deterministic code: flow-field, walkability, gradient sampling, steering). AI movement feel is **playtested**, not unit-tested.
- **Design source:** `docs/superpowers/specs/2026-07-05-enemy-ai-navigation-design.md`. This plan implements its **Navigation** substrate only; **Perception (LOS/noise/percept/hunt-search-idle) is Foundation 2b, a separate plan.**
- **Openings must be first-class:** POI doors are 60px; HOME openings are 80–120px (left/right windows 80, top window 100, bottom door 120 — `map.ts`). The **narrowest (60px POI door)** sets the walkability budget: `cell`/`clearance` must let an agent through it regardless of grid phase (see Task 4 / the production-values test).
- Tuning in `CONFIG`. Commit after each task. Full suite green before each commit.

## File Structure

- `game/engine/navfield.ts` (NEW) — pure flow-field: grid build, multi-source BFS, `sampleFlow` (bilinear gradient), walkability. No engine/GL deps.
- `game/engine/navfield.test.ts` (NEW) — unit tests for the above.
- `game/engine/steering.ts` (NEW) — pure `avoidHeading(x, y, dirX, dirY, walls, cfg)` whisker steering.
- `game/engine/steering.test.ts` (NEW) — unit tests.
- `game/types.ts` — `EnemyType.nav?` and `Zombie.nav`.
- `game/data/enemies.ts` — `nav` per type (all `"none"` until Task 5).
- `game/systems/wave.ts` — copy `nav` onto the spawned Zombie.
- `game/systems/ai.ts` — extract `steerHeading`, add `NAV_STEER` dispatch, build/refresh the flow field.
- `game/config.ts` — `ai.nav` tuning block.
- `game/state.ts` — hold the transient flow field handle (host-only).

---

### Task 1: Extract `steerHeading` from pass-1 (pure refactor, behavior identical)

Isolate the heading computation so later tasks can dispatch on `nav` without touching the rest of pass-1. **No behavior change.**

**Files:**
- Modify: `game/systems/ai.ts` (extract the heading block from pass-1 into a local function)

**Interfaces:**
- Produces: `function steerHeading(z: Zombie, state: State, chasing: boolean): { hx: number; hy: number }` — returns the *desired heading unit-ish vector* exactly as pass-1 computes it today (the `chasing` wobble branch and the `wander` drift branch), reading `z.wander`, `z.wanderDir`, `z.wob`, `state.time`, and the target direction.

- [ ] **Step 1: Read the current heading block.** In `game/systems/ai.ts` pass-1 (around the `// desired heading` comment, ~L64-80), identify the exact code that computes `hx, hy` from `chasing` (the `Math.sin(state.time*3 + z.wob) * z.wander * 0.5` rotation of `dx,dy`) vs. the wander branch (`z.wanderDir += ...; hx = Math.cos(z.wanderDir); hy = Math.sin(z.wanderDir)`).

- [ ] **Step 2: Extract verbatim into a function.** The wander branch uses `mod.wanderMul` and `dt` (locals in `sysAI`), so pass them as explicit parameters. `rand` is already imported in `ai.ts` (from `math`). Add at module scope (after imports), matching the original arithmetic (`ai.ts` ~L68-80) character-for-character:

```ts
/** Desired heading for a zombie this frame — extracted from pass-1 verbatim (nav: "none").
 *  dx/dy is the normalized direction to the target (0,0 if no target). */
function headingNone(
  z: Zombie,
  state: State,
  chasing: boolean,
  dx: number,
  dy: number,
  wanderMul: number,
  dt: number,
): { hx: number; hy: number } {
  if (chasing) {
    const a = Math.sin(state.time * 3 + z.wob) * z.wander * 0.5;
    const c = Math.cos(a);
    const s = Math.sin(a);
    return { hx: dx * c - dy * s, hy: dx * s + dy * c };
  }
  z.wanderDir += rand(-1, 1) * z.wander * wanderMul * 3 * dt;
  return { hx: Math.cos(z.wanderDir), hy: Math.sin(z.wanderDir) };
}
```

Verify the two branches match the current pass-1 exactly before/after extraction.

- [ ] **Step 3: Call it from pass-1.** Replace the inline `// desired heading` block with:

```ts
const { hx, hy } = headingNone(z, state, chasing, dx, dy, mod.wanderMul, dt);
```

Leave everything else in pass-1 (separation, lunge, speed, move, resolveWalls, attack) untouched.

- [ ] **Step 4: Verify no behavior change.**

Run: `cd /Users/sanosuguru/dev/quarantine && bun run typecheck && bun run lint && bun run test`
Expected: all pass (396+ tests). The extraction is arithmetic-identical, so no test changes.
Then `bun run dev` briefly: crowd movement (shamble + wander) looks identical to before.

- [ ] **Step 5: Commit.**

```bash
git add game/systems/ai.ts
git commit -m "refactor(ai): extract headingNone from pass-1 (no behavior change)"
```

---

### Task 2: `nav` trait plumbing + dispatch table (still no behavior change)

Add the `nav` field through the data pipeline and a dispatch table containing only `none` (→ `headingNone`). Crowd behavior stays identical.

**Files:**
- Modify: `game/types.ts` (`EnemyType.nav?`, `Zombie.nav`)
- Modify: `game/data/enemies.ts` (add `nav: "none"` to walker/runner/brute)
- Modify: `game/systems/wave.ts` (copy `nav` onto the spawned zombie)
- Modify: `game/net/snapshot.ts` (`zombieFromSnap` must set `nav` — else `Zombie.nav` being required fails typecheck)
- Modify: `game/systems/ai.ts` (`NAV_STEER` table; call via `z.nav`)

**Interfaces:**
- Produces: `type NavMode = "none" | "avoid" | "path"`; `EnemyType.nav?: NavMode` (default `"none"`); `Zombie.nav: NavMode`; `const NAV_STEER: Record<NavMode, (ctx) => {hx,hy}>` where `ctx` bundles `(z, state, chasing, dx, dy, wanderMul, dt)`.

- [ ] **Step 1: Add the type.** In `game/types.ts`, above `EnemyType`:

```ts
export type NavMode = "none" | "avoid" | "path";
```

Add to `EnemyType`: `  /** navigation intelligence: none=beeline, avoid=steer around walls, path=flow-field route */\n  nav?: NavMode;`
Add to `Zombie` (in the "behaviour fields copied from EnemyType" block): `  nav: NavMode;`

- [ ] **Step 2: Set `nav` on every enemy type.** In `game/data/enemies.ts`, add `nav: "none",` to `walker`, `runner`, and `brute` (all `"none"` for now — behavior unchanged).

- [ ] **Step 3: Copy `nav` onto the spawned zombie.** In `game/systems/wave.ts` `spawnZombie`, in the `state.zombies.push({...})` literal (next to `separation: t.separation ?? 1,`), add: `nav: t.nav ?? "none",`.

- [ ] **Step 3b: Set `nav` in `zombieFromSnap`.** Making `Zombie.nav` required breaks `game/net/snapshot.ts`'s `zombieFromSnap` (~L243-279), which builds a Zombie with all fields explicit. Clients never run `sysAI`, so the value is inert — add `nav: "none",` to that literal to satisfy the type. (Do NOT add `nav` to the encoded wire format; it's not synced.)

- [ ] **Step 4: Dispatch table in ai.ts.** Replace the direct `headingNone(...)` call from Task 1 with a table lookup. Add at module scope:

```ts
type SteerCtx = {
  z: Zombie; state: State; chasing: boolean;
  dx: number; dy: number; wanderMul: number; dt: number;
};
const NAV_STEER: Record<NavMode, (c: SteerCtx) => { hx: number; hy: number }> = {
  none: (c) => headingNone(c.z, c.state, c.chasing, c.dx, c.dy, c.wanderMul, c.dt),
  avoid: (c) => headingNone(c.z, c.state, c.chasing, c.dx, c.dy, c.wanderMul, c.dt), // Task 3
  path: (c) => headingNone(c.z, c.state, c.chasing, c.dx, c.dy, c.wanderMul, c.dt), // Task 4
};
```

(avoid/path temporarily alias `none` so this task is a no-op; Tasks 3–4 replace them.)
In pass-1, call: `const { hx, hy } = NAV_STEER[z.nav]({ z, state, chasing, dx, dy, wanderMul: mod.wanderMul, dt });`

- [ ] **Step 5: Verify no behavior change.**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: pass. `bun run dev`: crowd identical.

- [ ] **Step 6: Commit.**

```bash
git add game/types.ts game/data/enemies.ts game/systems/wave.ts game/net/snapshot.ts game/systems/ai.ts
git commit -m "feat(ai): nav trait plumbing + dispatch table (all none, no-op)"
```

---

### Task 3: `avoid` steering (whiskers) — pure module + wire-in

A pure wall-avoidance steering helper, unit-tested, then wired as `NAV_STEER.avoid`.

**Files:**
- Create: `game/engine/steering.ts`
- Create: `game/engine/steering.test.ts`
- Modify: `game/config.ts` (`ai.nav.whisker*`)
- Modify: `game/systems/ai.ts` (`NAV_STEER.avoid` uses it)

**Interfaces:**
- Produces: `function avoidHeading(x, y, dirX, dirY, walls, opts): { hx: number; hy: number }` — given a desired heading `(dirX,dirY)` (unit), returns a heading nudged away from walls within `opts.look` ahead. Pure; `walls: Segment[]`.

- [ ] **Step 1: Write failing tests.** `game/engine/steering.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { avoidHeading } from "./steering";
import type { Segment } from "../types";

const opts = { look: 40, whiskerAngle: 0.6, strength: 1 };

describe("avoidHeading", () => {
  it("passes through unchanged when no wall is ahead", () => {
    const r = avoidHeading(0, 0, 1, 0, [], opts);
    expect(r.hx).toBeCloseTo(1);
    expect(r.hy).toBeCloseTo(0);
  });

  it("steers away from a wall directly ahead", () => {
    // vertical wall at x=30 blocking rightward travel
    const wall: Segment = { x1: 30, y1: -50, x2: 30, y2: 50 };
    const r = avoidHeading(0, 0, 1, 0, [wall], opts);
    // heading should gain a vertical component (turn along the wall), not stay pure +x
    expect(Math.abs(r.hy)).toBeGreaterThan(0.2);
    const len = Math.hypot(r.hx, r.hy);
    expect(len).toBeCloseTo(1, 1); // returned heading is normalized
  });
});
```

- [ ] **Step 2: Run — fail.** `bun run test steering` → FAIL (module missing).

- [ ] **Step 3: Implement `steering.ts`.**

```ts
import { closestPointOnSegment } from "./geometry";
import type { Segment } from "../types";

export interface AvoidOpts {
  look: number; // how far ahead to probe
  whiskerAngle: number; // radians offset of side whiskers
  strength: number; // how hard to steer away
}

/** nearest wall-clearance penalty along a probe direction from (x,y) */
function probe(x: number, y: number, dx: number, dy: number, look: number, walls: Segment[]): number {
  const px = x + dx * look;
  const py = y + dy * look;
  let worst = 0;
  for (const w of walls) {
    const c = closestPointOnSegment(px, py, w.x1, w.y1, w.x2, w.y2);
    const d = Math.hypot(px - c.x, py - c.y);
    const pen = Math.max(0, 1 - d / look); // 0 far, →1 as it nears the probe tip
    if (pen > worst) worst = pen;
  }
  return worst;
}

/** Nudge a desired heading away from walls using three forward whiskers. Pure. */
export function avoidHeading(
  x: number, y: number, dirX: number, dirY: number, walls: Segment[], opts: AvoidOpts,
): { hx: number; hy: number } {
  if (walls.length === 0) return { hx: dirX, hy: dirY };
  const base = Math.atan2(dirY, dirX);
  const center = probe(x, y, Math.cos(base), Math.sin(base), opts.look, walls);
  if (center === 0) return { hx: dirX, hy: dirY };
  const la = base + opts.whiskerAngle;
  const ra = base - opts.whiskerAngle;
  const left = probe(x, y, Math.cos(la), Math.sin(la), opts.look, walls);
  const right = probe(x, y, Math.cos(ra), Math.sin(ra), opts.look, walls);
  // turn toward the clearer side, proportional to the blockage
  const turn = (right - left) * opts.strength * center;
  const a = base + turn;
  return { hx: Math.cos(a), hy: Math.sin(a) };
}
```

**Implementer note:** confirm `closestPointOnSegment`'s exact return shape in `game/engine/geometry.ts` (it may return `{x,y}` or a tuple) and adapt. If its signature differs, match it — do not change geometry.ts.

- [ ] **Step 4: Run — pass.** `bun run test steering` → PASS.

- [ ] **Step 5: Config + wire-in.** In `game/config.ts` add under a new `ai` block (or existing): `nav: { whiskerLook: 40, whiskerAngle: 0.6, avoidStrength: 1.0, ... }`. In `ai.ts`, set `NAV_STEER.avoid` to: compute the `none` heading first (desired), then run it through `avoidHeading(z.x, z.y, base.hx, base.hy, state.walls, cfg)`:

```ts
avoid: (c) => {
  const base = headingNone(c.z, c.state, c.chasing, c.dx, c.dy, c.wanderMul, c.dt);
  const bl = Math.hypot(base.hx, base.hy) || 1;
  return avoidHeading(c.z.x, c.z.y, base.hx / bl, base.hy / bl, c.state.walls,
    { look: CFG.whiskerLook, whiskerAngle: CFG.whiskerAngle, strength: CFG.avoidStrength });
},
```

- [ ] **Step 6: Verify.** `bun run typecheck && bun run lint && bun run test` pass. (No type yet uses `avoid`, so still no crowd change — verified in Task 5.)

- [ ] **Step 7: Commit.**

```bash
git add game/engine/steering.ts game/engine/steering.test.ts game/config.ts game/systems/ai.ts
git commit -m "feat(ai): avoid steering (whiskers) — pure module + wire-in"
```

---

### Task 4: `path` flow-field — pure module + wire-in

The flow field: a coarse grid, walkable where clear of walls (fine enough that 60px openings pass), multi-source BFS from all living players, bilinear gradient sampling. Unit-tested, then wired as `NAV_STEER.path` and refreshed each N frames in `sysAI`.

**Files:**
- Create: `game/engine/navfield.ts`
- Create: `game/engine/navfield.test.ts`
- Modify: `game/config.ts` (`ai.nav.cell`, `rebuildFrames`, `bounds`)
- Modify: `game/state.ts` (transient field handle)
- Modify: `game/systems/ai.ts` (build/refresh + `NAV_STEER.path`)

**Interfaces:**
- Produces:
  - `interface FlowField { cell: number; minX: number; minY: number; cols: number; rows: number; cost: Float32Array; }`
  - `function buildFlowField(walls: Segment[], targets: {x,y}[], bounds: {minX,minY,maxX,maxY}, cell: number, clearance: number): FlowField`
  - `function sampleFlow(f: FlowField, x: number, y: number): { hx: number; hy: number }` — unit gradient descending toward the nearest target (0,0 if unreachable/outside).

- [ ] **Step 1: Write failing tests.** `game/engine/navfield.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildFlowField, sampleFlow } from "./navfield";
import type { Segment } from "../types";

const bounds = { minX: -200, minY: -200, maxX: 200, maxY: 200 };

describe("flow field", () => {
  it("points straight at the target in open space", () => {
    const f = buildFlowField([], [{ x: 100, y: 0 }], bounds, 20, 10);
    const g = sampleFlow(f, -100, 0);
    expect(g.hx).toBeGreaterThan(0.7); // mostly +x toward target
    expect(Math.abs(g.hy)).toBeLessThan(0.3);
  });

  it("routes around a wall instead of into it (gradient not straight through)", () => {
    // vertical wall between sampler and target, with a gap at the top
    const walls: Segment[] = [{ x1: 0, y1: -200, x2: 0, y2: 60 }];
    const f = buildFlowField(walls, [{ x: 120, y: 0 }], bounds, 20, 8);
    const g = sampleFlow(f, -120, 0);
    // must gain a +y component to head for the gap, not point straight +x into the wall
    expect(g.hy).toBeGreaterThan(0.1);
  });

  it("passes through a 60px opening (walkable cells exist in the gap)", () => {
    // wall along x=0 with a 60px gap centered at y=0
    const walls: Segment[] = [
      { x1: 0, y1: -200, x2: 0, y2: -30 },
      { x1: 0, y1: 30, x2: 0, y2: 200 },
    ];
    const f = buildFlowField(walls, [{ x: 120, y: 0 }], bounds, 15, 6);
    const g = sampleFlow(f, -120, 0);
    expect(g.hx).toBeGreaterThan(0.3); // reaches target through the gap
  });

  it("passes a 60px door at PRODUCTION cell/clearance (guards phase-dependence)", () => {
    // Same 60px gap, but at the values the game actually ships (Task 5 config).
    // With cell=24, clearance=14 the walkable band is ±(30-14)=±16 (32px) > cell 24,
    // so a walkable cell column through the gap is guaranteed regardless of grid phase.
    const walls: Segment[] = [
      { x1: 0, y1: -200, x2: 0, y2: -30 },
      { x1: 0, y1: 30, x2: 0, y2: 200 },
    ];
    const f = buildFlowField(walls, [{ x: 120, y: 0 }], bounds, 24, 14);
    const g = sampleFlow(f, -120, 0);
    expect(g.hx).toBeGreaterThan(0.3);
  });
});
```

- [ ] **Step 2: Run — fail.** `bun run test navfield` → FAIL.

- [ ] **Step 3: Implement `navfield.ts`.**

```ts
import { closestPointOnSegment } from "./geometry";
import type { Segment } from "../types";

export interface FlowField {
  cell: number; minX: number; minY: number; cols: number; rows: number;
  cost: Float32Array; // BFS distance to nearest target; Infinity = wall/unreachable
}

function idx(f: { cols: number }, c: number, r: number): number { return r * f.cols + c; }

function walkable(walls: Segment[], x: number, y: number, clearance: number): boolean {
  for (const w of walls) {
    // AABB early-reject: most cells are far from most walls, so skip the sqrt when the
    // point is outside the wall's bounding box padded by `clearance`. Keeps the grid
    // build ~O(cells) instead of O(cells × walls).
    if (x < Math.min(w.x1, w.x2) - clearance || x > Math.max(w.x1, w.x2) + clearance) continue;
    if (y < Math.min(w.y1, w.y2) - clearance || y > Math.max(w.y1, w.y2) + clearance) continue;
    const p = closestPointOnSegment(x, y, w.x1, w.y1, w.x2, w.y2);
    if (Math.hypot(x - p.x, y - p.y) < clearance) return false;
  }
  return true;
}

export function buildFlowField(
  walls: Segment[], targets: { x: number; y: number }[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  cell: number, clearance: number,
): FlowField {
  const cols = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
  const rows = Math.max(1, Math.ceil((bounds.maxY - bounds.minY) / cell));
  const f: FlowField = { cell, minX: bounds.minX, minY: bounds.minY, cols, rows, cost: new Float32Array(cols * rows) };
  f.cost.fill(Number.POSITIVE_INFINITY);
  // mark walls
  const walk = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const wx = bounds.minX + (c + 0.5) * cell;
    const wy = bounds.minY + (r + 0.5) * cell;
    walk[idx(f, c, r)] = walkable(walls, wx, wy, clearance) ? 1 : 0;
  }
  // multi-source BFS (4-neighbour; cost in cells)
  const q: number[] = [];
  for (const t of targets) {
    const c = Math.floor((t.x - bounds.minX) / cell);
    const r = Math.floor((t.y - bounds.minY) / cell);
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    const i = idx(f, c, r);
    if (walk[i]) { f.cost[i] = 0; q.push(i); }
  }
  for (let head = 0; head < q.length; head++) {
    const i = q[head] as number;
    const c = i % cols, r = (i / cols) | 0;
    const base = f.cost[i] as number;
    const nb = [ [c - 1, r], [c + 1, r], [c, r - 1], [c, r + 1] ];
    for (const [nc, nr] of nb) {
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const ni = idx(f, nc as number, nr as number);
      if (!walk[ni]) continue;
      if (base + 1 < (f.cost[ni] as number)) { f.cost[ni] = base + 1; q.push(ni); }
    }
  }
  return f;
}

function costAt(f: FlowField, c: number, r: number): number {
  if (c < 0 || r < 0 || c >= f.cols || r >= f.rows) return Number.POSITIVE_INFINITY;
  return f.cost[idx(f, c, r)] as number;
}

/** Unit heading descending the cost field toward the nearest target. */
export function sampleFlow(f: FlowField, x: number, y: number): { hx: number; hy: number } {
  const c = Math.floor((x - f.minX) / f.cell);
  const r = Math.floor((y - f.minY) / f.cell);
  const here = costAt(f, c, r);
  if (!isFinite(here)) return { hx: 0, hy: 0 };
  // gradient via finite differences on the cost field (descend = negative gradient)
  const gx = (Math.min(costAt(f, c + 1, r), 1e9) - Math.min(costAt(f, c - 1, r), 1e9));
  const gy = (Math.min(costAt(f, c, r + 1), 1e9) - Math.min(costAt(f, c, r - 1), 1e9));
  const hx = -gx, hy = -gy;
  const l = Math.hypot(hx, hy);
  if (l < 1e-6) return { hx: 0, hy: 0 };
  return { hx: hx / l, hy: hy / l };
}
```

**Implementer notes:** (1) match `closestPointOnSegment`'s real return shape. (2) The finite-difference gradient with `Math.min(cost, 1e9)` keeps walls (Infinity) from producing NaN while still repelling — verify the tests pass and adjust the `1e9` clamp if a test needs it. (3) This is the spec's coarse routing; the final opening traversal is smoothed by chaining `avoid` in Task 5's wiring.

- [ ] **Step 4: Run — pass.** `bun run test navfield` → PASS (all 3 cases).

- [ ] **Step 5: Config + state handles.** In `game/config.ts` add an `ai.nav` block: `cell: 24, clearance: 14, rebuildFrames: 15`. Bounds are **derived from `CONFIG.arena` (±1600), not hard-coded ±1700** — build them where the field is built (Step 6) as `{ minX: -CONFIG.arena, minY: -CONFIG.arena, maxX: CONFIG.arena, maxY: CONFIG.arena }`.
  - **Why these values (from review):** for a 60px door the walkable band is ±(30 − clearance) = ±16 (32px) at `clearance:14`; `32 > cell 24`, so a walkable cell column through the door is guaranteed regardless of grid phase (the phase-dependence the review flagged). `clearance:14` also fits walker (r15) / runner (r13) without the body clipping walls; **brute (r27) is too wide for a 60px door — do NOT assign `path` to brute** (Task 5 gives it `avoid`). Grid ≈ (3200/24)² ≈ 134² ≈ 18k cells.
  - In `game/state.ts`: add `flow: FlowField | null` (init `null`) **and** `navTick: number` (init `0`) — **both transient, host-only, NOT synced** (there is no existing `state.tick`; `navTick` is new). Document them so no one adds them to `captureSnapshot`/`encode`.

- [ ] **Step 6: Build + refresh in sysAI; wire `path`.** At the top of `sysAI`, increment the new counter and rebuild every `rebuildFrames` frames (`state.navTick` — there is NO `state.tick`):

```ts
state.navTick++;
if (state.navTick % CFG.rebuildFrames === 0 || state.flow === null) {
  const living = state.players.filter((p) => p.hp > 0 && !p.absent);
  const b = { minX: -CONFIG.arena, minY: -CONFIG.arena, maxX: CONFIG.arena, maxY: CONFIG.arena };
  state.flow = living.length ? buildFlowField(state.walls, living, b, CFG.cell, CFG.clearance) : null;
}
```

Set `NAV_STEER.path`:

```ts
path: (c) => {
  if (!c.chasing || !c.state.flow) return headingNone(c.z, c.state, c.chasing, c.dx, c.dy, c.wanderMul, c.dt);
  const g = sampleFlow(c.state.flow, c.z.x, c.z.y);
  if (g.hx === 0 && g.hy === 0) return headingNone(c.z, c.state, c.chasing, c.dx, c.dy, c.wanderMul, c.dt);
  // smooth final approach / opening traversal with whiskers
  return avoidHeading(c.z.x, c.z.y, g.hx, g.hy, c.state.walls,
    { look: CFG.whiskerLook, whiskerAngle: CFG.whiskerAngle, strength: CFG.avoidStrength });
},
```

(Wander when not chasing keeps `headingNone`; `path` only engages while chasing a target.)

- [ ] **Step 7: Verify.** `bun run typecheck && bun run lint && bun run test` pass (navfield + steering + existing). Still no crowd change (no type is `path` yet).

- [ ] **Step 8: Commit.**

```bash
git add game/engine/navfield.ts game/engine/navfield.test.ts game/config.ts game/state.ts game/systems/ai.ts
git commit -m "feat(ai): flow-field path navigation — pure module + wire-in"
```

---

### Task 5: Assign traits + tuning + playtest feel-gate

Give the roster a gradient and tune it. This is where the crowd's behavior finally changes.

**Files:**
- Modify: `game/data/enemies.ts` (assign `nav` per type)
- Modify: `game/config.ts` (final tuning)

**Interfaces:** none new.

- [ ] **Step 1: Assign a starting gradient.** In `game/data/enemies.ts`: keep `walker: nav "none"` (dumb shambler — characterful, r15), set `runner: nav "path"` (the smart hunter — routes through doors to you; r13 ≤ clearance 14, fits openings), set `brute: nav "avoid"` (relentless plow that only steers around walls — its r27 body is too wide for a 60px door, so `path` would jam it; `avoid` suits it). This gives an immediate visible spread. **Rule of thumb: only assign `path` to types whose radius ≤ `clearance`** (else the field routes a body that can't fit). Starting point; adjust after playtest.

- [ ] **Step 2: Perf sanity.** `bun run dev`, reach a late night near the cap. The flow field rebuilds every `rebuildFrames`; confirm no frame hitch on rebuild. If it hitches, raise `rebuildFrames` or coarsen `cell` in CONFIG.

- [ ] **Step 3: Playtest feel-gate.** Confirm:
  1. `path`/`avoid` types **route around buildings** (no smearing) and go **through doors**, while `none` walkers still shamble dumbly — the **gradient reads**.
  2. **No door-congestion oscillation/jam** at the 60px openings (whisker smoothing + finite-diff gradient working); if it jams, tune `whiskerLook`/`avoidStrength` or `clearance`.
  3. Smart heading **survives the pass-2 de-overlap** (`ai.ts:181`) — clever paths still read as clever in a dense crowd, not overridden into a smear. If not, note it (may need de-overlap/`sense` tuning — a follow-up).
  4. **Single-player + the crowd's core feel** (sweep, hitstop, chase pressure) is **not regressed**.
  5. Full suite still green: `bun run test`.

  Any "no" → tune CONFIG (hot-reloads) or fix before sign-off.

- [ ] **Step 4: Commit final tuning.**

```bash
git add game/data/enemies.ts game/config.ts
git commit -m "feat(ai): assign nav gradient to roster + tuning"
```

---

## Self-Review

**Spec coverage (Navigation substrate):** Navigation axis (`none`/`avoid`/`path`) via data + dispatch table (Tasks 2–4) ✓; flow-field multi-source over walkable grid with **guaranteed** opening passage at production values (Task 4, `cell:24`/`clearance:14` → 32px band > cell, plus a production-values regression test) ✓; steering whiskers for `avoid` + opening traversal (Tasks 3, 4 wiring) ✓; anti-jam via whisker-smoothing + finite-diff gradient (Task 4, Task 5 gate) ✓; heading-extraction refactor (Task 1) ✓; host-only transient `flow`/`navTick`, not synced (Task 4 Step 5) ✓; `snapshot.ts zombieFromSnap` updated for required `Zombie.nav` (Task 2 Step 3b) ✓; data-driven dispatch not branches (Task 2) ✓; pure modules unit-tested, feel playtested (Tasks 3–4 tests, Task 5 gate) ✓. **Perception (LOS/noise/percept/hunt-search-idle) is deferred to Foundation 2b.**

**Post-review corrections applied (rubber-duck):** production `cell:24`/`clearance:14` (was 32/20 — the old band 20px < cell 32 was phase-dependent and clearance 20 < brute r27) + a production-values door test; `brute` reassigned to `avoid` (r27 too wide for a 60px door) with a "path only if radius ≤ clearance" rule; `state.navTick` added (there is no `state.tick`); `snapshot.ts` added to Task 2 (`Zombie.nav` required would fail `zombieFromSnap`); `walkable` AABB early-reject for perf (grid ≈ 18k cells × 28 walls); `bounds` derived from `CONFIG.arena`; Task 1's deliberate-wrong draft removed.

**Type/name consistency:** `NavMode`, `nav`, `headingNone`, `NAV_STEER`, `SteerCtx`, `avoidHeading`, `AvoidOpts`, `buildFlowField`, `sampleFlow`, `FlowField`, `state.flow`, `state.navTick` used consistently. `avoidHeading(x,y,dirX,dirY,walls,opts)` matches its Task 3 & 4 call sites. `closestPointOnSegment(px,py,x1,y1,x2,y2) → {x,y}` confirmed by review against `geometry.ts`.
