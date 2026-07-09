# Unified Auto Controls (Vampire-Survivors-style) & Mobile-Forward — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace QUARANTINE's per-device controls with one auto scheme on every platform — move-only, everything else automated — and make it touch-capable and portrait-first for CrazyGames.

**Architecture:** One input seam (`sampleLocalInput`) auto-derives a single `aim` (nearest visible in-viewport zombie → movement heading → hold-last) that drives gun/light/melee/placement/dread. Manual aim, the flashlight toggle, battery budgeting, and the Stalker light-ward are deleted. Device detection only chooses HUD/layout (`body.mobile`), never the control scheme. Wire changes are removals; `PROTOCOL_VERSION` bumps so cross-version co-op is refused.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), custom WebGL2 engine, Vite, Bun, Vitest, Biome.

## Global Constraints

- **Test scope (project rule):** only pure, deterministic code is unit-tested (Vitest, co-located `*.test.ts`). Sim/renderer/AI/input-feel/HUD are validated by `typecheck` + `lint` + `build` + **playtest**, never unit tests. Follow this — write tests for new pure helpers only.
- **Commands:** `bun run typecheck` · `bun run lint` (Biome) · `bun run lint:fix` · `bun run test` · `bun run build` · `bun run dev` (playtest at http://localhost:5173).
- **Co-op wire:** any change to `snapshot.ts` encode/decode, `NetMsg`/`CoopEvent`, or Hello fields **requires bumping `PROTOCOL_VERSION` (`game/net/net.ts:19`)**. The golden-byte test in `snapshot.test.ts` fails on encode changes — bump, don't silence.
- **Single-player sim rules, enemy/wave/weapon-stat/economy data, and the co-op flow stay behaviorally unchanged** — only controls/light/Stalker-ward change.
- **`STALKER_STATES` wire enum order must stay stable** — never delete/reorder entries; unreachable states stay as dead entries.
- **Branch:** `feat/unified-auto-controls` (already created; spec committed).
- **Feel-first:** control/light/Stalker feel cannot be asserted from code — it is handed to the user for playtest (Task 15).

---

## File Structure

- `game/inputMode.ts` **(new)** — pure input-mode resolution + a thin DOM detector; owns `body.mobile`.
- `game/settings.ts` **(modify)** — drop `aimAssist`; add client-local `loadout` + `inputModeOverride`.
- `game/autoAim.ts` **(new)** — pure auto-aim resolution (target → movement → hold-last) + viewport predicate + loadout hotbar remap. (Grouped: all the pure control helpers this plan introduces.)
- `game/net/localInput.ts` **(modify)** — always-on auto-aim, movement fallback, semi-auto pulse, loadout remap; drop mouse-aim + `aimAssist`.
- `game/input.ts` **(modify)** — add touch handling (multi-touch); drop combat mouse wiring.
- `game/net/playerInput.ts` **(modify)** — remove `lightToggle`.
- `game/net/snapshot.ts` **(modify)** — retire the `lightOn` flag bit; keep `STALKER_STATES` stable.
- `game/net/net.ts` **(modify)** — bump `PROTOCOL_VERSION`.
- `game/systems/player.ts`, `game/systems/flashlight.ts`, `game/systems/flashlight.test.ts` **(modify)** — remove toggle/manual-battery; battery auto-drains.
- `game/systems/stalker.ts`, `game/systems/stalkerFx.ts`, `game/systems/bullets.ts` **(modify)** — remove ward machinery; retire `flinchStalker`.
- `game/game.ts`, `game/main.ts` **(modify)** — drop crosshair-as-aim + `aimAssist` UI; drop `lightOn &&` guards; render cone/placement from `aim`.
- `game/engine/renderer.ts`, `game/config.ts` **(modify)** — responsive portrait view-scale.
- `index.html`, `game/style.css` **(modify)** — portrait HUD, touch widgets, `touch-action`/`user-select`, safe-area.

---

## Phase 0 — Pure control helpers (no behavior change yet)

### Task 1: Input-mode resolution helper

**Files:**
- Create: `game/inputMode.ts`
- Test: `game/inputMode.test.ts`

**Interfaces:**
- Produces: `resolveInputMode(env: { coarsePointer: boolean; hasTouch: boolean; override: "mobile" | "desktop" | null; forced: "mobile" | "desktop" | null }): "mobile" | "desktop"`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveInputMode } from "./inputMode";

describe("resolveInputMode", () => {
  const base = { coarsePointer: false, hasTouch: false, override: null, forced: null } as const;
  it("defaults to desktop for mouse-only", () => {
    expect(resolveInputMode(base)).toBe("desktop");
  });
  it("picks mobile for a coarse-pointer touch device", () => {
    expect(resolveInputMode({ ...base, coarsePointer: true, hasTouch: true })).toBe("mobile");
  });
  it("forced flag (?mobile/?desktop) beats detection", () => {
    expect(resolveInputMode({ ...base, coarsePointer: true, hasTouch: true, forced: "desktop" })).toBe("desktop");
    expect(resolveInputMode({ ...base, forced: "mobile" })).toBe("mobile");
  });
  it("user override beats detection but not the forced flag", () => {
    expect(resolveInputMode({ ...base, override: "mobile" })).toBe("mobile");
    expect(resolveInputMode({ ...base, coarsePointer: true, hasTouch: true, override: "desktop", forced: "mobile" })).toBe("mobile");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun run test inputMode` → FAIL ("resolveInputMode is not a function").

- [ ] **Step 3: Write minimal implementation**

```ts
/** Pure precedence for the control HUD mode. Detection only chooses layout/widgets — the
 *  control SCHEME never branches on this. Precedence: forced query flag > user override >
 *  (coarse pointer AND touch) ⇒ mobile, else desktop. */
export type InputMode = "mobile" | "desktop";

export function resolveInputMode(env: {
  coarsePointer: boolean;
  hasTouch: boolean;
  override: InputMode | null;
  forced: InputMode | null;
}): InputMode {
  if (env.forced) return env.forced;
  if (env.override) return env.override;
  return env.coarsePointer && env.hasTouch ? "mobile" : "desktop";
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun run test inputMode` → PASS.

- [ ] **Step 5: Commit** — `git add game/inputMode.ts game/inputMode.test.ts && git commit -m "feat(input): pure input-mode resolution helper"`

---

### Task 2: Settings — replace `aimAssist` with `loadout` + `inputModeOverride`

**Files:**
- Modify: `game/settings.ts` (whole file)
- Test: `game/settings.test.ts` (new)

**Interfaces:**
- Consumes: `WEAPON_ORDER`, `STARTER_WEAPONS` from `game/data/weapons.ts`.
- Produces: `getSettings(): Settings` where `Settings = { loadout: string[]; inputModeOverride: "mobile"|"desktop"|null }`; `setLoadout(ids: string[]): string[]`; `setInputModeOverride(m: "mobile"|"desktop"|null): void`. `DEFAULT_LOADOUT: string[]` (`["pistol","smg","shotgun"]`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { getSettings, setLoadout, DEFAULT_LOADOUT } from "./settings";

describe("settings loadout", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to the starter 3-slot loadout", () => {
    expect(getSettings().loadout).toEqual(DEFAULT_LOADOUT);
  });
  it("clamps a set loadout to at most 3 ids", () => {
    expect(setLoadout(["pistol", "smg", "shotgun", "rifle"])).toEqual(["pistol", "smg", "shotgun"]);
  });
  it("persists a set loadout", () => {
    setLoadout(["magnum", "knife"]);
    expect(getSettings().loadout).toEqual(["magnum", "knife"]);
  });
});
```

> Note: `vite.config.ts` uses `environment: "node"`; if `localStorage` is absent in the test env, add `environment: "jsdom"` for this file via a top-of-file `// @vitest-environment jsdom` comment (Vitest per-file override). Verify by running the test.

- [ ] **Step 2: Run test to verify it fails** — `bun run test settings` → FAIL.

- [ ] **Step 3: Rewrite `game/settings.ts`**

```ts
/**
 * Player-facing options persisted across sessions (localStorage), separate from run-state and
 * meta. `loadout` = the ≤3 weapon ids shown on the (all-platform) hotbar. `inputModeOverride`
 * lets a mis-detected device switch HUD mode. Cached in memory; safe to read per-frame.
 */
import { STARTER_WEAPONS } from "./data/weapons";
import type { InputMode } from "./inputMode";

const KEY = "q_settings";
export const MAX_LOADOUT = 3;
export const DEFAULT_LOADOUT = STARTER_WEAPONS.filter((id) => id !== "knife").slice(0, MAX_LOADOUT);

export interface Settings {
  loadout: string[];
  inputModeOverride: InputMode | null;
}

function fresh(): Settings {
  return { loadout: [...DEFAULT_LOADOUT], inputModeOverride: null };
}

let cached: Settings | null = null;

export function getSettings(): Settings {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    const p = raw ? (JSON.parse(raw) as Partial<Settings>) : null;
    const loadout = Array.isArray(p?.loadout) && p.loadout.length
      ? p.loadout.filter((x): x is string => typeof x === "string").slice(0, MAX_LOADOUT)
      : [...DEFAULT_LOADOUT];
    const ov = p?.inputModeOverride;
    cached = {
      loadout: loadout.length ? loadout : [...DEFAULT_LOADOUT],
      inputModeOverride: ov === "mobile" || ov === "desktop" ? ov : null,
    };
  } catch {
    cached = fresh();
  }
  return cached;
}

function save(s: Settings): void {
  cached = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage may be unavailable */
  }
}

export function setLoadout(ids: string[]): string[] {
  const loadout = ids.slice(0, MAX_LOADOUT);
  save({ ...getSettings(), loadout });
  return loadout;
}

export function setInputModeOverride(m: InputMode | null): void {
  save({ ...getSettings(), inputModeOverride: m });
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun run test settings` → PASS. (Typecheck will still fail elsewhere — `getSettings().aimAssist` callers — fixed in Task 5/9. That's expected mid-phase; do NOT run `typecheck` as this task's gate.)

- [ ] **Step 5: Commit** — `git add game/settings.ts game/settings.test.ts && git commit -m "feat(settings): replace aimAssist with 3-slot loadout + input-mode override"`

---

### Task 3: Auto-aim, viewport, and hotbar-remap pure helpers

**Files:**
- Create: `game/autoAim.ts`
- Test: `game/autoAim.test.ts`

**Interfaces:**
- Produces:
  - `resolveAim(target: number | null, moveX: number, moveY: number, lastHeading: number): number` — target angle if present; else movement heading; else `lastHeading`.
  - `inViewport(zx: number, zy: number, camX: number, camY: number, halfX: number, halfY: number, margin: number): boolean` — is a world point within the on-screen rect (+margin).
  - `resolveHotbarSlot(loadout: readonly string[], order: readonly string[], hotbarIndex: number): number | null` — absolute `order` index for a tapped/keyed hotbar slot, or null if empty/unowned-mapping.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { resolveAim, inViewport, resolveHotbarSlot } from "./autoAim";

const ORDER = ["pistol", "smg", "shotgun", "rifle", "lmg", "magnum", "knife"];

describe("resolveAim", () => {
  it("uses the target angle when a target exists", () => {
    expect(resolveAim(1.2, 0, 0, 0.5)).toBe(1.2);
  });
  it("falls back to movement heading when no target", () => {
    expect(resolveAim(null, 1, 0, 9)).toBeCloseTo(0); // east
    expect(resolveAim(null, 0, 1, 9)).toBeCloseTo(Math.PI / 2); // south (+y)
  });
  it("holds the last heading when no target and idle", () => {
    expect(resolveAim(null, 0, 0, 2.34)).toBe(2.34);
  });
});

describe("inViewport", () => {
  it("accepts a point inside the rect", () => {
    expect(inViewport(10, 10, 0, 0, 100, 200, 0)).toBe(true);
  });
  it("rejects a point outside the horizontal half", () => {
    expect(inViewport(150, 0, 0, 0, 100, 200, 0)).toBe(false);
  });
  it("honors the margin", () => {
    expect(inViewport(110, 0, 0, 0, 100, 200, 20)).toBe(true);
  });
});

describe("resolveHotbarSlot", () => {
  it("maps a hotbar index to the absolute WEAPON_ORDER slot", () => {
    expect(resolveHotbarSlot(["smg", "magnum", "knife"], ORDER, 0)).toBe(1); // smg
    expect(resolveHotbarSlot(["smg", "magnum", "knife"], ORDER, 1)).toBe(5); // magnum
    expect(resolveHotbarSlot(["smg", "magnum", "knife"], ORDER, 2)).toBe(6); // knife
  });
  it("returns null for an empty hotbar index", () => {
    expect(resolveHotbarSlot(["smg"], ORDER, 2)).toBeNull();
  });
  it("returns null when the loadout id is not in order", () => {
    expect(resolveHotbarSlot(["ghost"], ORDER, 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun run test autoAim` → FAIL.

- [ ] **Step 3: Write minimal implementation**

```ts
/** Pure helpers for the unified auto control scheme. No DOM, no state. */

/** Aim precedence: nearest-target angle → movement heading → held last heading. */
export function resolveAim(
  target: number | null,
  moveX: number,
  moveY: number,
  lastHeading: number,
): number {
  if (target !== null) return target;
  if (moveX !== 0 || moveY !== 0) return Math.atan2(moveY, moveX);
  return lastHeading;
}

/** Is a world point inside the on-screen rect centred on the camera, expanded by `margin`? */
export function inViewport(
  zx: number,
  zy: number,
  camX: number,
  camY: number,
  halfX: number,
  halfY: number,
  margin: number,
): boolean {
  return Math.abs(zx - camX) <= halfX + margin && Math.abs(zy - camY) <= halfY + margin;
}

/** Hotbar slot (0..n) → absolute index into `order`; null if the slot is empty or unmapped. */
export function resolveHotbarSlot(
  loadout: readonly string[],
  order: readonly string[],
  hotbarIndex: number,
): number | null {
  const id = loadout[hotbarIndex];
  if (id === undefined) return null;
  const slot = order.indexOf(id);
  return slot === -1 ? null : slot;
}
```

- [ ] **Step 4: Run test to verify it passes** — `bun run test autoAim` → PASS.

- [ ] **Step 5: Commit** — `git add game/autoAim.ts game/autoAim.test.ts && git commit -m "feat(input): pure auto-aim, viewport, and hotbar-remap helpers"`

---

## Phase 1 — Auto control scheme in the input layer (PC becomes auto)

### Task 4: Rewire `sampleLocalInput` to the unified auto scheme

**Files:**
- Modify: `game/net/localInput.ts`
- Manual gate (no unit test — input feel): `typecheck` (after Task 5), `dev` playtest.

**Interfaces:**
- Consumes: `resolveAim`, `inViewport`, `resolveHotbarSlot` (Task 3); `getSettings().loadout` (Task 2); existing `assistAim`, `Renderer.worldToScreenHalf()`, `cycleWeaponSlot`.
- Produces: unchanged `PlayerInput` shape minus `lightToggle` (removed in Task 6). `aim` is now always auto-derived.

- [ ] **Step 1: Change `assistAim` to filter by viewport, not just `flashlight.range`.** In `assistAim` (currently `localInput.ts:40-64`), after computing the camera half-extents, replace the `d2 > r2` range gate with a **viewport test** using `inViewport(z.x, z.y, state.cam.x, state.cam.y, half.x, half.y, CONFIG.flashlight... )`. Keep the `hasLineOfSight` wall check and the `aimTargetId` hysteresis. Whichever is tighter — the viewport rect or `flashlight.range` — wins (keep both gates: viewport AND range). `half` comes from `Renderer.worldToScreenHalf()`.

- [ ] **Step 2: Make auto-aim unconditional and add the movement/hold-last fallback.** Replace the current aim block (`localInput.ts:99-113`, the mouse→world→`atan2` computation and the `if (getSettings().aimAssist)` gate) with:

```ts
// unified auto scheme: gun auto-aims at the nearest visible in-viewport zombie; with no target
// the light/gun follow the movement heading; idle holds the last heading. The mouse never aims.
const target = assistAim(state, p.x, p.y); // null when no valid zombie is on-screen
const aim = resolveAim(target, moveX, moveY, lastHeading);
lastHeading = aim; // module-local; persists the resting facing
```

Add a module-local `let lastHeading = 0;` near `prevKeys`. Remove the now-unused mouse/canvas reads and the `getSettings` import if aimAssist was its only use (loadout still needs `getSettings`).

- [ ] **Step 3: Weapon switch via the loadout.** In the number-key loop (`localInput.ts:116-122`) and the wheel-cycle block (`:129-145`), remap to the loadout: keys `Digit1..Digit3` → `resolveHotbarSlot(getSettings().loadout, WEAPON_ORDER, i)`; wheel cycles within the loadout by passing `eligible = (id) => !!state.owned[id] && isUpgradeableWeapon(id) && loadout.includes(id)` to the existing `cycleWeaponSlot`. Set `weaponSlot` to the resolved absolute index.

- [ ] **Step 4: Synthesize auto-fire.** Set `firing` true when `assistAim` returned a target (there is something to shoot) — `const firing = target !== null;`. Semi-auto re-trigger is handled by the sim's `firedThisHold` gate together with the sim clearing it when `!inp.firing`; to let semi-autos re-fire under continuous auto-fire, pulse `firing` off for one sample every time the weapon is on cooldown: track `let firePulse = false;` and emit `firing: target !== null && !firePulse; firePulse = !firePulse` **only for non-auto weapons** (read `effWeapon(p, p.weapon).auto`). Auto weapons keep `firing: target !== null`.

- [ ] **Step 5: Build the `PlayerInput`** — same object as before but with the new `moveX/moveY` (unchanged), `aim`, `firing`, and `weaponSlot`; drop the `lightToggle` field (removed from the type in Task 6 — leave it out now and expect a typecheck error until Task 6). Keep `reload`, `heal`, `interactHeld`.

- [ ] **Step 6: Gate** — `bun run test` (pure helpers still pass). Defer `typecheck`/playtest to after Task 5–6 (crosshair + type removal), since PC is mid-rewire.

- [ ] **Step 7: Commit** — `git add game/net/localInput.ts && git commit -m "feat(input): unify sampleLocalInput onto auto-aim + auto-fire + loadout"`

---

### Task 5: Remove crosshair-as-aim and combat mouse wiring

**Files:**
- Modify: `game/main.ts` (crosshair block ~`469-479`; `aimAssist` UI at `~241,257`), `game/input.ts` (mouse combat handlers ~`22-31`).
- Gate: `dev` playtest.

- [ ] **Step 1:** In `game/input.ts`, remove the `mousedown`→`firing=true` and `mouseup`→`firing=false` handlers and the `firing` field (auto-fire now comes from `sampleLocalInput`). Keep `mousemove` **only if** menus need it; the shop/UI uses DOM click, so remove `mouseX/mouseY` combat use — retain them only if `main.ts` still reads them (after Step 2 it won't). Keep the `wheel` handler (used for weapon cycle) and `blur`.

- [ ] **Step 2:** In `game/main.ts`, delete the in-combat crosshair block (`cross` opacity/transform/classes, ~`469-479`) and the `#cross` element usage; hide `#cross` permanently (or remove the element in `index.html`). Remove the `settingAimAssist` button wiring (`~256-260`) and the `aimAssist` label refresh (`~241`).

- [ ] **Step 3: Gate** — `bun run dev`, load on desktop: WASD moves; the gun auto-aims and auto-fires at visible zombies; with none in view the light points where you move; no crosshair. Semi-autos (pistol/shotgun/magnum) re-fire at their cadence, not one-and-stall.

- [ ] **Step 4: Commit** — `git add game/main.ts game/input.ts index.html && git commit -m "feat(input): remove crosshair-as-aim and combat mouse wiring"`

---

## Phase 2 — Light & battery automatic

### Task 6: Retire the flashlight toggle, `lightToggle`, and `lightOn`

**Files:**
- Modify: `game/systems/player.ts` (`79-88`, `209`), `game/net/playerInput.ts` (remove `lightToggle`), `game/systems/flashlight.ts` + `game/systems/flashlight.test.ts`, `game/game.ts` (`lightOn &&` guards at `~239`, `~380`, cone render), `game/net/snapshot.ts` (flag bit), `game/net/net.ts` (version), `game/types.ts` + `game/engine/players.ts` (`lightOn` field/init).
- Gate: `bun run test` (flashlight + golden), `typecheck`, `dev`.

**Interfaces:**
- Produces: `PlayerInput` without `lightToggle`; `flashlightIntensity` without the `on` param; `Player.lightOn` removed.

- [ ] **Step 1:** In `game/systems/player.ts`, delete the toggle block (`79-83`, the `if (inp.lightToggle)` and `Audio.click()`), change the drain to unconditional: replace `if (p.lightOn && p.battery > 0)` (`86`) with `if (p.battery > 0)`. Remove `inp.lightToggle = false;` (`209`). Remove `p.aim = inp.aim;`? No — keep (`142`); aim still arrives via input.

- [ ] **Step 2:** In `game/net/playerInput.ts`, remove the `lightToggle` field from the `PlayerInput` interface and from `emptyInput()`.

- [ ] **Step 3:** In `game/systems/flashlight.ts`, remove the `on` parameter; change the guard `if (!on || batteryFrac <= 0) return 0;` to `if (batteryFrac <= 0) return 0;`. Update all callers (`game.ts`, `stalkerFx.ts`, `stalker.ts`) to drop the `on` arg.

- [ ] **Step 4:** In `game/systems/flashlight.test.ts`, delete the `"is zero when switched off"` test (`16-18`) and shift the signature comment; keep the dead-battery→0 test. Update every remaining call to drop the `on` boolean argument.

- [ ] **Step 5:** In `game/types.ts` remove `Player.lightOn`; in `game/engine/players.ts` remove its init (`~47`). In `game/game.ts` drop the `lightOn &&` conditions from the `lightDie` audio edge (`~239`) and the dust/darts gate (`~380`); the cone already renders from `pl.aim` — leave that. In `game/net/snapshot.ts`, stop writing/reading the `lightOn` flag bit (bit 0 of the flag byte near `:663`/`:803`) — **leave the bit unused; do NOT renumber `absent`/`swingKind`/`searching`.**

- [ ] **Step 6:** Bump `PROTOCOL_VERSION` in `game/net/net.ts` from `16` to `17`.

- [ ] **Step 7: Gate** — `bun run test` (flashlight passes with new signature; the golden snapshot test fails on the flag-byte change → update its expected bytes in the same commit, confirming the change is intentional). Then `bun run typecheck` (the `aimAssist`/`lightToggle` references are gone) and `bun run dev`: light is always on, browns out as battery drains; no F key effect.

- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat(light): auto flashlight — remove toggle, lightToggle, lightOn; bump protocol"`

---

## Phase 3 — Stalker: flee/evade threat (no ward)

### Task 7: Remove the Stalker light-ward and retire bullet-flinch

**Files:**
- Modify: `game/systems/stalker.ts` (`playerWardsStalker` ~`25-49`, ward battery cost ~`119-121`, aim-opposite bias ~`147-156`, relocate `~204`, vis-fade `~240-245`), `game/systems/stalkerFx.ts` (`stalkerIsLitByLocal` telegraph gate), `game/systems/bullets.ts` (`flinchStalker` call ~`68-74`), `game/config.ts` (`wardBatteryCost`).
- Gate: `typecheck`, `test` (golden if wire touched — it isn't here), `dev` playtest.

- [ ] **Step 1:** In `game/systems/stalker.ts`, delete `playerWardsStalker` and `wardingPlayer` and every reference: the `aggro→stagger` transition that keyed on being lit, the `stagger→lull` relocate that keyed on ward, the ward battery cost, and the aim-opposite warding/approach bias. **Leave the `stagger` entry in the state type and in `STALKER_STATES` (`snapshot.ts:30`) as a now-unreachable dead state — do not delete or reorder it.** Keep the core machine: `lull→aggro→contact→retreat→despawn`, phantom perception, grab, menace/aggro escalation.

- [ ] **Step 2:** In `game/systems/bullets.ts`, remove the `flinchStalker` call and the Stalker hit branch (`~68-74`); bullets now pass through / ignore the Stalker (it stays excluded from auto-aim, so this path was already going cold). Remove `flinchStalker` from `stalker.ts` if now unused (or leave it exported-but-unused only if another caller exists — verify with a grep; delete if orphaned).

- [ ] **Step 3:** Remove `wardBatteryCost` from `game/config.ts` (and any now-dead ward tuning constants). In `stalkerFx.ts`, `stalkerIsLitByLocal` stays (light is always on) but note in a comment that telegraphs will rarely be suppressed now — no code change unless a threshold is added later.

- [ ] **Step 4: Gate** — `bun run typecheck` (no dangling ward refs), `bun run test` (STALKER_STATES golden unchanged since we kept the enum stable), `bun run dev`: the Stalker still spawns, pursues, and grabs; the flashlight has no effect on it; shooting it does nothing.

- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(stalker): remove light-ward and bullet-flinch — flee/evade pursuer"`

---

## Phase 4 — 3-slot loadout end to end

### Task 8: Loadout selection UI in Arsenal & Shop

**Files:**
- Modify: `game/game.ts` (`renderArsenal`, shop render), `index.html` (Arsenal/Shop loadout row), `game/style.css`.
- Consumes: `getSettings().loadout`, `setLoadout` (Task 2); `state.owned`, `WEAPON_ORDER`, `WEAPONS`.
- Gate: `typecheck`, `dev`.

- [ ] **Step 1:** Add a "Loadout (max 3)" row to the Arsenal overlay (`#arsenal-screen`) and the Shop overlay (`#shop`): render one toggle chip per owned weapon (incl. knife); selecting toggles membership in the loadout via `setLoadout`, capped at 3 (reject the 4th with a shake/no-op). Show current members highlighted in `WEAPON_ORDER` order.

- [ ] **Step 2:** Ensure the loadout only contains owned ids: on run start and when ownership changes, drop unowned ids (`setLoadout(getSettings().loadout.filter((id) => owned))`); if it empties, reset to `DEFAULT_LOADOUT ∩ owned`.

- [ ] **Step 3: Gate** — `bun run typecheck`, `bun run dev`: pick a 3-weapon loadout in the Arsenal; start a run; the hotbar (after Task 13) and number keys switch among exactly those 3.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(arsenal): 3-slot loadout selection in Arsenal and Shop"`

---

## Phase 5 — Responsive portrait FOV

### Task 9: Mobile view-scale in the renderer

**Files:**
- Modify: `game/engine/renderer.ts` (`resize()` / where `viewHalfX` derives from `CONFIG.zoom`, ~`233-238`), `game/config.ts` (add `zoomMobile` or a portrait multiplier).
- Gate: `typecheck`, `dev` (desktop unchanged; narrow window / device-emulation portrait shows more world).

- [ ] **Step 1:** Add `CONFIG.zoomMobileMul` (e.g. `0.62`) — how much wider the world view is in portrait mobile. In `resize()`, when `document.body.classList.contains("mobile")` **and** the canvas is portrait (`clientHeight > clientWidth`), compute the effective zoom as `CONFIG.zoom * CONFIG.zoomMobileMul`; otherwise use `CONFIG.zoom` unchanged. Keep `worldToScreenHalf()` consistent with the effective zoom.

- [ ] **Step 2: Gate** — `bun run typecheck`; `bun run dev` at a desktop window = unchanged framing; in Chrome device-mode portrait = wider world slice; confirm auto-aim (Task 4 viewport clamp) still never fires at off-screen zombies given the wider view.

- [ ] **Step 3: Commit** — `git add -A && git commit -m "feat(render): responsive portrait view-scale (mobile only)"`

---

## Phase 6 — Touch input

### Task 10: Multi-touch virtual stick in `input.ts`

**Files:**
- Modify: `game/input.ts` (add touch state + handlers), `game/inputMode.ts` (wire `body.mobile` + first-`pointerdown` refine), `game/main.ts` (call the detector at boot).
- Gate: `typecheck`, `dev` (device emulation touch).

**Interfaces:**
- Produces on `Input`: `touch: { active: boolean; dx: number; dy: number }` (normalized stick vector, magnitude ≤1), consumed by `sampleLocalInput` for `moveX/moveY` on mobile.

- [ ] **Step 1:** In `game/inputMode.ts`, add a DOM detector: read `matchMedia("(pointer: coarse)").matches`, `"ontouchstart" in window`, the `?mobile`/`?desktop` query flag, and `getSettings().inputModeOverride`; call `resolveInputMode`; set/remove `body.mobile`. Re-evaluate on the first real `pointerdown`/`touchstart` (its `pointerType`) and update the class if it disagrees. Export `applyInputMode(): void`.

- [ ] **Step 2:** In `game/input.ts`, add `touch` state and `touchstart/touchmove/touchend/touchcancel` listeners on the canvas with `{ passive: false }` + `preventDefault`. Track the stick by `touch.identifier`: the first touch in the **left half** anchors the stick origin; its movement sets a normalized `{dx,dy}` (clamped to a max radius); release clears `active`. Touches in the right half are left for HUD buttons (Task 12/13) — do not consume them for the stick.

- [ ] **Step 3:** In `sampleLocalInput`, when `body.mobile`, source `moveX/moveY` from `Input.touch` (`dx,dy`) instead of WASD (WASD still works if pressed — harmless). Desktop keeps WASD.

- [ ] **Step 4:** In `game/main.ts`, call `applyInputMode()` during `main()` init (after `Input.init`).

- [ ] **Step 5: Gate** — `bun run typecheck`; `bun run dev` in Chrome device-mode (touch): a left-thumb drag moves the player; auto-aim/fire/light behave as on desktop; `body.mobile` is set.

- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(input): multi-touch virtual stick + input-mode detection"`

---

## Phase 7 — Mobile HUD

### Task 11: Portrait HUD layout + touch-action/safe-area CSS

**Files:**
- Modify: `game/style.css` (`.mobile` layout), `index.html` (`user-select`/`touch-action`).
- Gate: `dev` (device emulation portrait).

- [ ] **Step 1:** In `index.html`/`style.css`, set `html, body { user-select: none; -webkit-user-select: none; touch-action: none; overscroll-behavior: none; }` (kills text-select, pull-to-refresh, scroll under the game). Add `#game { touch-action: none; }`.

- [ ] **Step 2:** Under `body.mobile`, re-lay-out `#hud`: passive readouts (hp, battery, Day, credits) pinned top with `env(safe-area-inset-top)`; leave bottom-left and bottom-right regions free for the stick and action cluster; apply `env(safe-area-inset-*)` padding so nothing sits under a notch/gesture bar. Desktop HUD rules stay under non-`.mobile` selectors.

- [ ] **Step 3: Gate** — `bun run dev` portrait device-mode: readouts on top and clear of the notch; no page scroll/zoom on drag; desktop layout unchanged in a normal window.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(hud): portrait layout, touch-action lock, safe-area insets"`

---

### Task 12: On-screen action buttons (heal, fortify, repair)

**Files:**
- Modify: `index.html` (buttons), `game/style.css`, `game/game.ts` (`updateHUD` show/hide + wiring), `game/main.ts` (tap → the same paths as `H`/`Q`/`E`).
- Gate: `dev`.

- [ ] **Step 1:** Add three bottom-right touch buttons (`#btn-heal`, `#btn-fortify`, `#btn-repair`), shown only under `body.mobile`. Heal → same path as the `H` handler (set the heal edge on the local input, or call the existing heal trigger); Fortify → same as `Q` (`deployPlace()`, respecting the existing 300ms throttle); Repair → sets `interactHeld` for a tick against the nearest damaged barricade.

- [ ] **Step 2:** In `updateHUD`, show Fortify only when the local player has a queued deployable, and Repair only when near a damaged barricade (reuse the `#prompt` proximity logic). Heal shows `×medkits`.

- [ ] **Step 3: Gate** — `bun run dev` touch: heal consumes a medkit; fortify places when in stock; repair appears only near a damaged barricade and repairs on tap.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(hud): mobile heal/fortify/repair touch buttons"`

---

### Task 13: 3-slot weapon hotbar (tap to switch)

**Files:**
- Modify: `index.html` (reuse/repurpose `#weapons-row`), `game/style.css`, `game/game.ts` (`updateHUD` renders the loadout slots with ammo/active state), `game/main.ts` or `input.ts` (tap → weaponSlot).
- Gate: `typecheck`, `dev`.

- [ ] **Step 1:** Render exactly the loadout (`getSettings().loadout`) as up to 3 icon slots in `#weapons-row`, always visible under `body.mobile` (and optionally on desktop). Show per-slot ammo/reserve and highlight the active weapon; use each weapon's `viz`/color for the icon.

- [ ] **Step 2:** Tapping a slot sets the next `weaponSlot` via `resolveHotbarSlot(loadout, WEAPON_ORDER, i)` (feed it into the same input path number keys use). Guard against the touch also driving the stick (right-side region, Task 10).

- [ ] **Step 3: Gate** — `bun run typecheck`; `bun run dev` touch: tapping a slot switches weapons (incl. knife); the active slot highlights; ammo updates.

- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat(hud): 3-slot tappable weapon hotbar"`

---

## Phase 8 — Verify & hand off

### Task 14: Full gate (typecheck, lint, test, build)

**Files:** none (verification).

- [ ] **Step 1:** `bun run typecheck` → clean.
- [ ] **Step 2:** `bun run lint` → clean (run `bun run lint:fix` for safe fixes).
- [ ] **Step 3:** `bun run test` → all pass (new pure-helper tests + updated flashlight + golden snapshot with the new protocol/flag bytes).
- [ ] **Step 4:** `bun run build` → succeeds; note `dist/` size (must stay ≤50MB / ≤1500 files for CrazyGames — it's ~2.2MB today).
- [ ] **Step 5: Commit** any lint/format fixes — `git add -A && git commit -m "chore: lint/format pass for unified controls"`

---

### Task 15: Feel hand-off (playtest — cannot be code-verified)

**Files:** none.

- [ ] **Step 1:** `bun run dev`; verify on **desktop** (WASD only) and in **portrait device-mode / a real phone** that it is the same game with the same controls.
- [ ] **Step 2:** Walk the spec's feel checklist and report honestly to the user (do not claim feel works without playing):
  - One thumb (mobile) / WASD-only (PC) carries the whole loop.
  - The `aim`-driven light (threat when present, movement when clear) reads as atmospheric, not disorienting.
  - Auto-aim/fire never fires off-screen; target-switch hysteresis doesn't make shotgun/magnum whiff annoyingly; 3 slots aren't cramped.
  - The Stalker still reads as a credible flee/evade pursuer without a ward or bullet-flinch; its telegraph FX isn't constant/dull now that light rarely suppresses it.
  - Mobile-GPU fill-rate/thermal of the flashlight + grid shaders + glow at DPR≤2 is acceptable on a low/mid phone.
  - Fortify placement isn't pointing in a stale direction often enough to annoy (idle + no-enemy hold-last caveat).
- [ ] **Step 2b:** Hand the branch to the user for playtest sign-off before merge. Record any feel failures as follow-up tasks (e.g. a threshold on telegraph FX, or reconsidering a dedicated ward tap if the Stalker feels toothless).

---

## Self-Review

**Spec coverage:** unified auto scheme (Tasks 3,4), aim=threat→movement→hold-last (Task 3,4), viewport-clamped auto-aim (Task 4), semi-auto pulse (Task 4), remove mouse/crosshair/aimAssist (Tasks 4,5), auto light + battery, remove toggle/lightToggle/lightOn + protocol bump + test deletion (Task 6), Stalker no-ward + flinch retired + stagger enum stable (Task 7), 3-slot client-local loadout + Arsenal/Shop UI + remap + wheel (Tasks 2,3,4,8,13), responsive portrait FOV (Task 9), touch multi-touch stick + device detection (Tasks 1,10), touch-action/safe-area (Task 11), HUD buttons + hotbar (Tasks 12,13), feel hand-off + build size (Tasks 14,15). All spec sections map to a task.

**Placeholder scan:** no TBD/"handle appropriately"; pure-helper steps carry full code + tests; integration/deletion steps carry exact file anchors and the concrete transformation, gated by typecheck/build/playtest per the project's no-unit-test-for-feel rule.

**Type consistency:** `resolveInputMode`/`InputMode` (Task 1) reused by `settings.ts` (Task 2) and `inputMode.ts` detector (Task 10); `getSettings().loadout` + `setLoadout` (Task 2) consumed by Tasks 4/8/13; `resolveAim`/`inViewport`/`resolveHotbarSlot` (Task 3) consumed by Task 4/13; `flashlightIntensity` loses `on` consistently across Task 6 caller updates; `PlayerInput` loses `lightToggle` in Task 6 and Task 4 already stops emitting it.
