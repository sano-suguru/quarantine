# Integrity De-tell (Diegetic Feedback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the HUD-top Integrity bar (`#hpbar`) + number (`#hpnum`) and migrate the "how hurt am I" readout to a continuous HP-driven world desaturation+dimming (a CSS `filter` on the `#game` canvas), leaving the existing heartbeat + red `#dread-pulse` as the unchanged near-death alarm.

**Architecture:** A new pure function `integrityGrade(hpFrac, onset, gamma)` (modeled on `flashlightIntensity`) maps the camera-followed player's HP to a 0..1 grade. `updateHUD` turns that grade into a `saturate()/brightness()` filter string and writes it to the `#game` canvas only when it changes. The sim and renderer are untouched — the filter is a presentation layer — so single-player stays byte-for-byte and no net code is involved.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vite, Bun, Vitest (co-located `*.test.ts`, `environment: "node"`), Biome (lint+format). CSS in `game/style.css`.

Spec: `docs/superpowers/specs/2026-07-01-integrity-diegetic-feedback-design.md`

## Global Constraints

- **Feel-first:** compile/test passing ≠ done. The visual result is verified by playtest (`bun run dev`), not this plan. Tune `desatOnset`/`desatFloor`/`desatDim`/`desatGamma` in `CONFIG.horror` in-game.
- **Data-driven, no bespoke path:** all tuning lives in `CONFIG.horror`; the new code rides the existing "pure helper + per-frame `updateHUD` CSS-layer" mechanism. No engine/shader changes.
- **Single-player byte-for-byte; net code untouched:** the filter reads `cameraTarget(state)`, which equals `localPlayer(state)` while alive / in single-player. No change to `state`, the sim, the renderer, or `game/net/`.
- **Unit tests only for pure, deterministic code:** `integrityGrade` is tested; the CSS/feel is not (playtested).
- **Branch/commits:** work is on branch `feat/integrity-diegetic-feedback` (already created). Commit messages end with the repository footer (Co-Authored-By + Claude-Session lines), matching prior commits.
- **Quality gates:** pre-commit runs `biome check --write` on staged files; pre-push runs `bun run typecheck` + `bun run test`. Keep both green.

---

### Task 1: Pure `integrityGrade` function + unit tests

**Files:**
- Create: `game/systems/integrity.ts`
- Create: `game/systems/integrity.test.ts`
- Modify: `CLAUDE.md` (add `integrityGrade` to the two tested-helpers lists: line ~39 prose list and line ~82 pure-helpers bullet)

**Interfaces:**
- Consumes: nothing.
- Produces: `export function integrityGrade(hpFrac: number, onset: number, gamma: number): number` — returns `0` at/above `onset` (full color), rising to `1` as `hpFrac → 0`; `gamma < 1` front-loads sensitivity. Used by Task 2.

- [ ] **Step 1: Write the failing test**

Create `game/systems/integrity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { integrityGrade } from "./integrity";

// Signature: (hpFrac, onset, gamma) → 0 at/above onset (full color) .. 1 at hp 0 (death)
describe("integrityGrade", () => {
  it("is 0 (full color) at and above the onset", () => {
    expect(integrityGrade(0.65, 0.65, 0.7)).toBe(0);
    expect(integrityGrade(0.8, 0.65, 0.7)).toBe(0);
    expect(integrityGrade(1, 0.65, 0.7)).toBe(0);
  });

  it("is 1 (max drain) at zero HP", () => {
    expect(integrityGrade(0, 0.65, 0.7)).toBe(1);
  });

  it("clamps to 1 for negative HP (overkill)", () => {
    expect(integrityGrade(-0.2, 0.65, 0.7)).toBe(1);
  });

  it("is linear when gamma is 1", () => {
    // (0.65 - 0.5) / 0.65 = 0.230769
    expect(integrityGrade(0.5, 0.65, 1)).toBeCloseTo(0.230769, 5);
  });

  it("front-loads (sits above linear mid-band) when gamma < 1", () => {
    expect(integrityGrade(0.5, 0.65, 0.7)).toBeGreaterThan(integrityGrade(0.5, 0.65, 1));
    // 0.230769 ** 0.7 ≈ 0.3583
    expect(integrityGrade(0.5, 0.65, 0.7)).toBeCloseTo(0.3583, 3);
  });

  it("rises monotonically as HP drops across the band", () => {
    const g60 = integrityGrade(0.6, 0.65, 0.7);
    const g40 = integrityGrade(0.4, 0.65, 0.7);
    const g10 = integrityGrade(0.1, 0.65, 0.7);
    expect(g40).toBeGreaterThan(g60);
    expect(g10).toBeGreaterThan(g40);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- integrity`
Expected: FAIL — `Failed to resolve import "./integrity"` (the module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `game/systems/integrity.ts`:

```ts
/**
 * Pure HP→world-desaturation grade. Full color (0) at or above `onset` (the calm zone that
 * keeps the day explore phase legible); rises to 1 as HP drains to 0. `gamma` shapes the
 * curve: 1 = linear, < 1 front-loads sensitivity so mid-HP damage is felt (not numb) rather
 * than the whole ramp bunching near death. The caller maps the grade onto a CSS
 * `saturate`/`brightness` filter; the heartbeat + red dread-pulse remain the near-death alarm.
 *
 * Split out as a pure function (like `flashlightIntensity`) so the curve is unit-tested and
 * tunable from CONFIG without touching the renderer.
 */
export function integrityGrade(hpFrac: number, onset: number, gamma: number): number {
  if (hpFrac >= onset) return 0;
  if (hpFrac <= 0) return 1;
  return ((onset - hpFrac) / onset) ** gamma;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- integrity`
Expected: PASS (6 tests).

- [ ] **Step 5: Update CLAUDE.md tested-helpers lists**

In `CLAUDE.md`, append `integrityGrade` to both places that enumerate tested pure helpers:

- Line ~39 (prose list): change `…and \`flashlightIntensity\` (\`game/systems/flashlight.ts\`).` to `…\`flashlightIntensity\` (\`game/systems/flashlight.ts\`), and \`integrityGrade\` (\`game/systems/integrity.ts\`).`
- Line ~82 (pure-helpers bullet): change `\`flashlight\` (\`flashlightIntensity\`), and \`caches\`…` to `\`flashlight\` (\`flashlightIntensity\`), \`integrity\` (\`integrityGrade\`), and \`caches\`…`

- [ ] **Step 6: Commit**

```bash
git add game/systems/integrity.ts game/systems/integrity.test.ts CLAUDE.md
git commit -m "feat(integrity): add pure integrityGrade HP→desaturation helper

Maps the camera player's HP fraction to a 0..1 desaturation grade: full color
at/above onset, rising to 1 at death. gamma<1 front-loads the mid-HP range so
accumulating damage reads before the deep band. Modeled on flashlightIntensity;
unit-tested and CONFIG-tunable.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 2: CONFIG + wire the filter into `updateHUD`

**Files:**
- Modify: `game/config.ts` (add 4 keys at the end of the `horror` block, after `dartLife` on line ~133)
- Modify: `game/game.ts` (import `cameraTarget`; add two module-scope vars; replace the `#hpbar`/`#hpnum` writes at `:921-923`; remove the dead `#hud.low` toggle at `:984,986`; reset filter in `resetAtmosphere`)

**Interfaces:**
- Consumes: `integrityGrade(hpFrac, onset, gamma)` from Task 1; `cameraTarget(state): Player` from `game/engine/players.ts`.
- Produces: nothing for later tasks. After this task the canvas filter is live but the now-static `#hpbar`/`#hpnum` DOM still exists (removed in Task 3) — valid intermediate state (the elements just stop updating).

- [ ] **Step 1: Add CONFIG keys**

In `game/config.ts`, inside the `horror: { … }` block, immediately after the `dartLife: 0.16, // seconds a streak lives` line (~133), add:

```ts
    // HP→world desaturation: the continuous "wound" readout that replaces the Integrity bar.
    // Full color at/above desatOnset (calm zone, day readability); saturation eases to
    // desatFloor and brightness drops by desatDim as HP drains to 0. desatGamma shapes the
    // curve (<1 front-loads so mid-HP damage is felt). The heartbeat + red dread-pulse (gated
    // at lowHp above) stay the separate near-death alarm. All four are playtest-tuned.
    desatOnset: 0.65, // hp fraction at/above which the world is full color
    desatFloor: 0.2, // saturate() multiplier at death (>0 so blood/toxic still read)
    desatDim: 0.18, // brightness() reduction at death (1 → 1 - desatDim)
    desatGamma: 0.7, // curve shaping: <1 front-loads mid-HP sensitivity; 1 = linear
```

- [ ] **Step 2: Import `cameraTarget` in game.ts**

In `game/game.ts:22`, add `cameraTarget` to the `./engine/players` import (keep alphabetical-ish order matching the file):

```ts
import { anyAlive, cameraTarget, localPlayer, nearestPlayer, revivePlayer } from "./engine/players";
```

- [ ] **Step 3: Add module-scope filter cache vars**

In `game/game.ts`, just after the `let prevBattery = 1;` line (~96), add:

```ts
// HP→desaturation filter (Spec ③): cache the #game canvas + last filter string so the DOM is
// touched only when the value changes (HP is stable most frames). Driven from cameraTarget so a
// downed co-op spectator desaturates by the teammate they're watching, not their own corpse.
let gameCanvas: HTMLElement | null = null;
let lastFilter = "";
```

- [ ] **Step 4: Reset the filter on run start / game over**

In `game/game.ts`, inside `resetAtmosphere()` (after `prevBattery = 1;`, ~105), add:

```ts
  lastFilter = "";
  if (gameCanvas) gameCanvas.style.filter = "";
```

- [ ] **Step 5: Replace the bar/number writes with the filter block**

In `game/game.ts`, the current `updateHUD` lines `:921-923` are:

```ts
  el("hpbar").style.width = `${100 * hpf}%`;
  el("hpbar").style.background = hpf < 0.3 ? "var(--blood)" : "var(--toxic)";
  el("hpnum").textContent = `${Math.max(0, Math.ceil(p.hp))} / ${p.maxHp}`;
```

Replace those three lines with (leave `const hpf = …` on `:920` intact — it still feeds the dread block):

```ts
  // HP→world desaturation: continuous "wound" readout replacing the old Integrity bar. Tracks
  // cameraTarget (the player the camera follows) so a downed spectator sees the teammate they
  // watch drained by THAT player's HP; cameraTarget === localPlayer while alive / single-player.
  const cam = cameraTarget(state);
  const cg = integrityGrade(
    Math.max(0, cam.hp) / cam.maxHp,
    CONFIG.horror.desatOnset,
    CONFIG.horror.desatGamma,
  );
  const filter =
    cg > 0
      ? `saturate(${1 - cg * (1 - CONFIG.horror.desatFloor)}) brightness(${1 - cg * CONFIG.horror.desatDim})`
      : ""; // calm zone → no filter (no extra compositing pass)
  if (filter !== lastFilter) {
    (gameCanvas ??= el("game")).style.filter = filter;
    lastFilter = filter;
  }
```

- [ ] **Step 6: Add the integrityGrade import**

At the top of `game/game.ts`, add the import alongside the other `./systems/*` imports:

```ts
import { integrityGrade } from "./systems/integrity";
```

(Exact placement doesn't matter — Biome's import sort runs in the pre-commit hook and will move it into alphabetical order, between `./systems/fx` and `./systems/pickups`, then re-stage. Don't be surprised if its final position differs from where you typed it.)

- [ ] **Step 7: Remove the dead `#hud.low` toggle**

In `game/game.ts`, the dread block currently reads:

```ts
  // dread vignette intensity
  const hud = el("hud");
  const low = hpf < CONFIG.horror.lowHp;
  hud.classList.toggle("low", low);
```

The `.low` CSS class only styled `#hpnum`/`#hpbar-wrap` (removed in Task 3); the red pulse uses the `low` boolean, not the class. Delete the `const hud = el("hud");` line and the `hud.classList.toggle("low", low);` line, keeping `low`:

```ts
  // dread vignette intensity
  const low = hpf < CONFIG.horror.lowHp;
```

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: PASS, no errors (notably no "unused variable `hud`" and no "Cannot find name `cameraTarget`/`integrityGrade`").

- [ ] **Step 9: Run the full test suite**

Run: `bun run test`
Expected: PASS (existing suites + Task 1's `integrity` tests; nothing references `#hpbar`/`#hpnum`).

- [ ] **Step 10: Commit**

```bash
git add game/config.ts game/game.ts
git commit -m "feat(integrity): drive world desaturation from HP in updateHUD

Replace the #hpbar/#hpnum writes with a CSS saturate()/brightness() filter on
#game, graded by integrityGrade from cameraTarget's HP (so a downed co-op
spectator desaturates by the teammate shown, not their corpse). Written only on
change; reset on run start/game over. Drop the now-dead #hud.low toggle (the red
pulse keeps the low boolean). New tuning in CONFIG.horror. Sim/renderer/net
untouched; single-player byte-for-byte.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 3: Remove the Integrity HUD markup/styles + smooth the filter

**Files:**
- Modify: `index.html` (delete lines `:21-23`)
- Modify: `game/style.css` (delete the `#hpbar`/`#hpnum`/`#hud.low`/`hppulse` block `:153-189`; delete the `#hud.low #hpbar-wrap` selector from the `prefers-reduced-motion` rule `:1300`; add `transition: filter` to the `#game` rule `:25-30`)

**Interfaces:**
- Consumes: nothing (markup/style only). Must run **after** Task 2 — Task 2 removes the JS that writes `#hpbar`/`#hpnum`, so removing the elements first would make the old `el("hpbar")` calls throw "Missing element".
- Produces: nothing.

- [ ] **Step 1: Remove the Integrity markup**

In `index.html`, the block is:

```html
    <div class="hud-block">
      <div class="stat-label">Integrity</div>
      <div id="hpbar-wrap"><div id="hpbar"></div></div>
      <div id="hpnum">100 / 100</div>
      <div id="battery">
        <div class="stat-label">Flashlight [F]</div>
      </div>
    </div>
```

Delete the three Integrity lines (the `Integrity` `stat-label`, the `#hpbar-wrap`, and `#hpnum`), keeping the `hud-block` wrapper and the `#battery`/`Flashlight [F]` sub-block:

```html
    <div class="hud-block">
      <div id="battery">
        <div class="stat-label">Flashlight [F]</div>
      </div>
    </div>
```

- [ ] **Step 2: Remove the bar/number CSS block**

In `game/style.css`, delete the entire block from `#hpbar-wrap {` (`:153`) through the end of `@keyframes hppulse { … }` (`:189`) — i.e. these rules: `#hpbar-wrap`, `#hpbar`, `#hpnum`, `#hud.low #hpnum`, `#hud.low #hpbar-wrap`, and `@keyframes hppulse`. Leave the `/* flashlight battery */` rule that follows (`#battery`, ~:191) intact.

- [ ] **Step 3: Remove the dead selector from the reduced-motion rule**

In `game/style.css`, the `prefers-reduced-motion` rule (~:1297) lists `#hud.low #hpbar-wrap` as one of the animation-disabled selectors:

```css
@media (prefers-reduced-motion: reduce) {
  #start,
  .eyebrow .dot,
  #hud.low #hpbar-wrap {
    animation: none;
  }
```

Delete the `#hud.low #hpbar-wrap,` selector line (and its leading comma on the prior line is not needed — keep `.eyebrow .dot` as the last selector before `{`):

```css
@media (prefers-reduced-motion: reduce) {
  #start,
  .eyebrow .dot {
    animation: none;
  }
```

- [ ] **Step 4: Add the filter transition to `#game`**

In `game/style.css`, the `#game` rule (`:25-30`) is:

```css
#game {
  display: block;
  width: 100vw;
  height: 100vh;
  cursor: none;
}
```

Add a transition so HP jumps (medkit, dawn revive, a `cameraTarget` switch) ease the color back instead of popping (duration is a playtest starting point):

```css
#game {
  display: block;
  width: 100vw;
  height: 100vh;
  cursor: none;
  transition: filter 0.25s ease-out;
}
```

- [ ] **Step 5: Verify no dangling references remain**

Run: `grep -rn "hpbar\|hpnum\|hppulse\|hud.low" game/ index.html`
Expected: no matches (every reference is gone). `#ammo.low` is unrelated and must NOT appear in this grep (it has no `hud`/`hp` prefix).

- [ ] **Step 6: Typecheck, lint, and test**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all PASS.

- [ ] **Step 7: Build to confirm the production bundle is clean**

Run: `bun run build`
Expected: `tsc --noEmit` clean + `vite build` writes `dist/` with no errors.

- [ ] **Step 8: Commit**

```bash
git add index.html game/style.css
git commit -m "feat(integrity): remove Integrity HUD bar/number, ease #game filter

Delete #hpbar/#hpnum (+ the #hud.low decorations and @keyframes hppulse) now
that HP reads as world desaturation. Drop the dead #hud.low #hpbar-wrap selector
from the reduced-motion rule and add a 0.25s filter transition on #game so HP
jumps ease rather than pop. Keeps the Flashlight [F] control prompt.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

## Playtest (after Task 3 — mandatory, not a code step)

Run `bun run dev` and verify by feel; tune `CONFIG.horror.desat*` in-game:

- Near-death is unmistakable; mid-HP damage is felt, not numb (the reason for `desatGamma`).
- Full HP reads clean. A wounded player carries desaturation into the day by design ("full health reads clean," not "the day is always clean").
- Recovery (medkit / dawn revive) eases color back smoothly without the desaturation lagging hit-time.
- Drained-dark world + `#dread-pulse` red + `#flash` red don't wash out readability near death.
- The HUD top-left isn't awkwardly cramped after the bar/number are gone (adjust `#battery` margin if needed).
- Co-op: when downed, the spectated teammate's view desaturates by *their* HP (not locked to max) and recovers on dawn revive.

Do not mark the feature done until this is played and confirmed.
