# Mouse-Wheel Weapon Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the player cycle owned, non-melee weapons with the mouse wheel (up = previous, down = next), complementing the existing number-key switch.

**Architecture:** The wheel is resolved *client-locally* into the existing absolute `PlayerInput.weaponSlot` inside `localInput.ts` (the sole DOM→input boundary); `sysPlayer`, the net protocol, and snapshots are untouched, so co-op keeps working unchanged. A pure `cycleWeaponSlot` helper (unit-tested) does the owned/non-melee cycling with wrap-around. A "burst debounce" (one switch per wheel burst, re-arm after a quiet gap) defeats trackpad-inertia spin, and a resume-drain in the same module discards wheel accumulated while non-live (shop/pause/settings/tab-away).

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Vite, Bun, Vitest, Biome. Custom WebGL2 engine; vanilla DOM input.

## Global Constraints

- TypeScript `strict` + `noUncheckedIndexedAccess`: every indexed access is `T | undefined` — guard it. `tsc --noEmit` must pass (`bun run typecheck`).
- Biome lint+format must pass (`bun run lint`). Pre-commit auto-formats staged files.
- **Single-player must stay byte-for-byte unchanged in behavior** when touching co-op-adjacent code (per CLAUDE.md). This change only adds a new client-local input mapping; it must not alter existing number-key/fire/reload paths.
- **Data-driven, no special-case debt**: express "knife is not wheel-cyclable" via the existing `WeaponDef.melee` flag (reuse `isUpgradeableWeapon`), never by hardcoding the `"knife"` id.
- **Feel-first**: the switch feel (esp. trackpad inertia, mid-combat scrolling) is not done until playtested, not merely compiled/tested.
- Tune constants in `CONFIG`, not in systems.
- Tests cover only pure/deterministic code; `cycleWeaponSlot` is pure and gets unit tests. DOM/input glue (`input.ts`, `localInput.ts`) is validated by typecheck + playtest.

---

### Task 1: `cycleWeaponSlot` pure helper + unit tests

**Files:**
- Modify: `game/data/arsenal.ts` (add exported `cycleWeaponSlot`; file already imports `WEAPON_ORDER`, `WEAPONS`, `isUpgradeableWeapon` from `./weapons`)
- Test: `game/data/arsenal.test.ts` (append a `describe` block; file already imports from vitest and this module)

**Interfaces:**
- Consumes: nothing (pure function over its args).
- Produces:
  ```ts
  export function cycleWeaponSlot(
    order: readonly string[],
    eligible: (id: string) => boolean,
    currentId: string,
    step: number,
  ): number | null
  ```
  Returns an absolute index into `order` (the resolved `weaponSlot`), or `null` when there is no move. `step` is expected to be ±1 (caller clamps via `Math.sign`).

- [ ] **Step 1: Add the test imports (do this first — the vitest run below needs them)**

In `game/data/arsenal.test.ts`:
- Add `cycleWeaponSlot` to the existing `import { … } from "./arsenal";` block (the multi-line list at lines 7-22 — e.g. insert `cycleWeaponSlot,` after `cardItem,`).
- Change line 23 from `import { isUpgradeableWeapon, WEAPONS } from "./weapons";` to `import { isUpgradeableWeapon, WEAPON_ORDER, WEAPONS } from "./weapons";` (`isUpgradeableWeapon` is already imported; only `WEAPON_ORDER` is missing).

Without these, Step 3's run fails with `WEAPON_ORDER is not defined` / `cycleWeaponSlot is not a function` for the wrong reason (import error, not the intended "not implemented yet").

- [ ] **Step 2: Write the failing tests**

Append to `game/data/arsenal.test.ts`:

```ts
describe("cycleWeaponSlot", () => {
  const all = () => true;

  it("steps to the next slot", () => {
    expect(cycleWeaponSlot(["a", "b", "c", "d"], all, "a", 1)).toBe(1);
  });

  it("steps to the previous slot", () => {
    expect(cycleWeaponSlot(["a", "b", "c", "d"], all, "c", -1)).toBe(1);
  });

  it("wraps forward past the end", () => {
    expect(cycleWeaponSlot(["a", "b", "c", "d"], all, "d", 1)).toBe(0);
  });

  it("wraps backward before the start", () => {
    expect(cycleWeaponSlot(["a", "b", "c", "d"], all, "a", -1)).toBe(3);
  });

  it("skips ineligible (unowned) slots", () => {
    // eligible = a, c only; from a, +1 lands on c (index 2), not b
    const eligible = (id: string) => id === "a" || id === "c";
    expect(cycleWeaponSlot(["a", "b", "c", "d"], eligible, "a", 1)).toBe(2);
    expect(cycleWeaponSlot(["a", "b", "c", "d"], eligible, "c", 1)).toBe(0); // wraps to a
  });

  it("excludes melee weapons via the eligible predicate (knife stays put)", () => {
    // real order + owned-everything, eligible = non-melee guns only
    const eligible = (id: string) => isUpgradeableWeapon(id); // excludes knife
    // from magnum (last gun), +1 wraps to pistol (index 0), never the knife at the end
    expect(cycleWeaponSlot(WEAPON_ORDER, eligible, "magnum", 1)).toBe(
      WEAPON_ORDER.indexOf("pistol"),
    );
  });

  it("returns null when one or zero eligible slots", () => {
    const only = (id: string) => id === "a";
    expect(cycleWeaponSlot(["a", "b", "c"], only, "a", 1)).toBeNull();
    expect(cycleWeaponSlot(["a", "b", "c"], only, "b", 1)).toBeNull();
  });

  it("enters the nearest eligible weapon when current is ineligible", () => {
    // eligible = a, c; current b (ineligible). +1 -> first eligible (a=0); -1 -> last (c=2)
    const eligible = (id: string) => id === "a" || id === "c";
    expect(cycleWeaponSlot(["a", "b", "c"], eligible, "b", 1)).toBe(0);
    expect(cycleWeaponSlot(["a", "b", "c"], eligible, "b", -1)).toBe(2);
  });
});
```

(Imports were added in Step 1.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun run test -- arsenal`
Expected: FAIL — `cycleWeaponSlot is not a function` / not exported.

- [ ] **Step 4: Implement `cycleWeaponSlot` in `game/data/arsenal.ts`**

Add near the other pure helpers (e.g. after `salvageEarned`), keeping the existing comment style:

```ts
/**
 * Resolve a mouse-wheel weapon step to an absolute `order` slot index.
 * `eligible(id)` decides which slots are cyclable (owned && non-melee). Starting from
 * `currentId`'s position among the eligible slots, move `step` (±1) with wrap-around and
 * return the resulting absolute index into `order`. Returns null when there is no move:
 * ≤1 eligible slot, or the destination equals the current slot.
 * If `currentId` is not itself eligible (e.g. the knife, equipped via number key), enter the
 * nearest eligible weapon in the step direction: the first for step>0, the last for step<0.
 */
export function cycleWeaponSlot(
  order: readonly string[],
  eligible: (id: string) => boolean,
  currentId: string,
  step: number,
): number | null {
  const slots: number[] = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    if (id !== undefined && eligible(id)) slots.push(i);
  }
  if (slots.length <= 1) return null;

  const curSlot = order.indexOf(currentId);
  const curPos = slots.indexOf(curSlot);
  const destPos =
    curPos === -1
      ? step > 0
        ? 0
        : slots.length - 1
      : (curPos + step + slots.length) % slots.length;

  const dest = slots[destPos];
  if (dest === undefined || dest === curSlot) return null;
  return dest;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run test -- arsenal`
Expected: PASS (all `cycleWeaponSlot` cases green, existing arsenal tests still green).

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add game/data/arsenal.ts game/data/arsenal.test.ts
git commit -m "feat(arsenal): cycleWeaponSlot — pure owned/non-melee wheel cycling helper"
```

---

### Task 2: `Input` wheel capture + `CONFIG.input` tuning

**Files:**
- Modify: `game/config.ts` (add top-level `input` block)
- Modify: `game/input.ts` (add `wheel`, `wheelLastMs`; wheel listener; blur reset)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CONFIG.input.wheelBurstGapMs: number` — quiet-gap threshold (ms) that ends a wheel burst / marks a non-live resume.
  - `Input.wheel: number` — accumulated wheel-notch sign since last consume.
  - `Input.wheelLastMs: number` — `e.timeStamp` of the last wheel event (DOMHighResTimeStamp, comparable to `performance.now()`).

- [ ] **Step 1: Add `CONFIG.input`**

In `game/config.ts`, add a new top-level block (sibling of `feel`/`assist`), e.g. immediately before `feel: {`:

```ts
  input: {
    wheelBurstGapMs: 120, // ms of wheel silence that ends a "burst": trackpad inertia fires
    // wheel events for ~1s, so one-switch-per-burst (re-arm after this gap) stops the wheel
    // from spinning through the whole arsenal. Also used to drain wheel accrued while non-live.
  },
```

- [ ] **Step 2: Add wheel fields + listener to `Input`**

Replace the body of `game/input.ts` with (adds two fields + a `wheel` listener; keeps everything else identical):

```ts
import { isEditableTarget } from "./ui";

export const Input = {
  keys: new Set<string>(),
  mouseX: 0,
  mouseY: 0,
  firing: false,
  /** accumulated mouse-wheel notch sign since the last consume (localInput drains it) */
  wheel: 0,
  /** e.timeStamp (DOMHighResTimeStamp) of the last wheel event; compared to performance.now() */
  wheelLastMs: 0,
  init(canvas: HTMLCanvasElement): void {
    addEventListener("keydown", (e) => {
      // While a text field (room-code input, manual-SDP textareas) is focused, let the
      // keystroke through untouched — otherwise the preventDefault below eats characters
      // that are valid in a room code (R, 2, 3, …).
      if (isEditableTarget(e.target)) return;
      this.keys.add(e.code);
      if (["KeyR", "Digit1", "Digit2", "Digit3"].includes(e.code)) e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    canvas.addEventListener("mousemove", (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    canvas.addEventListener("mousedown", () => {
      this.firing = true;
    });
    addEventListener("mouseup", () => {
      this.firing = false;
    });
    // Wheel = relative weapon cycle (resolved to an absolute slot in localInput). Bound to the
    // canvas so wheel over text inputs never reaches here; { passive: false } so preventDefault
    // (stop the page scrolling under the game) actually applies.
    canvas.addEventListener(
      "wheel",
      (e) => {
        this.wheel += Math.sign(e.deltaY);
        this.wheelLastMs = e.timeStamp;
        e.preventDefault();
      },
      { passive: false },
    );
    addEventListener("blur", () => {
      this.keys.clear();
      this.firing = false;
      this.wheel = 0;
    });
  },
};
```

- [ ] **Step 3: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors.

- [ ] **Step 4: Run the full test suite (guard against regressions)**

Run: `bun run test`
Expected: PASS (no test touches `Input`; this confirms nothing broke).

- [ ] **Step 5: Commit**

```bash
git add game/config.ts game/input.ts
git commit -m "feat(input): capture mouse-wheel (wheel/wheelLastMs) + CONFIG.input.wheelBurstGapMs"
```

---

### Task 3: Wire wheel → `weaponSlot` in `localInput.ts` (burst debounce + resume drain)

**Files:**
- Modify: `game/net/localInput.ts`

**Interfaces:**
- Consumes: `cycleWeaponSlot` (Task 1); `CONFIG.input.wheelBurstGapMs`, `Input.wheel`, `Input.wheelLastMs` (Task 2); `WEAPON_ORDER`, `isUpgradeableWeapon` (`game/data/weapons.ts`); existing `state.owned`, `p.weapon`.
- Produces: sets `PlayerInput.weaponSlot` (existing field) from wheel input when no number key claimed it. No new exports.

Note: number keys are resolved into `weaponSlot` at lines ~94-101 (`let weaponSlot: number | null = null; for (…Digit…)`). Wheel resolution goes *after* that loop so number keys win. The resume-drain + `lastSampleMs` update go near the top of `sampleLocalInput`, before the `p.hp <= 0` early return.

- [ ] **Step 1: Add imports**

At the top of `game/net/localInput.ts`, add:

```ts
import { cycleWeaponSlot } from "../data/arsenal";
import { isUpgradeableWeapon, WEAPON_ORDER } from "../data/weapons";
```

(`CONFIG` and `Input` are already imported.)

- [ ] **Step 2: Add module-local debounce state**

Next to the existing `let prevKeys = new Set<string>();` / `let aimTargetId = -1;` declarations, add:

```ts
// mouse-wheel weapon-switch debounce (module-local, like prevKeys/aimTargetId):
// wheelArmed = may switch on the next wheel activity; re-armed after a quiet gap.
// lastSampleMs = performance.now() of the previous sampleLocalInput call; a large gap means
// we were non-live (shop/pause/settings/tab-away) and should drop stale wheel accumulation.
let wheelArmed = true;
let lastSampleMs = 0;
```

- [ ] **Step 3: Add the resume-drain at the top of `sampleLocalInput`**

Immediately after `const p = localPlayer(state);` and BEFORE the `if (p.hp <= 0)` block, insert:

```ts
  const nowMs = performance.now();
  // Resume drain: if sampling was interrupted (non-live > one burst gap), discard wheel that
  // piled up while the sim was frozen so it can't fire a switch on the first live frame back.
  if (nowMs - lastSampleMs > CONFIG.input.wheelBurstGapMs) {
    Input.wheel = 0;
    wheelArmed = true;
  }
  lastSampleMs = nowMs;
```

Then, inside the existing `if (p.hp <= 0) { … }` early-return block, add `Input.wheel = 0;` (belt-and-suspenders: a downed player never switches):

```ts
  if (p.hp <= 0) {
    Input.wheel = 0;
    prevKeys = new Set(Input.keys);
    return emptyInput();
  }
```

- [ ] **Step 4: Resolve the wheel after the number-key loop**

Directly after the existing number-key resolution loop (the `for (let i = 1; i <= 9; i++) { if (edge(\`Digit${i}\`)) … }`), and before the `const input: PlayerInput = { … }` object literal, insert:

```ts
  // Mouse-wheel weapon switch — only if a number key didn't already claim the slot. One switch
  // per wheel "burst" (re-arm only after wheelBurstGapMs of silence) so trackpad inertia can't
  // spin through the arsenal. Cycles owned, non-melee weapons; the knife stays number-key only.
  if (weaponSlot === null) {
    const w = Input.wheel;
    Input.wheel = 0; // always consume, even when a number key won, so nothing piles up
    if (nowMs - Input.wheelLastMs > CONFIG.input.wheelBurstGapMs) wheelArmed = true;
    if (wheelArmed && w !== 0) {
      const slot = cycleWeaponSlot(
        WEAPON_ORDER,
        (id) => !!state.owned[id] && isUpgradeableWeapon(id),
        p.weapon,
        Math.sign(w),
      );
      if (slot !== null) {
        weaponSlot = slot;
        wheelArmed = false;
      }
    }
  }
```

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors. (Confirm `weaponSlot` is a `let` so it can be reassigned — it is, per the existing number-key code.)

- [ ] **Step 6: Run the full test suite**

Run: `bun run test`
Expected: PASS. No new unit test here (DOM/input glue); the cycling logic is covered by Task 1.

- [ ] **Step 7: Build**

Run: `bun run build`
Expected: `tsc --noEmit` clean + `vite build` succeeds.

- [ ] **Step 8: Commit**

```bash
git add game/net/localInput.ts
git commit -m "feat(input): mouse-wheel weapon switch — burst debounce + non-live resume drain"
```

---

### Task 4: Playtest verification (feel-first — not done until felt)

**Files:** none (manual verification per CLAUDE.md's feel-first principle).

- [ ] **Step 1: Launch the dev server**

Run: `bun run dev` → open http://localhost:5173

- [ ] **Step 2: Verify core behavior**

- Start a run. With a normal mouse wheel: **down = next weapon, up = previous**, cycling only owned guns, wrapping at the ends.
- Confirm the **knife is never reached by the wheel** (only via its number-key slot), and that scrolling while the knife is equipped moves to a gun.
- Confirm number keys still switch instantly and take precedence if pressed the same frame.

- [ ] **Step 3: Verify the inertia guard (the critical feel risk)**

- On a **trackpad** (or a high-resolution/free-spin mouse wheel), do a fast two-finger flick / spin. The weapon must advance **~once per gesture**, NOT spin through the whole arsenal. If it over-switches, increase `CONFIG.input.wheelBurstGapMs` (try 150-200) and re-test; if deliberate notch-by-notch feels sluggish, decrease it. Record the value that feels right.

- [ ] **Step 4: Verify no resume burst**

- Scroll the wheel while in the **shop**, while **paused (P/Esc)**, and with the **settings panel open**; then resume. There must be **no unintended weapon switch** on the first live frame.

- [ ] **Step 5: (If feasible) co-op sanity**

- With `bun run dev:coop` and two browsers, confirm wheel switching works for both host and client, and that switching feels correct (no visible desync beyond the accepted ≤1-slot reconcile skew when spamming the wheel immediately after a switch).

- [ ] **Step 6: Record the outcome**

- State honestly whether the feel is good and note the final `wheelBurstGapMs`. If a tuning change was made, commit it:

```bash
git add game/config.ts
git commit -m "tune(input): wheelBurstGapMs after playtest"
```

---

## Notes for the implementer

- **Co-op is intentionally untouched at the protocol level.** `weaponSlot` already crosses the wire as `number | null`; the host applies it via `sysPlayer` with an `state.owned[id]` guard. Do not add net-layer code. The only accepted co-op quirk: because the wheel resolves *relative* to the client's predicted `p.weapon`, spamming the wheel within one reconcile window can land one slot off; the host finalizes authoritatively and it self-corrects. This is documented in the spec and checked in Task 4 Step 5.
- **Do not hardcode `"knife"`.** Eligibility is `owned && isUpgradeableWeapon(id)`; `isUpgradeableWeapon` already means "in WEAPONS and not melee". A future non-melee unlock automatically joins the wheel cycle with no code change.
