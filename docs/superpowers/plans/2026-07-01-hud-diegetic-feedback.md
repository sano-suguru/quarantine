# HUD De-tell (Diegetic Feedback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove three HUD readouts that narrate state in text/meter (remaining-zombie count, night-search causal annotation, battery text+bar) and let existing experiential channels carry the signal, adding continuous flashlight-cone dimming to replace the battery meter.

**Architecture:** Two edits are pure HUD deletions. The third removes the battery text+bar and compensates by extending the existing pure `flashlightIntensity` function so the cone brightness falls continuously as the battery drains (with a non-zero usable floor and the existing low-battery flicker preserved as a dying-bulb tremor). All edits are HUD/render-only — no sim, AI, or net changes.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vite, Vitest, Biome, Bun. WebGL2 renderer. Vanilla DOM HUD.

## Global Constraints

- **HUD/render-only.** No changes to sim, AI, spawns, or the day/night clock. (CLAUDE.md: systems stay pure; tune via `CONFIG`/`game/data`.)
- **Single-player byte-for-byte unchanged; no net code touched.** `flashlightIntensity` is computed locally per player in `draw()` from synced `battery`/`lightOn`; it must stay a pure render-path function.
- **Data-driven.** New tuning lives in `CONFIG.flashlight`. No bespoke code paths.
- **Control prompts stay; state/fear/causality narration goes.** Keep `[E]`/`[F]`/"stand still to search"; remove counts, meters, and the "(draws the horde)" spoiler.
- **`el()` throws on a missing element.** Every removed DOM id must have *all* its JS references removed in the same task, or the HUD crashes at runtime.
- **Feel-first.** Compile + tests passing ≠ done. The cone-dimming feel and the de-cluttered HUD are validated by a mandatory final playtest (`bun run dev`); not done until felt.
- **Commit footer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj
  ```

---

### Task 1: Continuous flashlight-cone dimming (pure function + CONFIG + call site)

Extend the pure, unit-tested `flashlightIntensity` so the cone steadily dims as the battery drains, bounded by a usable floor, with the existing flicker as a dying-bulb tremor on top. This must land **before** Task 2 removes the battery meter, so the compensating cue exists when the bar goes.

**Files:**
- Modify: `game/systems/flashlight.ts`
- Test: `game/systems/flashlight.test.ts`
- Modify: `game/config.ts` (add `dimFloor`, `dimStart` under `flashlight`)
- Modify: `game/game.ts` (flashlight `cands` push — pass the two new args)

**Interfaces:**
- Produces: `flashlightIntensity(batteryFrac: number, on: boolean, lowThreshold: number, flickerDepth: number, baseFlickerDepth: number, noise: number, dimFloor: number, dimStart: number): number` — adds `dimFloor`, `dimStart` as the 7th/8th params (breaking signature change; all callers and existing tests update).
- Consumes: `CONFIG.flashlight.dimFloor`, `CONFIG.flashlight.dimStart` (added here).

**Design of the new return (steady level + tremor):**
- Steady brightness `base`: full (`1.0`) at charge `>= dimStart`, ramping linearly down to `dimFloor` as charge → 0. `t = min(1, batteryFrac / dimStart); base = dimFloor + (1 - dimFloor) * t`. This keeps a fresh battery bright and reads the dimming as a *progression* toward the dying low state — and `base` never falls below `dimFloor` while lit (usable steady level, no unfair sustained dark).
- Tremor: subtract `depth * noise` from `base` (deeper `flickerDepth` below `lowThreshold`, else `baseFlickerDepth`), clamped to `[0, 1]`. The tremor *may* dip the instantaneous value below `dimFloor` toward 0 — that momentary dip is the dying bulb — but because `noise` is a time-correlated tremor, the perceived/steady brightness stays at `base` (≥ `dimFloor`). At empty (`batteryFrac <= 0`) it returns `0` (cone out — the existing "going dark").
- Starting CONFIG values: `dimFloor: 0.45`, `dimStart: 0.6`. These are playtest-tuned in the final task; the test expectations below are computed against them.

- [ ] **Step 1: Update existing tests + add new cases for the dimming**

Replace the body of `game/systems/flashlight.test.ts` with (note every call now passes `dimFloor=0.45, dimStart=0.6` as the last two args):

```ts
import { describe, expect, it } from "vitest";
import { flashlightIntensity } from "./flashlight";

// Signature: (batteryFrac, on, lowThreshold, flickerDepth, baseFlickerDepth, noise, dimFloor, dimStart)
describe("flashlightIntensity", () => {
  it("is full strength with a healthy battery at the flicker trough (noise 0)", () => {
    // charge 0.8 >= dimStart 0.6 → base 1.0; no flicker dip at noise 0
    expect(flashlightIntensity(0.8, true, 0.25, 0.4, 0.04, 0, 0.45, 0.6)).toBe(1);
  });

  it("flickers subtly even with a healthy battery", () => {
    // base 1.0 - 0.04 * 1 = 0.96 (constant base flicker, not the deep low dip)
    expect(flashlightIntensity(0.8, true, 0.25, 0.4, 0.04, 1, 0.45, 0.6)).toBeCloseTo(0.96);
  });

  it("is zero when switched off", () => {
    expect(flashlightIntensity(0.8, false, 0.25, 0.4, 0.04, 0.5, 0.45, 0.6)).toBe(0);
  });

  it("is zero with a dead battery", () => {
    expect(flashlightIntensity(0, true, 0.25, 0.4, 0.04, 0.5, 0.45, 0.6)).toBe(0);
  });

  it("stays full-bright at or above dimStart", () => {
    // charge 0.6 == dimStart → t 1 → base 1.0
    expect(flashlightIntensity(0.6, true, 0.25, 0.4, 0.04, 0, 0.45, 0.6)).toBe(1);
  });

  it("dims continuously as the battery drains below dimStart (noise 0 isolates base)", () => {
    // charge 0.45 → t 0.75 → base 0.45 + 0.55*0.75 = 0.8625
    expect(flashlightIntensity(0.45, true, 0.25, 0.4, 0.04, 0, 0.45, 0.6)).toBeCloseTo(0.8625, 3);
  });

  it("keeps the steady level at/above dimFloor near empty (battery > 0, noise 0)", () => {
    // charge 0.02 → t 0.0333 → base 0.45 + 0.55*0.0333 = 0.46833 (>= dimFloor 0.45)
    expect(flashlightIntensity(0.02, true, 0.25, 0.4, 0.04, 0, 0.45, 0.6)).toBeCloseTo(0.46833, 4);
  });

  it("is monotonically non-increasing as charge falls (steady, noise 0)", () => {
    const at = (c: number) => flashlightIntensity(c, true, 0.25, 0.4, 0.04, 0, 0.45, 0.6);
    expect(at(0.5)).toBeGreaterThanOrEqual(at(0.3));
    expect(at(0.3)).toBeGreaterThanOrEqual(at(0.1));
  });

  it("the deep low-battery flicker still dips well below the steady level (dying bulb)", () => {
    // charge 0.1 → base 0.45 + 0.55*(0.1/0.6) = 0.541667; deep flicker 0.4*1 → 0.141667
    expect(flashlightIntensity(0.1, true, 0.25, 0.4, 0.04, 1, 0.45, 0.6)).toBeCloseTo(0.141667, 4);
    // but at the trough (noise 0) the steady level is back up at base, still usable
    expect(flashlightIntensity(0.1, true, 0.25, 0.4, 0.04, 0, 0.45, 0.6)).toBeCloseTo(0.541667, 4);
  });

  it("never returns below zero on a deep flicker dip", () => {
    expect(flashlightIntensity(0.05, true, 0.25, 2, 0.04, 1, 0.45, 0.6)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun run test -- flashlight`
Expected: FAIL — the new/updated cases call `flashlightIntensity` with 8 args but the implementation takes 6 (the `dimStart`/`dimFloor` arguments are ignored, so e.g. "dims continuously..." returns 1.0 instead of 0.8625).

- [ ] **Step 3: Extend the pure function**

In `game/systems/flashlight.ts`, replace the function with:

```ts
/**
 * Pure flashlight cone intensity, split out for unit testing.
 * Off or dead battery → 0 (cone gone, only the dim personal pool remains).
 *
 * Steady brightness eases down with the charge: full at/above `dimStart`, ramping to
 * `dimFloor` as the battery empties — a continuously weakening beam stands in for the old
 * battery meter (the encroaching dark). `dimFloor` is a real usable lower bound, so the
 * steady level is never unfairly dark while lit.
 *
 * On top of that steady level a failing-bulb tremor dips by `baseFlickerDepth * noise`
 * at a healthy charge, and by the deeper `flickerDepth * noise` once the battery falls
 * below `lowThreshold`. The tremor may momentarily dip below `dimFloor` toward 0 (the
 * dying-bulb flicker) — that is intentional — while the steady level stays at `base`.
 *
 * `noise` is injected (caller passes a time-correlated 0..1 value) so this stays
 * deterministic and the flicker reads as a tremor rather than per-frame static.
 */
export function flashlightIntensity(
  batteryFrac: number,
  on: boolean,
  lowThreshold: number,
  flickerDepth: number,
  baseFlickerDepth: number,
  noise: number,
  dimFloor: number,
  dimStart: number,
): number {
  if (!on || batteryFrac <= 0) return 0;
  const t = Math.min(1, batteryFrac / dimStart);
  const base = dimFloor + (1 - dimFloor) * t;
  const depth = batteryFrac < lowThreshold ? flickerDepth : baseFlickerDepth;
  return Math.max(0, Math.min(1, base - depth * noise));
}
```

- [ ] **Step 4: Add the CONFIG knobs**

In `game/config.ts`, inside the `flashlight:` block, add after the `baseFlickerDepth` line (`146`):

```ts
    dimFloor: 0.45, // steady cone brightness floor while lit — the beam never dims below this between flickers (fairness)
    dimStart: 0.6, // battery fraction at/above which the cone is full-bright; below it the cone dims toward dimFloor
```

- [ ] **Step 5: Pass the new args at the call site**

In `game/game.ts`, in the per-player light `cands.push` block, update the `flashlightIntensity` call (currently passes 6 args ending in `flickerNoise(state.time, pl.id)`) to also pass the two CONFIG values:

```ts
    const intensity = flashlightIntensity(
      pl.battery / flc.batteryMax,
      pl.lightOn,
      flc.lowThreshold,
      flc.flickerDepth,
      flc.baseFlickerDepth,
      flickerNoise(state.time, pl.id),
      flc.dimFloor,
      flc.dimStart,
    );
```

- [ ] **Step 6: Run tests + typecheck**

Run: `bun run test -- flashlight` → Expected: PASS (all cases).
Run: `bun run typecheck` → Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add game/systems/flashlight.ts game/systems/flashlight.test.ts game/config.ts game/game.ts
git commit -m "feat(fx): continuous flashlight-cone dimming as battery drains

Extend the pure flashlightIntensity with a charge-driven steady level
(full above dimStart, easing to a usable dimFloor as the battery empties)
so a weakening beam stands in for the battery meter. Existing low-battery
flicker preserved as a dying-bulb tremor on top.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 2: Remove the battery text + bar from the HUD

With the cone now carrying battery state, delete the worded state (`OFF`/`DEAD`/`%`) and the fill bar. Keep the `Flashlight [F]` control label.

**Files:**
- Modify: `index.html` (battery block, ~24-27)
- Modify: `game/game.ts` (battery readout block in `updateHUD`, ~939-950)
- Modify: `game/style.css` (battery bar/state rules, 195-234)

**Interfaces:**
- Consumes: Task 1's cone dimming (the replacement signal). No code interface.

- [ ] **Step 1: Remove the `#bat-state` span and the bar from the HTML**

In `index.html`, replace the battery block:

```html
      <div id="battery">
        <div class="stat-label">Flashlight [F] &middot; <span id="bat-state">100%</span></div>
        <div id="batbar-wrap"><div id="batbar"></div></div>
      </div>
```

with (keep the control label only):

```html
      <div id="battery">
        <div class="stat-label">Flashlight [F]</div>
      </div>
```

- [ ] **Step 2: Remove the battery readout block from `updateHUD`**

In `game/game.ts`, delete the entire battery readout block (the `// flashlight battery` comment through the `bat-state` ternary) — i.e. remove these lines:

```ts
  // flashlight battery
  const batf = p.battery / CONFIG.flashlight.batteryMax;
  el("batbar").style.width = `${100 * batf}%`;
  const batBlock = el("battery");
  batBlock.classList.toggle("low", p.lightOn && batf < CONFIG.flashlight.lowThreshold);
  batBlock.classList.toggle("off", !p.lightOn || p.battery <= 0);
  el("bat-state").textContent = !p.lightOn
    ? "OFF"
    : p.battery <= 0
      ? "DEAD"
      : `${Math.ceil(batf * 100)}%`;
```

(Re-read the region first; `el("battery")`, `el("batbar")`, and `el("bat-state")` must have no remaining references after this — `el()` throws on missing ids.)

- [ ] **Step 3: Remove the battery bar/state CSS**

In `game/style.css`, delete the rules for `#batbar-wrap`, `#batbar`, `#battery.low #batbar`, `#battery.low #bat-state`, `#battery.off #batbar`, `#battery.off #bat-state`, and the now-unused `@keyframes batpulse` (lines 195-234). Keep the `#battery { margin-top: 9px; }` rule (192-194) for the lone label.

Then, in the `@media (prefers-reduced-motion: reduce)` block (~1345-1351), remove the `#battery.low #batbar` selector from the comma list (leave `#start`, `.eyebrow .dot`, `#hud.low #hpbar-wrap`, `#start .torch` intact — those belong to other features):

```css
@media (prefers-reduced-motion: reduce) {
  #start,
  .eyebrow .dot,
  #hud.low #hpbar-wrap {
    animation: none;
  }
  #start .torch {
    transition: none;
  }
}
```

- [ ] **Step 4: Verify no dangling references + typecheck**

Run: `grep -rn "bat-state\|batbar\|batpulse" game/ index.html` → Expected: no matches.
Run: `bun run typecheck` → Expected: no errors.
Run: `bun run build` → Expected: builds (no `el()` throw at module load; sanity that the HUD ids resolve).

- [ ] **Step 5: Commit**

```bash
git add index.html game/game.ts game/style.css
git commit -m "feat(hud): drop battery text + bar (cone dimming carries it now)

Remove the OFF/DEAD/% readout and the fill bar; keep the Flashlight [F]
control label. Battery state is now read from the continuously dimming
cone (Task 1).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 3: Remove the remaining-zombie count

Delete the live hostile count; threat density rides audio tension + groan, night progress rides the clock-dial.

**Files:**
- Modify: `index.html` (the `#wavetag` line, 43)
- Modify: `game/game.ts` (the `el("remaining")` write, ~985)
- Modify: `game/style.css` (the `#wavetag` rule, 304-310)

- [ ] **Step 1: Remove the `#wavetag` element**

In `index.html`, delete the line:

```html
      <div id="wavetag">&mdash; hostiles: <span id="remaining">0</span> &mdash;</div>
```

(The surrounding center block keeps `#phase`, `#clock-dial`, and `#prompt`.)

- [ ] **Step 2: Remove the count write from `updateHUD`**

In `game/game.ts`, delete the comment + write (re-read for exact lines):

```ts
  // live hostile count — meaningful in both phases now that night survivors carry into the day
  el("remaining").textContent = String(state.zombies.length);
```

- [ ] **Step 3: Remove the `#wavetag` CSS**

In `game/style.css`, delete the rule (304-310):

```css
#wavetag {
  font-size: 11px;
  letter-spacing: 0.3em;
  color: var(--toxic);
  text-transform: uppercase;
  text-shadow: 0 0 12px rgba(125, 255, 79, 0.4);
}
```

- [ ] **Step 4: Verify no dangling references + typecheck**

Run: `grep -rn "wavetag\|\"remaining\"\|el(\"remaining\")" game/ index.html` → Expected: no matches (the `types.ts` comment word "remaining" is unrelated and not matched by `el("remaining")`).
Run: `bun run typecheck` → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add index.html game/game.ts game/style.css
git commit -m "feat(hud): drop remaining-zombie count (audio + clock-dial carry it)

Night ends on the clock, not a wipeout, so the count never signaled
progress; threat density already rides Audio.setTension + groan density.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 4: Remove the night-search causal annotation

Drop the "(draws the horde)" spoiler; keep the "stand still to search" control hint, same for day and night. The rummage SFX + the AI lure surge teach the risk.

**Files:**
- Modify: `game/game.ts` (`interactPrompt`, ~1464-1470)

- [ ] **Step 1: Collapse the day/night ternary**

In `game/game.ts`, in `interactPrompt`, replace the cache branch:

```ts
  for (const c of state.caches) {
    if (c.looted) continue;
    if (Math.hypot(c.x - p.x, c.y - p.y) < reach)
      return state.phase === "night"
        ? "stand still to search — risky! (draws the horde)"
        : "stand still to search";
  }
```

with:

```ts
  for (const c of state.caches) {
    if (c.looted) continue;
    if (Math.hypot(c.x - p.x, c.y - p.y) < reach) return "stand still to search";
  }
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck` → Expected: no errors.
Run: `grep -n "draws the horde\|risky" game/game.ts` → Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add game/game.ts
git commit -m "feat(hud): drop night-search causal spoiler from the prompt

Keep the 'stand still to search' control hint; the rummage SFX and the
AI lure surge teach the risk by experience.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 5: Integration check + mandatory playtest (feel-first gate)

No code beyond fixes surfaced here. This task is the feel-first gate — the work is **not done** until played and felt.

**Files:** none (unless playtest surfaces a fix; fold fixes into the relevant task above).

- [ ] **Step 1: Full quality gate**

Run: `bun run typecheck` → Expected: no errors.
Run: `bun run test` → Expected: all pass.
Run: `bun run lint` → Expected: clean.
Run: `bun run build` → Expected: builds to `dist/`.

- [ ] **Step 2: Playtest (`bun run dev`) — confirm by feel**

Verify, and report honestly:
- **HUD is clean:** no hostile count, no battery `%`/`OFF`/`DEAD`, no battery bar; `Flashlight [F]`, `[E]`/heal/repair prompts, "stand still to search" still present.
- **Threat density is legible by ear:** as more zombies close in at night, the tension/groan rises (no number needed); the clock-dial communicates how close dawn is.
- **Battery reads from the beam:** the cone visibly weakens as the battery drains, and the low-battery dying-bulb flicker still reads — **without** the beam becoming unfairly dark at usable charge. Tune `CONFIG.flashlight.dimFloor` / `dimStart` if the onset feels too early/late or the floor too dark/bright; re-run the gate after any tune.
- **Night-search risk is felt, not told:** searching at night plays the rummage loop and visibly accelerates nearby zombies toward you; the prompt no longer spoils it.

- [ ] **Step 3: (Only if a tune was needed) commit the tuning**

```bash
git add game/config.ts
git commit -m "tune(fx): playtest-adjust flashlight cone dimming floor/onset

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

## Notes for the implementer

- **Order matters:** Task 1 (dimming) before Task 2 (remove the bar) so the replacement cue exists when the meter goes. Tasks 3 and 4 are independent of each other and of 1/2.
- **`el()` throws on missing ids** — after any HUD-element removal, grep to confirm zero remaining references before committing (steps include this).
- **Don't touch** the HP `#hpbar`/`#hpnum` block (Spec ③), zombie `R.glow`/`R.add` rendering (Spec ④), or the cache search-progress arc (out of scope).
- **Co-op:** nothing here touches `game/net/`. `battery`/`lightOn` are already synced; the dimming is deterministic per player. Single-player sim stays byte-for-byte.
