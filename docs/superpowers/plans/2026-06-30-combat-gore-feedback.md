# Combat Gore Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace floating damage numbers and per-zombie HP bars with damage-proportional gore (blood/sparks/flesh-chunks) plus a wound tint, so combat reads by feel instead of UI text.

**Architecture:** A single pure `goreIntensity()` (0..1, weapon-weight base + near-lethal finisher bonus) feeds an intensity-scaled `fxImpact`. A pure `gibsToSpawn()` throttles flesh chunks against the particle budget so muzzle flashes never starve. The damage-number system is deleted; the HP bar becomes an hp-driven body tint. Co-op clients re-derive intensity from the already-synced `hp`/`flash` snapshot diff — no new network field.

**Tech Stack:** TypeScript (strict + noUncheckedIndexedAccess), custom WebGL2 engine, Vitest (node env), Biome (lint+format), Bun scripts.

**Spec:** `docs/superpowers/specs/2026-06-30-combat-gore-feedback-design.md`

## Global Constraints

- **Single-player must stay byte-for-byte unchanged** when touching co-op code. The `intensity` path for single-player runs directly (never via snapshot).
- **Floor = no regression:** at `intensity = 0`, `fxImpact` must emit exactly today's burst (6 sparks + 3 specks + small pool, no gibs).
- **Tune via CONFIG only** — all gore constants live in `CONFIG.fx.gore`, never hard-coded in systems.
- **Only pure, deterministic code is unit-tested** (`goreIntensity`, `gibsToSpawn`). The FX *look* (particle counts in motion, wound tint, gib spray) is validated by **playtest**, not unit tests. Do not write tests that assert on `rand()`-driven particle output.
- **`fxKill` is NOT changed** — it stays keyed on enemy type (`big: boolean`). Do not add intensity to it.
- TypeScript: `noUncheckedIndexedAccess` is on — index access yields `T | undefined`. Existing code uses `as` casts / non-null patterns; follow the surrounding style.
- Array removal uses swap-and-pop (order not preserved).
- **Commit message footer** (every commit):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj
  ```
- Work happens on branch `spec/combat-gore-feedback` (already checked out).

---

## File Structure

- `game/config.ts` — add the `fx.gore` constant block (Task 1).
- `game/systems/fx.ts` — home of both pure functions (`goreIntensity`, `gibsToSpawn`) and the FX emitters. `fxImpact` gains the intensity param (Task 3); the damage-text system is deleted from here (Task 4).
- `game/systems/fx.test.ts` — **new** co-located unit tests for the two pure functions (Tasks 1–2).
- `game/systems/bullets.ts`, `game/systems/player.ts` — combat hit sites pass intensity, drop damage text (Task 4).
- `game/net/client.ts` — client re-derives intensity at the flash edge (Task 5).
- `game/game.ts` — delete the damage-text draw loop (Task 4); delete the HP bar + add wound tint in the zombie draw (Task 6).
- `game/types.ts`, `game/state.ts` — delete the `DamageText` type / `texts` field / `texts: []` seed (Task 4).

---

### Task 1: `goreIntensity()` pure function + `CONFIG.fx.gore`

**Files:**
- Modify: `game/config.ts` (inside the `fx: { ... }` block)
- Modify: `game/systems/fx.ts:1-5` (import + new export)
- Test: `game/systems/fx.test.ts` (create)

**Interfaces:**
- Produces: `goreIntensity(dmgDealt: number, hpAfter: number, maxHp: number, dmgRef: number, lowHpBand: number, finisherBonus: number): number` — returns 0..1.
- Produces: `CONFIG.fx.gore` with fields `dmgRef`, `lowHpBand`, `finisherBonus`, `specks`, `sparks`, `poolBigAt`, `gibThreshold`, `gibCount`, `gibFillCap`, `woundTint`, `woundDarken`.

- [ ] **Step 1: Add the `fx.gore` CONFIG block.** In `game/config.ts`, inside `fx: {`, after the `blood: { ... },` object, add:

```ts
    gore: {
      dmgRef: 90, // damage that saturates the "weapon weight" base intensity
      lowHpBand: 0.33, // hp fraction below which the finisher bonus ramps in
      finisherBonus: 0.6, // extra intensity for a near-lethal / killing hit
      sparks: [6, 16] as [number, number], // impact spark count, lerped by intensity (min = today's 6)
      specks: [3, 10] as [number, number], // blood-speck count, lerped by intensity (min = today's 3)
      poolBigAt: 0.6, // intensity at/above which the impact leaves a big blood pool
      gibThreshold: 0.5, // intensity below which no flesh chunks fly
      gibCount: [2, 7] as [number, number], // flesh-chunk count, lerped by intensity
      gibFillCap: 0.85, // skip gibs once the particle buffer is this full (reserve muzzle/spark headroom)
      woundTint: [0.5, 0.04, 0.05] as [number, number, number], // blood color the body bleeds toward as hp → 0
      woundDarken: 0.18, // max darkening at 0 hp (small, so finisher targets stay visible in-cone)
    },
```

- [ ] **Step 2: Write the failing test.** Create `game/systems/fx.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { goreIntensity } from "./fx";

const DMG_REF = 90;
const LOW = 0.33;
const BONUS = 0.6;
const gi = (dmg: number, hpAfter: number, maxHp: number) =>
  goreIntensity(dmg, hpAfter, maxHp, DMG_REF, LOW, BONUS);

describe("goreIntensity", () => {
  it("a light hit on a healthy target is small (absolute-damage base only)", () => {
    expect(gi(10, 75, 85)).toBeCloseTo(10 / 90, 6); // ~0.111, finisher=0
    expect(gi(10, 75, 85)).toBeLessThan(0.2);
  });

  it("a heavy hit saturates to 1 even on a high-hp enemy not near death", () => {
    expect(gi(95, 165, 260)).toBe(1); // absScale clamps to 1, finisher=0
  });

  it("a killing blow gets the full finisher bonus even with small damage", () => {
    expect(gi(10, 0, 85)).toBeCloseTo(10 / 90 + BONUS, 6); // ~0.711
    expect(gi(10, -50, 85)).toBeCloseTo(10 / 90 + BONUS, 6); // overkill clamps hpAfter to 0
  });

  it("a near-lethal hit (left inside lowHpBand) ramps the finisher in", () => {
    // hpAfter=10/85=0.1176 fraction → finisher = 1 - 0.1176/0.33
    const finisher = 1 - 10 / 85 / LOW;
    expect(gi(20, 10, 85)).toBeCloseTo(20 / 90 + BONUS * finisher, 6); // ~0.608
    expect(gi(20, 10, 85)).toBeGreaterThan(0.5);
  });

  it("at exactly lowHpBand the finisher is zero (no bonus yet)", () => {
    expect(gi(0, 33, 100)).toBe(0); // frac=0.33 → 1 - 0.33/0.33 = 0
  });

  it("clamps to [0,1]", () => {
    expect(gi(500, -5, 100)).toBe(1);
    expect(gi(0, 100, 100)).toBe(0);
  });

  it("host (dmg) and client (hpDelta) inputs agree for integer hp", () => {
    // client re-derives hpDelta = prev.hp - next.hp; for integer hp this equals dmg
    const prevHp = 85;
    const nextHp = 72;
    expect(gi(13, nextHp, 85)).toBe(gi(prevHp - nextHp, nextHp, 85));
  });
});
```

- [ ] **Step 3: Run the test to verify it fails.**

Run: `bunx vitest run game/systems/fx.test.ts`
Expected: FAIL — `goreIntensity` is not exported from `./fx`.

- [ ] **Step 4: Implement `goreIntensity`.** In `game/systems/fx.ts`, change the math import on line 2 from:

```ts
import { mixRGB, rand } from "../engine/math";
```
to:
```ts
import { clamp, mixRGB, rand } from "../engine/math";
```

Then add (place it near the top of the file, after the `type RGB` line):

```ts
/**
 * Pure gore intensity (0..1) for one hit, split out for unit testing (mirrors
 * flashlightIntensity's scalar style). The base is the weapon's ABSOLUTE damage, so a
 * heavy gun always sprays more; the fraction-of-hp contributes only as a near-lethal
 * "finisher" bonus, so a light tap on a low-hp mob does NOT over-gore.
 */
export function goreIntensity(
  dmgDealt: number,
  hpAfter: number,
  maxHp: number,
  dmgRef: number,
  lowHpBand: number,
  finisherBonus: number,
): number {
  const absScale = clamp(dmgDealt / dmgRef, 0, 1);
  const fracAfter = Math.max(0, hpAfter) / maxHp;
  const finisher =
    hpAfter <= 0 ? 1 : fracAfter <= lowHpBand ? 1 - fracAfter / lowHpBand : 0;
  return clamp(absScale + finisherBonus * finisher, 0, 1);
}
```

- [ ] **Step 5: Run the test to verify it passes.**

Run: `bunx vitest run game/systems/fx.test.ts`
Expected: PASS (all `goreIntensity` cases green).

- [ ] **Step 6: Typecheck.**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit.**

```bash
git add game/config.ts game/systems/fx.ts game/systems/fx.test.ts
git commit -m "feat(fx): pure goreIntensity + CONFIG.fx.gore

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 2: `gibsToSpawn()` pure function (perf throttle)

**Files:**
- Modify: `game/systems/fx.ts:2` (import) + new export
- Test: `game/systems/fx.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `gibsToSpawn(intensity: number, fillRatio: number, threshold: number, countMin: number, countMax: number, fillCap: number): number` — integer count of flesh chunks to emit this hit.

- [ ] **Step 1: Write the failing test.** Append to `game/systems/fx.test.ts`:

```ts
import { gibsToSpawn } from "./fx";

describe("gibsToSpawn", () => {
  // signature: (intensity, fillRatio, threshold=0.5, min=2, max=7, fillCap=0.85)
  it("emits nothing below the intensity threshold", () => {
    expect(gibsToSpawn(0.4, 0, 0.5, 2, 7, 0.85)).toBe(0);
  });

  it("emits nothing once the particle buffer is past the fill cap", () => {
    expect(gibsToSpawn(1, 0.9, 0.5, 2, 7, 0.85)).toBe(0);
  });

  it("emits the full count at max intensity with an empty buffer", () => {
    expect(gibsToSpawn(1, 0, 0.5, 2, 7, 0.85)).toBe(7);
  });

  it("at exactly the threshold it still emits (lerped)", () => {
    expect(gibsToSpawn(0.5, 0, 0.5, 2, 7, 0.85)).toBe(5); // round(lerp(2,7,0.5)=4.5)=5
  });

  it("throttles the count down as the buffer fills", () => {
    expect(gibsToSpawn(1, 0.5, 0.5, 2, 7, 0.85)).toBe(4); // round(7 * 0.5 = 3.5) = 4
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bunx vitest run game/systems/fx.test.ts`
Expected: FAIL — `gibsToSpawn` is not exported from `./fx`.

- [ ] **Step 3: Implement `gibsToSpawn`.** In `game/systems/fx.ts`, update the math import (line 2) to include `lerp`:

```ts
import { clamp, lerp, mixRGB, rand } from "../engine/math";
```

Add, right after `goreIntensity`:

```ts
/**
 * Pure: how many flesh chunks a hit should emit. Gated by an intensity threshold and
 * throttled against the live particle fill ratio so gibs (the only NEW particle source)
 * can never starve muzzle/spark/blood FX out of the shared cap. Stateless — no live-gib
 * counter to keep in sync with expiry.
 */
export function gibsToSpawn(
  intensity: number,
  fillRatio: number,
  threshold: number,
  countMin: number,
  countMax: number,
  fillCap: number,
): number {
  if (intensity < threshold) return 0;
  if (fillRatio >= fillCap) return 0;
  return Math.round(lerp(countMin, countMax, intensity) * (1 - fillRatio));
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bunx vitest run game/systems/fx.test.ts`
Expected: PASS (both `goreIntensity` and `gibsToSpawn` suites green).

- [ ] **Step 5: Typecheck + commit.**

Run: `bun run typecheck` → no errors.
```bash
git add game/systems/fx.ts game/systems/fx.test.ts
git commit -m "feat(fx): pure gibsToSpawn throttle (gib budget vs particle cap)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 3: `fxImpact` scales with an optional `intensity` param

**Files:**
- Modify: `game/systems/fx.ts:83-102` (`fxImpact` body + signature)

**Interfaces:**
- Consumes: `gibsToSpawn` (Task 2), `CONFIG.fx.gore` (Task 1), `lerp` (imported in Task 2).
- Produces: `fxImpact(state, x, y, dir, color, intensity = 0)` — the 6 existing callers that omit the arg are unchanged (intensity 0 = today's burst).

- [ ] **Step 1: Replace the `fxImpact` body.** In `game/systems/fx.ts`, replace the whole current function:

```ts
/** sparks where a bullet bites a zombie */
export function fxImpact(state: State, x: number, y: number, dir: number, color: RGB): void {
  for (let i = 0; i < 6; i++) {
    const a = dir + rand(-1.0, 1.0);
    const sp = rand(120, 360);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.1, 0.25),
      rand(1.5, 3.5),
      color,
      "spark",
      7,
    );
  }
  bloodSpeck(state, x, y, color, 3);
  bloodPool(state, x, y, false, dir);
}
```
with:
```ts
/** sparks + blood where a hit bites flesh; richer the harder/closer-to-lethal the hit (intensity 0..1).
 *  intensity defaults to 0 so non-combat callers (wall/barricade/RTB sparks) render exactly as before. */
export function fxImpact(
  state: State,
  x: number,
  y: number,
  dir: number,
  color: RGB,
  intensity = 0,
): void {
  const g = CONFIG.fx.gore;
  const sparks = Math.round(lerp(g.sparks[0], g.sparks[1], intensity));
  for (let i = 0; i < sparks; i++) {
    const a = dir + rand(-1.0, 1.0);
    const sp = rand(120, 360);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.1, 0.25),
      rand(1.5, 3.5),
      color,
      "spark",
      7,
    );
  }
  bloodSpeck(state, x, y, color, Math.round(lerp(g.specks[0], g.specks[1], intensity)));
  bloodPool(state, x, y, intensity >= g.poolBigAt, dir);
  // flesh chunks on heavy / finishing hits — throttled so they never starve muzzle/spark FX
  const fill = state.particles.length / CONFIG.fx.maxParticles;
  const gibs = gibsToSpawn(intensity, fill, g.gibThreshold, g.gibCount[0], g.gibCount[1], g.gibFillCap);
  for (let i = 0; i < gibs; i++) {
    const a = dir + rand(-0.7, 0.7);
    const sp = rand(80, 260);
    spawn(
      state,
      x,
      y,
      Math.cos(a) * sp,
      Math.sin(a) * sp,
      rand(0.25, 0.5),
      rand(2, 4.5),
      color,
      "shard",
      4,
    );
  }
}
```

- [ ] **Step 2: Verify the floor (intensity 0 = today's burst) by reading the code.** Confirm: `lerp(6,16,0)=6` sparks, `lerp(3,10,0)=3` specks, `0 >= 0.6` is false (small pool), `gibsToSpawn(0,...) = 0` (below threshold). Identical to the old body. ✓

- [ ] **Step 3: Typecheck — the other 5 `fxImpact` callers must still compile.**

Run: `bun run typecheck`
Expected: no errors (callers at `bullets.ts:27`, `ai.ts:150`, `deployables.ts:63`, `client.ts:240`, `client.ts:259` omit the new optional arg).

- [ ] **Step 4: Run the full test suite (no behavior regression).**

Run: `bun run test`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add game/systems/fx.ts
git commit -m "feat(fx): intensity-scaled fxImpact (blood/sparks/gibs)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 4: Remove the damage-number system + pass intensity at combat hits

**Files:**
- Modify: `game/systems/bullets.ts:7` (import), `game/systems/bullets.ts:45-46` (hit)
- Modify: `game/systems/player.ts:48` (import), `game/systems/player.ts:236-237` (melee hit)
- Modify: `game/systems/fx.ts` (delete `MAX_TEXTS`, `fxDamageText`, the texts-decay loop)
- Modify: `game/game.ts:610-615` (delete damage-text draw loop)
- Modify: `game/types.ts` (delete `DamageText` interface + `texts` field)
- Modify: `game/state.ts:70` (delete `texts: []`)

**Interfaces:**
- Consumes: `goreIntensity` + `fxImpact(...,intensity)` (Tasks 1, 3).
- Produces: `state.texts`, `DamageText`, `fxDamageText` no longer exist.

- [ ] **Step 1: Rewire the bullet hit.** In `game/systems/bullets.ts`, change the import on line 7 from:

```ts
import { fxDamageText, fxImpact, fxKill } from "./fx";
```
to:
```ts
import { fxImpact, fxKill, goreIntensity } from "./fx";
```
Then replace lines 45-46:
```ts
          fxImpact(state, b.x, b.y, dir, b.color);
          fxDamageText(state, z.x, z.y - z.r, b.dmg, b.dmg >= 30);
```
with:
```ts
          const g = CONFIG.fx.gore;
          fxImpact(state, b.x, b.y, dir, b.color, goreIntensity(b.dmg, z.hp, z.maxHp, g.dmgRef, g.lowHpBand, g.finisherBonus));
```
(`z.hp` was already decremented two lines above at `z.hp -= b.dmg`; `CONFIG` is already imported at the top of `bullets.ts`.)

- [ ] **Step 2: Rewire the melee hit.** In `game/systems/player.ts`, change the import on line 48 from:

```ts
import { fxDamageText, fxImpact } from "./fx";
```
to:
```ts
import { fxImpact, goreIntensity } from "./fx";
```
Then replace lines 236-237:
```ts
    fxImpact(state, z.x, z.y, p.aim, wd.color);
    fxDamageText(state, z.x, z.y - z.r, wd.dmg * p.dmgMul, true);
```
with:
```ts
    const g = CONFIG.fx.gore;
    fxImpact(state, z.x, z.y, p.aim, wd.color, goreIntensity(wd.dmg * p.dmgMul, z.hp, z.maxHp, g.dmgRef, g.lowHpBand, g.finisherBonus));
```
(`z.hp` was already decremented at `z.hp -= wd.dmg * p.dmgMul`; `CONFIG` is imported at line 1 of `player.ts`.)

- [ ] **Step 3: Delete `fxDamageText` + `MAX_TEXTS` + the texts-decay loop in `fx.ts`.**
  - Delete line 5: `const MAX_TEXTS = 160;`
  - Delete the entire `export function fxDamageText(...) { ... }` block (the function that pushes to `state.texts`).
  - In `sysFx`, delete the text-decay block:
    ```ts
      const T = state.texts;
      for (let i = T.length - 1; i >= 0; i--) {
        const t = T[i] as (typeof T)[number];
        t.life -= dt;
        if (t.life <= 0) {
          T[i] = T[T.length - 1] as (typeof T)[number];
          T.pop();
          continue;
        }
        t.y += t.vy * dt;
        t.vy *= Math.exp(-3 * dt);
      }
    ```

- [ ] **Step 4: Delete the damage-text draw loop in `game.ts`.** Remove lines 610-615:

```ts
  // --- floating damage numbers ---
  for (const t of state.texts) {
    const a = Math.min(1, t.life / t.maxLife);
    if (t.crit) R.number(t.x, t.y, t.value, 20, 1, 0.75, 0.2, a);
    else R.number(t.x, t.y, t.value, 13, 1, 1, 0.85, a * 0.9);
  }
```
(Leave the `drawAtmosphere(...)` call above it and `R.flush(...)` below it intact. Do **not** touch `R.number` — it is still used for the co-op player-id label.)

- [ ] **Step 5: Delete the `DamageText` type + `texts` field in `types.ts`.**
  - Delete the whole `interface DamageText { ... }` block.
  - Delete the `texts: DamageText[];` line from the `State` interface.

- [ ] **Step 6: Delete the `texts` seed in `state.ts`.** Remove the `texts: [],` line (around line 70 in `newState()`).

- [ ] **Step 7: Verify no residual references.**

Run: `grep -rn "fxDamageText\|DamageText\|state\.texts\|\.texts\b\|MAX_TEXTS" game/`
Expected: **no output** (every reference removed).

- [ ] **Step 8: Typecheck + full tests.**

Run: `bun run typecheck` → no errors.
Run: `bun run test` → PASS.

- [ ] **Step 9: Commit.**

```bash
git add game/systems/bullets.ts game/systems/player.ts game/systems/fx.ts game/game.ts game/types.ts game/state.ts
git commit -m "feat(fx): remove damage numbers; combat hits drive gore intensity

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 5: Client re-derives intensity at the flash edge (co-op)

**Files:**
- Modify: `game/net/client.ts:10` (import), `game/net/client.ts:236-242` (flash-edge block)

**Interfaces:**
- Consumes: `goreIntensity` (Task 1), `CONFIG.fx.gore` (already imported as `CONFIG`).
- Produces: client gore bursts scale with the re-derived intensity. Single-player is untouched (this file only runs in client mode).

- [ ] **Step 1: Add `goreIntensity` to the fx import.** In `game/net/client.ts`, change line 10 from:

```ts
import { fxHurt, fxImpact, fxKill } from "../systems/fx";
```
to:
```ts
import { fxHurt, fxImpact, fxKill, goreIntensity } from "../systems/fx";
```

- [ ] **Step 2: Re-derive intensity from the snapshot diff.** Replace the flash-edge block (lines 236-242):

```ts
    for (const z of next.zombies) {
      const p = pz.get(z.id);
      if (p && z.flash > p.flash + 0.01) {
        const t = ENEMY_TYPES[z.type];
        fxImpact(st, z.x, z.y, Math.random() * Math.PI * 2, (t?.color ?? GREY) as RGB);
        Audio.hit();
      }
    }
```
with:
```ts
    for (const z of next.zombies) {
      const p = pz.get(z.id);
      if (p && z.flash > p.flash + 0.01) {
        const t = ENEMY_TYPES[z.type];
        // re-derive gore strength from the synced hp drop (no dmg travels in snapshots).
        // Exact for non-lethal hits; the killing-frame finisher spray is host-only (see spec §E).
        const g = CONFIG.fx.gore;
        const intensity = goreIntensity(p.hp - z.hp, z.hp, z.maxHp, g.dmgRef, g.lowHpBand, g.finisherBonus);
        fxImpact(st, z.x, z.y, Math.random() * Math.PI * 2, (t?.color ?? GREY) as RGB, intensity);
        Audio.hit();
      }
    }
```

- [ ] **Step 3: Typecheck + tests.**

Run: `bun run typecheck` → no errors.
Run: `bun run test` → PASS.

- [ ] **Step 4: Commit.**

```bash
git add game/net/client.ts
git commit -m "feat(net): client re-derives gore intensity from hp-diff at flash edge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 6: Remove zombie HP bar + add wound tint

**Files:**
- Modify: `game/game.ts:477-482` (body color → wound tint), `game/game.ts:523-530` (delete HP bar)

**Interfaces:**
- Consumes: `CONFIG.fx.gore.woundTint` / `woundDarken` (Task 1).
- Produces: a hp-driven body tint replaces the bar. Draw-only; identical on host/client/single-player (`hp`/`maxHp` are synced).

- [ ] **Step 1: Replace the body-color computation with a wound tint.** In `game/game.ts`, replace lines 477-482:

```ts
    const fl = z.flash > 0 ? z.flash / 0.12 : 0;
    const col: [number, number, number] = [
      z.color[0] + (1 - z.color[0]) * fl,
      z.color[1] + (1 - z.color[1]) * fl,
      z.color[2] + (1 - z.color[2]) * fl,
    ];
```
with:
```ts
    const fl = z.flash > 0 ? z.flash / 0.12 : 0;
    // wound: bleed the body toward blood color + darken slightly as hp drops (persistent),
    // then layer the transient white hit-flash on top. The body is non-additive, so this
    // still goes black outside the flashlight cone — no leak of lurkers in the dark.
    const wound = 1 - z.hp / z.maxHp;
    const gg = CONFIG.fx.gore;
    const dk = 1 - gg.woundDarken * wound;
    const wr = (z.color[0] + (gg.woundTint[0] - z.color[0]) * wound) * dk;
    const wg = (z.color[1] + (gg.woundTint[1] - z.color[1]) * wound) * dk;
    const wb = (z.color[2] + (gg.woundTint[2] - z.color[2]) * wound) * dk;
    const col: [number, number, number] = [
      wr + (1 - wr) * fl,
      wg + (1 - wg) * fl,
      wb + (1 - wb) * fl,
    ];
```

- [ ] **Step 2: Delete the HP bar.** Remove the block at lines 523-530:

```ts
    // hp bar
    const f = z.hp / z.maxHp;
    if (f < 1 && z.spawnT <= 0) {
      const w = z.r * 1.6;
      const by = z.y - z.r - 7;
      R.rect(z.x, by, w, 3, 0, 0, 0, 0, 0.5);
      R.rect(z.x - (w * (1 - f)) / 2, by, w * f, 3, 0, 0.9 - 0.6 * f, 0.2 + 0.6 * f, 0.15, 0.95);
    }
```

- [ ] **Step 3: Typecheck + tests.**

Run: `bun run typecheck` → no errors.
Run: `bun run test` → PASS.

- [ ] **Step 4: Commit.**

```bash
git add game/game.ts
git commit -m "feat(fx): drop zombie HP bar; wound tint reads damage by feel

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 7: Feel-first playtest gate (NOT done until felt)

No code. This task is the verification CLAUDE.md mandates for anything touching feel. Do not mark the feature complete until every item is confirmed by playing.

- [ ] **Step 1: Build sanity (mirrors CI).**

Run: `bun run lint && bun run typecheck && bun run test`
Expected: all green.

- [ ] **Step 2: Single-player playtest.** Run `bun run dev`, open http://localhost:5173, start a run, fight into the night, and confirm by feel:
  - [ ] Heavy weapons are visibly gorier than light ones; finishing a near-dead zombie pops satisfyingly.
  - [ ] A light tap on a full-HP mob is NOT over-gored (no accidental gib spray).
  - [ ] Wounded zombies read as wrecked without a bar; finisher targets stay visible inside the cone (not blacked out).
  - [ ] **Muzzle flash never disappears under sustained fire into a crowd** (the gib fill-cap holds). Pass/fail.
  - [ ] No floating numbers and no HP bars anywhere.
  - If a knob feels wrong, tune `CONFIG.fx.gore` only, then re-play. Commit any tuning separately.

- [ ] **Step 3: Co-op playtest.** Run `bun run dev:coop` (one-time: `cd worker && bun install`), host on one tab/device and join on another, and confirm:
  - [ ] Host and client gore look acceptably similar on non-lethal hits (no jarring asymmetry).
  - [ ] Kill bursts match (type-based) on both ends.
  - [ ] Wound-visibility judgement is deferred to the joint **Spec ④** (darkness) playtest — note anything that looks off but don't fix it here.

- [ ] **Step 4: Finish the branch.** Once felt-good, use the `superpowers:finishing-a-development-branch` skill to decide merge / PR. CI (`check` + `worker`) gates the merge.

---

## Self-Review (completed by plan author)

**Spec coverage:** §A goreIntensity → Task 1. §B fxImpact scaling + floor + gib throttle → Tasks 2-3. §C remove damage numbers → Task 4. §D HP bar → wound tint → Task 6. §E client re-derive → Task 5. §F perf (gib fill-cap) → Tasks 2-3; tests → Tasks 1-2; non-goals (fxKill unchanged, no aggregation) → respected (no task touches `fxKill` or adds hit-coalescing). CONFIG block → Task 1. Playtest acceptance → Task 7. No gaps.

**Placeholder scan:** every code step shows full code; commands have expected output; no TBD/TODO. Clear.

**Type consistency:** `goreIntensity(dmgDealt, hpAfter, maxHp, dmgRef, lowHpBand, finisherBonus)` and `gibsToSpawn(intensity, fillRatio, threshold, countMin, countMax, fillCap)` are used with matching arg order/types in Tasks 3-5. `fxImpact`'s new optional `intensity` is consistent across Tasks 3-5. `CONFIG.fx.gore` field names (`dmgRef`/`lowHpBand`/`finisherBonus`/`sparks`/`specks`/`poolBigAt`/`gibThreshold`/`gibCount`/`gibFillCap`/`woundTint`/`woundDarken`) match between Task 1 definition and all consumers.

**Note on spec naming:** the spec listed `poolScale`; this plan implements it concretely as `poolBigAt` (an intensity threshold above which the impact leaves a big pool, reusing `bloodPool`'s existing `big` boolean) to avoid reworking `bloodPool`'s signature. Same design intent (pool grows with intensity).
