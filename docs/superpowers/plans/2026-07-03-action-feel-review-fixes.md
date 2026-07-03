# Action Feel Review-Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three PR #42 review findings at their root cause (re-anchor two co-op client re-derivations to the host's authoritative signals; extract a shared midpoint helper) plus one PR-body wording correction.

**Architecture:** Fixes 1 & 3 change condition guards inside `Client.effects()` (co-op client only; never runs in single-player) so the client re-derives a burst/mote from the *same* signal the host triggers on. Fix 2 adds a pure `segMid` geometry helper and routes the barricade-midpoint call sites through it, which also removes the in-function duplication the review flagged. Fix 4 is documentation only.

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess), custom WebGL2 renderer, Vitest, Bun, Biome. Design doc: `docs/superpowers/specs/2026-07-03-action-feel-review-fixes-design.md`.

## Global Constraints

- **No band-aids.** Re-anchor to the authoritative signal (`assistT`, `healT`) or express the guard's intent — never a magic-number tweak or a phase-transition special-case. (spec)
- **Single-player sim logic unchanged.** Fixes 1 & 3 touch only `Client.effects()` (client-only). Fix 2 changes only where a cosmetic burst/spark is positioned. (spec)
- **No wire change.** Uses already-synced fields (`assistT`, `healT`, `hp`). `PROTOCOL_VERSION` is NOT bumped; the snapshot golden-hash test is NOT touched. (spec)
- **Feel is not unit-tested (CLAUDE.md).** Only the pure `segMid` helper gets a Vitest test. Fixes 1, 3 (feel) gate on `typecheck` + `lint` + a stated 2-tab co-op playtest, not a unit test.
- **Biome** auto-formats on commit (pre-commit hook `biome check --write`); wrapped multi-line conditions will be normalized — don't hand-fight the formatter.
- **Commits:** end commit messages with the repo's `Co-Authored-By` / `Claude-Session` trailers (project convention).
- **Locate edits by the quoted before-text, not raw line numbers.** Line numbers here are a plan-authoring snapshot; Task 2 then Tasks 3/4 edit the same `client.ts` region in sequence, so later line numbers drift. Match each edit by its verbatim `before` snippet (or grep), never by the cited line.

---

### Task 1: `segMid` pure geometry helper

**Files:**
- Modify: `game/engine/geometry.ts` (add `segMid` after `closestPointOnSegment`, line 19)
- Test: `game/engine/geometry.test.ts` (add `segMid` to the import + a `describe` block)

**Interfaces:**
- Produces: `function segMid(x1: number, y1: number, x2: number, y2: number): { x: number; y: number }` — the midpoint of a segment / a barricade's two endpoints. Returns `{ x, y }` to match `closestPointOnSegment`'s convention. Consumed by Task 2.

- [ ] **Step 1: Write the failing test**

In `game/engine/geometry.test.ts`, add `segMid` to the existing import from `./geometry`:

```ts
import {
  circlePush,
  circlePushFromSegment,
  closestPointOnSegment,
  segMid,
  segmentHitsSegment,
} from "./geometry";
```

Then add this `describe` block (anywhere at top level, e.g. after the `closestPointOnSegment` block):

```ts
describe("segMid", () => {
  it("returns the midpoint of a segment", () => {
    expect(segMid(0, 0, 10, 4)).toEqual({ x: 5, y: 2 });
  });
  it("handles negative coordinates", () => {
    expect(segMid(-4, -2, 4, 2)).toEqual({ x: 0, y: 0 });
  });
  it("returns the point itself for a degenerate (zero-length) segment", () => {
    expect(segMid(3, 7, 3, 7)).toEqual({ x: 3, y: 7 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- geometry`
Expected: FAIL — `segMid` is not exported (import error / "segMid is not a function").

- [ ] **Step 3: Write the implementation**

In `game/engine/geometry.ts`, add immediately after `closestPointOnSegment` (after line 19, before the `circlePushFromSegment` doc comment):

```ts
/** Midpoint of segment AB (also the midpoint of a barricade/wall's two endpoints). */
export function segMid(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number } {
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- geometry`
Expected: PASS (all `segMid` cases + the existing geometry tests).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add game/engine/geometry.ts game/engine/geometry.test.ts
git commit -m "feat(geometry): add segMid segment-midpoint helper"
```

---

### Task 2: Route barricade-midpoint sites through `segMid` (resolves the in-function duplication)

**Files:**
- Modify: `game/systems/player.ts` (import line 6; nearest-barricade search ~lines 300-302; repair path ~lines 379-388)
- Modify: `game/net/client.ts` (add geometry import; repair-complete re-derivation ~lines 304-306)

**Interfaces:**
- Consumes: `segMid` from Task 1.

This is a behavior-preserving refactor — it gates on `typecheck` + existing tests, not a new unit test. The repair-path change removes the duplicated midpoint (`mx2/my2` computed again as `mx/my`) that the review flagged.

- [ ] **Step 1: Extend the `player.ts` geometry import**

In `game/systems/player.ts` line 6, change:

```ts
import { circlePushFromSegment } from "../engine/geometry";
```

to:

```ts
import { circlePushFromSegment, segMid } from "../engine/geometry";
```

- [ ] **Step 2: Convert the nearest-barricade-target midpoint in `player.ts`**

In the nearest-damaged-barricade loop (~lines 300-302), replace:

```ts
    const mx = (b.x1 + b.x2) / 2;
    const my = (b.y1 + b.y2) / 2;
    const d = len(mx - p.x, my - p.y);
```

with:

```ts
    const m = segMid(b.x1, b.y1, b.x2, b.y2);
    const d = len(m.x - p.x, m.y - p.y);
```

- [ ] **Step 3: Convert the repair path in `player.ts` (removes the duplicate)**

In the `else if (bar && ...)` repair branch (~lines 379-388), replace:

```ts
      const mx2 = (bar.x1 + bar.x2) / 2;
      const my2 = (bar.y1 + bar.y2) / 2;
      fxImpact(state, mx2, my2, p.aim, [0.85, 0.7, 0.35]); // sparks (intensity 0 = wall-spark look)
      fxDust(state, mx2, my2, CONFIG.actionFeel.repair.dust);
      // completion: barricade just reached full → burst on the segment midpoint
      if (before < bar.maxHp && bar.hp >= bar.maxHp) {
        const mx = (bar.x1 + bar.x2) / 2;
        const my = (bar.y1 + bar.y2) / 2;
        fxActionBurst(state, mx, my, [0.8, 0.7, 0.3], false);
      }
```

with (one midpoint, reused by sparks/dust and the completion burst):

```ts
      const mid = segMid(bar.x1, bar.y1, bar.x2, bar.y2);
      fxImpact(state, mid.x, mid.y, p.aim, [0.85, 0.7, 0.35]); // sparks (intensity 0 = wall-spark look)
      fxDust(state, mid.x, mid.y, CONFIG.actionFeel.repair.dust);
      // completion: barricade just reached full → burst on the segment midpoint
      if (before < bar.maxHp && bar.hp >= bar.maxHp) {
        fxActionBurst(state, mid.x, mid.y, [0.8, 0.7, 0.3], false);
      }
```

- [ ] **Step 4: Add the geometry import to `client.ts`**

`game/net/client.ts` has no geometry import. Add it after `import { Audio } from "../engine/audio";` (keeps the engine-import group together):

```ts
import { segMid } from "../engine/geometry";
```

- [ ] **Step 5: Convert the repair-complete re-derivation in `client.ts`**

In `Client.effects()`, the barricade repair-complete loop (~lines 304-306), replace:

```ts
        const mx = (bar.x1 + bar.x2) / 2;
        const my = (bar.y1 + bar.y2) / 2;
        fxActionBurst(st, mx, my, [0.8, 0.7, 0.3], false);
```

with:

```ts
        const m = segMid(bar.x1, bar.y1, bar.x2, bar.y2);
        fxActionBurst(st, m.x, m.y, [0.8, 0.7, 0.3], false);
```

> **Left inline on purpose (do NOT convert):** `game.ts` nearest-barricade distance (`Math.hypot((b.x1+b.x2)/2 - p.x, …)`) and `drawSeg` (`cx/cy`) — both are hot per-frame paths where introducing a `{x,y}` allocation isn't clearly better than the inline form, and `drawSeg` is a generic segment midpoint, not a barricade. Bounded scope: convert only the three barricade sites above.

- [ ] **Step 6: Typecheck + lint + full tests**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS (behavior-preserving; the golden snapshot test is untouched).

- [ ] **Step 7: Commit**

```bash
git add game/systems/player.ts game/net/client.ts
git commit -m "refactor(fx): use segMid for barricade midpoints; drop repair-path duplication"
```

---

### Task 3: Re-anchor the revive burst to the assist gauge (Fix 1)

**Files:**
- Modify: `game/net/client.ts` (revive edge in `Client.effects()`, currently `if (p && p.hp <= 0 && pl.hp > 0)`)

**Interfaces:**
- Consumes: `p.assistT` (already synced, `f32`).

Feel change → no unit test; gates on typecheck/lint + co-op playtest.

- [ ] **Step 1: Add the `assistT` guard + explanatory comment**

In `Client.effects()`, replace:

```ts
      if (p && p.hp <= 0 && pl.hp > 0) {
        fxActionBurst(st, pl.x, pl.y, [0.4, 1, 0.6], true);
      }
```

with:

```ts
      // peer-revive completion only: anchor to the assist gauge (the host fires this burst in
      // sysAssist). A tended teammate always shows assistT>0 in the prev snapshot, while the
      // dawn batch-respawn (revivePlayer, no tending) has assistT==0 — so this no longer
      // bursts at dawn, matching the host. (Rare: an interrupt→immediate-resume revive can
      // show assistT==0 in prev and drop the burst — cosmetic only, never a false fire.)
      if (p && p.hp <= 0 && p.assistT > 0 && pl.hp > 0) {
        fxActionBurst(st, pl.x, pl.y, [0.4, 1, 0.6], true);
      }
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 3: Co-op playtest (2 tabs)**

Run: `bun run dev:coop` (or two browser tabs via room code). Then:
1. Down one player, stand the other on them until they get up → expect **one** green shockwave burst on revive.
2. Let a player stay down until the wave clears and dawn arrives → expect **no** revive burst on the dawn respawn (previously a burst appeared on the client only).

Expected: burst on in-field revive; no burst at dawn. (Feel-first: this must be *seen*, not just compiled.)

- [ ] **Step 4: Commit**

```bash
git add game/net/client.ts
git commit -m "fix(coop): anchor client revive burst to assistT (no dawn-respawn burst)"
```

---

### Task 4: Re-anchor the mate-heal mote to exclude self-heal completion (Fix 3)

**Files:**
- Modify: `game/net/client.ts` (mate-heal mote edge in `Client.effects()`, currently `if (p && pl.hp > p.hp + 1 && p.hp > 0 && pl.hp < pl.maxHp + 1 && pl.healT <= 0.05)`)

**Interfaces:**
- Consumes: `p.healT` (prev snapshot's, already synced).

Feel change → no unit test; gates on typecheck/lint + co-op playtest.

- [ ] **Step 1: Require self-heal inactive at BOTH interval ends**

In `Client.effects()`, replace:

```ts
      if (p && pl.hp > p.hp + 1 && p.hp > 0 && pl.hp < pl.maxHp + 1 && pl.healT <= 0.05) {
        fxMote(st, pl.x, pl.y, [0.3, 1, 0.45]);
      }
```

with:

```ts
      // mate-heal mote: an external hp bump (a teammate's medkit) while this player is NOT
      // self-healing at EITHER end of the interval. Requiring prev healT<=0.05 too excludes
      // the self-heal *completion* tick (prev still had healT>0.05), which otherwise emitted a
      // stray mote alongside the completion burst. No pickup/upgrade raises a live player's hp.
      if (
        p &&
        pl.hp > p.hp + 1 &&
        p.hp > 0 &&
        pl.hp < pl.maxHp + 1 &&
        p.healT <= 0.05 &&
        pl.healT <= 0.05
      ) {
        fxMote(st, pl.x, pl.y, [0.3, 1, 0.45]);
      }
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS (biome may reformat the wrapped condition — accept its formatting).

- [ ] **Step 3: Co-op playtest (2 tabs)**

Run: `bun run dev:coop`. Then:
1. On one client, damage a teammate, then heal them with a medkit (held E, mate-heal) → expect green motes rising on the healed teammate.
2. On a client, self-heal (H) to completion → expect the green completion burst only, with **no** extra stray mote at the finish.

Expected: mate-heal shows motes; self-heal completion shows burst without a duplicate mote.

- [ ] **Step 4: Commit**

```bash
git add game/net/client.ts
git commit -m "fix(coop): exclude self-heal completion from mate-heal mote re-derivation"
```

---

### Task 5: PR #42 body wording accuracy (Fix 4, no code)

**Files:**
- Modify: the PR #42 description on GitHub (no repository file).

This is an outward-facing change to the PR. Do NOT run `gh pr edit` without the user's go-ahead — present the replacement text first.

- [ ] **Step 1: Draft the replacement bullet**

In the PR body's "不変条件（レビューで検証済み）" section, the current bullet reads:

> - **単発プレイはシム的にバイト不変**：唯一のリスクは `searching` を昼夜で立てるようにした点。AI の zombie lure は `ai.ts` を `if (state.phase === "night")` で囲み、昼に lure が発生しないよう保護した。

Replace it with (distinguishes logic-invariance from RNG-stream shift):

> - **単発プレイのシムのロジック経路は不変**：唯一のロジック上のリスクは `searching` を昼夜で立てるようにした点で、AI の zombie lure は `ai.ts` を `if (state.phase === "night")` で囲み昼に lure が発生しないよう保護した。なお FX をシム経路で `Math.random()` 経由に呼ぶため**グローバル乱数列自体は前後でずれる**が、本プロジェクトに決定論契約（シード RNG・replay・lockstep）が無いため無害。

- [ ] **Step 2: Apply after user confirmation**

Once the user approves the wording, apply it with:

```bash
gh pr view https://github.com/sano-suguru/quarantine/pull/42 --json body -q .body > /tmp/pr42-body.md
# edit /tmp/pr42-body.md: swap the bullet per Step 1
gh pr edit https://github.com/sano-suguru/quarantine/pull/42 --body-file /tmp/pr42-body.md
```

Expected: the PR body shows the corrected bullet. No code, no commit.

---

## Self-Review

**Spec coverage:**
- Fix 1 (revive-burst re-anchor) → Task 3. ✓
- Fix 2 (`segMid` helper + call-site conversion + duplication removal) → Task 1 (helper+test) + Task 2 (conversion). ✓
- Fix 3 (mate-heal mote self-heal exclusion) → Task 4. ✓
- Fix 4 (PR body wording) → Task 5. ✓
- Out-of-scope items (no wire change, no full midpoint sweep, no client healT prediction, no floating text) — respected: no task bumps `PROTOCOL_VERSION`, Task 2 explicitly leaves `game.ts`/`drawSeg` inline. ✓

**Placeholder scan:** No TBD/TODO; every code step shows verbatim before/after; every command has an expected result. ✓

**Type consistency:** `segMid(x1,y1,x2,y2): { x, y }` defined in Task 1 and consumed identically in Task 2 (`m.x`/`m.y`, `mid.x`/`mid.y`). No signature drift. ✓
