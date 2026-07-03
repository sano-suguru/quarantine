# Action Feel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make seven timed/rooted/held player actions (reload, heal, search, revive, repair, mate-heal, deploy) *felt on the character and the world* — character motion, overlay props, ongoing particles, and a diegetic completion burst — instead of a bare progress bar.

**Architecture:** One shared "action feel" vocabulary. A pure `deriveActionChannel(player, state)` normalizes existing timers + minimal new synced state into a `{kind, phase}` that drives draw + FX with no per-action branch. Discrete tap actions (repair/mate-heal) are converted to a decaying swing-ramp so they read as continuous motion and survive the snapshot rate. Systems only *write* state (net-agnostic); the host spawns ongoing particles and the client re-derives them (and all completion bursts) from persistent snapshot diffs, exactly like the existing kill/hit re-derivation.

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess), custom WebGL2 renderer, Vitest, Bun, Biome. GLSL via `?raw`.

## Global Constraints

- **Data-driven, no special-case debt.** New behavior rides `CONFIG` + existing seams (`fx.ts`, `drawWeaponRig` part-dispatch, `drawPlayer`). No bespoke per-action code path. (CLAUDE.md)
- **Feel is not unit-tested.** Only pure/deterministic helpers get Vitest tests; motion/particle/payoff *feel* is validated by playtest. Draw/FX tasks gate on `bun run typecheck` + `bun run lint` + a stated manual playtest, not unit tests.
- **No floating text.** The diegetic-feedback initiative removed floating damage numbers; payoffs are diegetic only (flash / particle / color / audio). No `+HP`/`LOOTED` labels.
- **Single-player sim stays byte-for-byte unchanged.** All additions are draw/FX + host-written, snapshot-carried signals. Systems never import net/UI.
- **Any wire-format change bumps `PROTOCOL_VERSION`** (`game/net/net.ts`, currently `13`) and extends the snapshot round-trip test.
- **Swap-and-pop** array removal; **world-space** coords; tune via `CONFIG`, not systems.
- All tuning lives under a new `CONFIG.actionFeel` tree — no magic numbers in systems or draw.
- **Line numbers are a snapshot from plan-authoring time.** Several tasks edit the same regions of `game.ts`/`player.ts`/`client.ts` in sequence, so later tasks' cited line numbers *will* drift as earlier tasks land. Locate every edit by its quoted **anchor text** (or `grep`), never by raw line number.

## File Structure

**Created:**
- `game/systems/actionFeel.ts` — pure helpers: `ActionKind`, `ActionChannel`, `actionMotion`, `decaySwing`, `deriveActionChannel`. One responsibility: turn player+state into a draw-ready action descriptor.
- `game/systems/actionFeel.test.ts` — Vitest for the pure helpers.

**Modified:**
- `game/config.ts` — add the `actionFeel` tree.
- `game/types.ts` — add `Player.swingT`, `Player.swingKind` (searching already exists; its sync semantics change).
- `game/engine/players.ts` — seed the new fields in `makePlayer`; clear in `revivePlayer`.
- `game/net/snapshot.ts` — sync `searching`, `swingT`, `swingKind` (SnapPlayer + encode + decode + capture + apply).
- `game/net/net.ts` — bump `PROTOCOL_VERSION`.
- `game/net/snapshot.test.ts` — round-trip the new fields (create if absent; see Task 5).
- `game/systems/fx.ts` — add emitters: `fxMote`, `fxDust`, `fxActionBurst`.
- `game/systems/player.ts` — set `searching` day+night; set `swingT`/`swingKind` on repair/mate-heal; decay `swingT`.
- `game/game.ts` — draw changes in `drawWeaponRig`/`drawPlayer`/`drawCaches`/`drawDeployables`; extract `drawRigParts`.
- `game/net/client.ts` — re-derive loot/revive/mate-heal/repair/deploy payoffs in `effects`.
- `game/engine/audio.ts` — reuse existing samples for accents (no new samples in scope).

---

## Task 1: `CONFIG.actionFeel` tuning tree

**Files:**
- Modify: `game/config.ts` (add a sibling of `fx:`)

**Interfaces:**
- Produces: `CONFIG.actionFeel` with the fields consumed by every later task.

- [ ] **Step 1: Add the config tree**

Insert after the `fx: { ... }` block's closing `},` in `game/config.ts`:

```ts
  // Action-feel: motion / prop / particle / payoff tuning for timed player actions.
  // First-pass values — locked by playtest (feel-first). No magic numbers live in systems/draw.
  actionFeel: {
    swingDecay: 0.3, // seconds a repair/mate-heal "swing" ramp takes to fade (discrete tap → continuous)
    lean: 6, // world-units the body leans toward the action focus at full phase
    bob: 3, // world-units of periodic bob while an action runs
    bobHz: 9, // bob oscillation frequency (Hz) — the "working" cadence
    propOffset: 10, // lateral (off-hand) offset for overlay props, away from the weapon rig axis
    heal: {
      auraPulseHz: 2.2, // breathing rate of the heal aura
      auraBase: 0.28, // aura alpha floor
      auraPulse: 0.18, // aura alpha added at the top of each pulse
      moteEveryS: 0.12, // seconds between rising heal motes
      burst: 10, // motes in the completion burst
    },
    search: {
      digHz: 6, // rummage bob frequency
      lidRattle: 1.5, // crate-lid jitter amplitude (world units)
      dustEveryS: 0.18, // seconds between dust puffs
    },
    repair: { sparkEveryS: 0.0, dust: 4 }, // sparks emitted per swing edge; dust puffs per swing
    revive: { auraPulseHz: 1.6, beamAlpha: 0.25 },
    deploy: { emerge: 0.25 }, // seconds of the draw-only spawn-in scale/settle
  },
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS (no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add game/config.ts
git commit -m "feat(actionFeel): add CONFIG.actionFeel tuning tree"
```

---

## Task 2: `actionFeel.ts` pure helpers

**Files:**
- Create: `game/systems/actionFeel.ts`
- Test: `game/systems/actionFeel.test.ts`

**Interfaces:**
- Consumes: `CONFIG.actionFeel`, `Player`/`State` (types), `WEAPONS`/`effWeapon` for reload/switch phase.
- Produces:
  - `type ActionKind = "none" | "reload" | "heal" | "switch" | "search" | "repair" | "mateHeal" | "revive"`
  - `interface ActionChannel { kind: ActionKind; phase: number }` (phase 0..1)
  - `interface ActionMotion { lean: number; bob: number }`
  - `function decaySwing(swingT: number, dt: number): number`
  - `function actionMotion(kind: ActionKind, phase: number, time: number, cfg: typeof CONFIG.actionFeel): ActionMotion`
  - `function deriveActionChannel(p: Player, state: State): ActionChannel`

- [ ] **Step 1: Write the failing test**

Create `game/systems/actionFeel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { makePlayer } from "../engine/players";
import { newState } from "../state";
import { actionMotion, decaySwing, deriveActionChannel } from "./actionFeel";

describe("decaySwing", () => {
  it("counts down and clamps at 0", () => {
    expect(decaySwing(0.3, 0.1)).toBeCloseTo(0.2, 5);
    expect(decaySwing(0.05, 0.1)).toBe(0);
    expect(decaySwing(0, 0.1)).toBe(0);
  });
});

describe("actionMotion", () => {
  it("is zero when idle", () => {
    const m = actionMotion("none", 0, 0, CONFIG.actionFeel);
    expect(m.lean).toBe(0);
    expect(m.bob).toBe(0);
  });
  it("leans proportional to phase and bobs within amplitude", () => {
    const m = actionMotion("search", 1, 0.123, CONFIG.actionFeel);
    expect(m.lean).toBeGreaterThan(0);
    expect(Math.abs(m.bob)).toBeLessThanOrEqual(CONFIG.actionFeel.bob + 1e-6);
  });
});

describe("deriveActionChannel", () => {
  it("returns none for an idle player", () => {
    const p = makePlayer(0, 0, 0);
    const s = newState();
    expect(deriveActionChannel(p, s).kind).toBe("none");
  });
  it("reports heal with rising phase as healT drains", () => {
    const p = makePlayer(0, 0, 0);
    const s = newState();
    p.healT = CONFIG.heal.duration; // just started
    expect(deriveActionChannel(p, s).kind).toBe("heal");
    expect(deriveActionChannel(p, s).phase).toBeCloseTo(0, 2);
    p.healT = CONFIG.heal.duration * 0.25; // near done
    expect(deriveActionChannel(p, s).phase).toBeGreaterThan(0.5);
  });
  it("prioritizes heal over a concurrent swing", () => {
    const p = makePlayer(0, 0, 0);
    const s = newState();
    p.healT = 1;
    p.swingT = 0.2;
    p.swingKind = "repair";
    expect(deriveActionChannel(p, s).kind).toBe("heal");
  });
  it("reports the swing kind when only a swing is active", () => {
    const p = makePlayer(0, 0, 0);
    const s = newState();
    p.swingT = CONFIG.actionFeel.swingDecay;
    p.swingKind = "mateHeal";
    const c = deriveActionChannel(p, s);
    expect(c.kind).toBe("mateHeal");
    expect(c.phase).toBeCloseTo(1, 2);
  });
  it("reports search when the searching flag is set", () => {
    const p = makePlayer(0, 0, 0);
    const s = newState();
    p.searching = true;
    expect(deriveActionChannel(p, s).kind).toBe("search");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- actionFeel`
Expected: FAIL — cannot find module `./actionFeel` (and `swingKind` not on Player yet — that comes in Task 5; for now add it as a temporary local cast if the test won't compile, OR reorder: do Task 5's type addition first. Simplest: proceed to Step 3, then temporarily add `swingT`/`swingKind` to the Player type as part of this task — see note).

> **Note:** `Player.swingT`/`swingKind` are formally added in Task 5, but the test references them. To keep this task self-contained, add the two fields to `game/types.ts` now (Task 5 then only wires the snapshot). Add to the `Player` interface after `repairCd`:
> ```ts
>   /** decaying "swing" ramp (seconds) for discrete held-E actions (repair/mate-heal): set to
>    *  CONFIG.actionFeel.swingDecay on each press, decays to 0. Drives continuous motion + net
>    *  re-derivation of an otherwise 1-tick event. Synced (u8). */
>   swingT: number;
>   /** which discrete action the current swing is (drives prop/particle choice). Synced (2 bits). */
>   swingKind: "" | "repair" | "mateHeal";
> ```
> And seed them in `makePlayer` (`swingT: 0, swingKind: ""`) and clear in `revivePlayer` (`p.swingT = 0; p.swingKind = "";`).

- [ ] **Step 3: Write the implementation**

Create `game/systems/actionFeel.ts`:

```ts
import { CONFIG } from "../config";
import { effWeapon } from "../data/arsenal";
import type { Player, State } from "../types";

export type ActionKind =
  | "none"
  | "reload"
  | "heal"
  | "switch"
  | "search"
  | "repair"
  | "mateHeal"
  | "revive";

export interface ActionChannel {
  kind: ActionKind;
  /** 0 = just started, 1 = complete */
  phase: number;
}

export interface ActionMotion {
  /** world-units to lean toward the action focus (caller supplies the focus direction) */
  lean: number;
  /** world-units of periodic bob perpendicular to the lean */
  bob: number;
}

/** Decay one tick of a swing ramp (pure). */
export function decaySwing(swingT: number, dt: number): number {
  return Math.max(0, swingT - dt);
}

const BOBBING: ReadonlySet<ActionKind> = new Set([
  "search",
  "repair",
  "mateHeal",
  "revive",
  "heal",
]);

/** Body motion for an action: a phase-scaled lean plus a working bob. Pure. */
export function actionMotion(
  kind: ActionKind,
  phase: number,
  time: number,
  cfg: typeof CONFIG.actionFeel,
): ActionMotion {
  if (kind === "none") return { lean: 0, bob: 0 };
  const lean = cfg.lean * Math.max(0, Math.min(1, phase));
  const hz = kind === "search" ? cfg.search.digHz : cfg.bobHz;
  const bob = BOBBING.has(kind) ? Math.sin(time * hz * Math.PI * 2) * cfg.bob : 0;
  return { lean, bob };
}

/**
 * Normalize a player's live state into one action descriptor. Precedence: a rooted action
 * (heal) wins over gear actions (reload/switch), which win over discrete swings, which win
 * over passive search. Revive-as-reviver is NOT derived here (it depends on a *teammate's*
 * downed state) — draw handles it separately. Kept close to pure: reads player timers,
 * state.phase, and the weapon table for reload/switch normalization.
 */
export function deriveActionChannel(p: Player, _state: State): ActionChannel {
  if (p.healT > 0) {
    return { kind: "heal", phase: 1 - p.healT / CONFIG.heal.duration };
  }
  const wd = effWeapon(p, p.weapon);
  if (p.reloadT > 0 && !wd.melee) {
    return { kind: "reload", phase: 1 - p.reloadT / wd.reload };
  }
  if (p.switchT > 0) {
    const draw = wd.drawTime || 0.5;
    return { kind: "switch", phase: 1 - p.switchT / draw };
  }
  if (p.swingT > 0 && p.swingKind) {
    return { kind: p.swingKind, phase: p.swingT / CONFIG.actionFeel.swingDecay };
  }
  if (p.searching) return { kind: "search", phase: 1 };
  return { kind: "none", phase: 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test -- actionFeel`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add game/systems/actionFeel.ts game/systems/actionFeel.test.ts game/types.ts game/engine/players.ts
git commit -m "feat(actionFeel): pure deriveActionChannel/actionMotion/decaySwing helpers"
```

---

## Task 3: Extract `drawRigParts` from `drawWeaponRig`

**Files:**
- Modify: `game/game.ts:649-691` (`drawWeaponRig`)

**Interfaces:**
- Produces: `function drawRigParts(R, parts, ox, oy, ang, aMul, fwdScale): void` — renders a `WeaponDef["viz"]`-shaped part list at an origin/angle. Reused by weapon rig (Task 6+) and overlay props.

This is a pure refactor: behavior identical, so it gates on typecheck + existing tests, not a new test.

- [ ] **Step 1: Add the shared helper and rewrite `drawWeaponRig` to call it**

Replace the body of `drawWeaponRig` (game.ts:649-691) so the per-part `switch` lives in `drawRigParts`:

```ts
/** Render a viz-part list (rect/circle/ring/hex/tri) at an origin, posed along `ang`. Shared by
 *  the weapon rig and overlay props — dispatch is shared, pose (origin/angle) is the caller's. */
function drawRigParts(
  R: typeof Renderer,
  parts: WeaponDef["viz"],
  ox: number,
  oy: number,
  ang: number,
  aMul: number,
  fwdScale: number,
): void {
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  for (const part of parts) {
    const fwd = part.dx * fwdScale;
    const lat = part.dy;
    const wx = ox + ca * fwd - sa * lat;
    const wy = oy + sa * fwd + ca * lat;
    const [cr, cg, cb] = part.color ?? [1, 1, 1];
    const a = (part.alpha ?? 1) * aMul;
    const rot = ang + part.rot;
    switch (part.shape) {
      case "circle":
        R.circle(wx, wy, part.len / 2, cr, cg, cb, a);
        break;
      case "ring":
        R.ring(wx, wy, part.len / 2, cr, cg, cb, a);
        break;
      case "hex":
        R.hex(wx, wy, part.len / 2, rot, cr, cg, cb, a);
        break;
      case "tri":
        R.tri(wx, wy, part.len / 2, rot, cr, cg, cb, a);
        break;
      default:
        R.rect(wx, wy, part.len, part.wid, rot, cr, cg, cb, a);
        break;
    }
  }
}

function drawWeaponRig(
  R: typeof Renderer,
  px: number,
  py: number,
  aim: number,
  wd: WeaponDef,
  switchT: number,
): void {
  const raise = switchT > 0 ? 1 - switchT / wd.drawTime : 1;
  const e = 1 - (1 - raise) * (1 - raise);
  const DOWN = 0.6;
  const ang = aim + (1 - e) * DOWN;
  const fwdScale = 0.3 + 0.7 * e;
  const aMul = 0.6 + 0.4 * e;
  // parts default to wd.color when they carry no per-part color (drawRigParts falls back to
  // white, so pre-fill the weapon color here to preserve the original look)
  const parts = wd.viz.map((p) => ({ ...p, color: p.color ?? wd.color }));
  drawRigParts(R, parts, px, py, ang, aMul, fwdScale);
}
```

- [ ] **Step 2: Typecheck + lint + tests**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 3: Playtest — no visual regression**

Run: `bun run dev`, start a run, switch weapons (1/2/3), fire.
Expected: weapon rig looks and draws exactly as before (this is a refactor).

- [ ] **Step 4: Commit**

```bash
git add game/game.ts
git commit -m "refactor(game): extract drawRigParts for reuse by overlay props"
```

---

## Task 4: FX emitters for action feel

**Files:**
- Modify: `game/systems/fx.ts` (add exports)

**Interfaces:**
- Produces:
  - `fxMote(state, x, y, color: RGB): void` — one slow rising mote (heal aura, tending aura).
  - `fxDust(state, x, y, n: number): void` — `n` short-lived smoke puffs kicked outward (search/repair).
  - `fxActionBurst(state, x, y, color: RGB, big: boolean): void` — a completion ring + spark spray (loot/repair/revive done).

These are cosmetic; they gate on typecheck/lint + being exercised by later tasks. Add after `fxPickup`:

- [ ] **Step 1: Add the emitters**

```ts
/** one slow, rising mote — an ongoing "something is happening" cue (heal / tending aura) */
export function fxMote(state: State, x: number, y: number, color: RGB): void {
  spawn(state, x + rand(-6, 6), y + rand(-4, 4), rand(-8, 8), rand(-40, -18), rand(0.4, 0.8), rand(1.5, 3), color, "spark", 1.5);
}

/** a few short-lived dust puffs kicked outward (rummaging / hammering debris) */
export function fxDust(state: State, x: number, y: number, n: number): void {
  const dust: RGB = [0.45, 0.4, 0.34];
  for (let i = 0; i < n; i++) {
    const a = rand(0, 6.28);
    const sp = rand(30, 90);
    spawn(state, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.2, 0.4), rand(2, 4), dust, "smoke", 3);
  }
}

/** a completion burst: an expanding ring + a spark spray in `color` (loot / repair / revive done) */
export function fxActionBurst(state: State, x: number, y: number, color: RGB, big: boolean): void {
  spawn(state, x, y, 0, 0, big ? 0.34 : 0.24, big ? 30 : 18, color, "ring", 0);
  const n = big ? 14 : 9;
  for (let i = 0; i < n; i++) {
    const a = rand(0, 6.28);
    const sp = rand(70, big ? 220 : 160);
    spawn(state, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.2, 0.45), rand(1.5, 3), color, "spark", 6);
  }
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add game/systems/fx.ts
git commit -m "feat(fx): mote/dust/action-burst emitters for action feel"
```

---

## Task 5: Sync the new action state (wire change + PROTOCOL bump)

**Files:**
- Modify: `game/net/net.ts` (bump `PROTOCOL_VERSION`)
- Modify: `game/net/snapshot.ts` (SnapPlayer type, capture, encode, decode, apply)
- Modify: `game/systems/player.ts` (decay `swingT` each tick so it's advanced host-side)
- Test: `game/net/snapshot.test.ts` (round-trip; create if absent)

**Interfaces:**
- Consumes: `Player.searching`/`swingT`/`swingKind` (Task 2), `q01`/`dq01`, the flag byte at `snapshot.ts:573/697`.
- Produces: these three fields survive encode→decode; `deriveActionChannel` works on remote players.

- [ ] **Step 1: Bump the protocol version**

`game/net/net.ts`: change `export const PROTOCOL_VERSION = 13;` → `14`.

> **Note on ordering:** the `SnapPlayer` interface + `captureSnapshot`/`applySnapshot` objects are name-keyed, so field *position* there is free ("after assistT" is just for readability). But the **encode/decode byte stream is positional** — the swing byte must be written and read at the *same* offset. This plan puts it **immediately after the flag byte** (`snapshot.ts:573` encode / `:697` decode), which is the last field in the player record. Keep encode and decode in lockstep.

- [ ] **Step 2: Add fields to `SnapPlayer`**

In `snapshot.ts` `interface SnapPlayer`, after `assistT: number;`:

```ts
  searching: boolean;
  swingT: number;
  swingKind: "" | "repair" | "mateHeal";
```

- [ ] **Step 3: Capture them** (`captureSnapshot`, after `assistT: p.assistT,`):

```ts
      searching: p.searching,
      swingT: p.swingT,
      swingKind: p.swingKind,
```

- [ ] **Step 4: Encode** — extend the flag byte and add the swing byte. In the encode loop, replace the flag-byte line (`snapshot.ts:573`):

```ts
    const swingKindBits = p.swingKind === "repair" ? 4 : p.swingKind === "mateHeal" ? 8 : 0;
    w.u8((p.lightOn ? 1 : 0) | (p.absent ? 2 : 0) | (p.searching ? 16 : 0) | swingKindBits);
    w.u8(q01(p.swingT, MAX_SWING));
```

Add near `MAX_DRAWTIME` (snapshot.ts:448): `const MAX_SWING = CONFIG.actionFeel.swingDecay;` (import `CONFIG` if not already imported — it is used elsewhere in the file).

- [ ] **Step 5: Decode** — replace the flag decode (`snapshot.ts:697-699`):

```ts
    const pflags = r.u8();
    const swingT = dq01(r.u8(), MAX_SWING);
    const lightOn = (pflags & 1) === 1;
    const absent = (pflags & 2) !== 0;
    const searching = (pflags & 16) !== 0;
    const swingKind: "" | "repair" | "mateHeal" =
      (pflags & 4) !== 0 ? "repair" : (pflags & 8) !== 0 ? "mateHeal" : "";
```

Then add `searching, swingT, swingKind` to the `players.push({ ... })` object literal.

- [ ] **Step 6: Apply** (`applySnapshot`, after `p.assistT = sp.assistT;`):

```ts
    p.searching = sp.searching;
    p.swingT = sp.swingT;
    p.swingKind = sp.swingKind;
```

- [ ] **Step 7: Decay `swingT` host-side.** In `sysPlayerOne` (`player.ts`), alongside the other timer decays (near `if (p.switchT > 0) p.switchT -= dt;`), use the tested pure helper so it isn't dead code:

```ts
  p.swingT = decaySwing(p.swingT, dt);
```

Add the import to `player.ts`: `import { decaySwing } from "./actionFeel";`. (Pure `max(0, x - dt)` — deterministic, so single-player sim stays byte-identical.)

- [ ] **Step 8: Write the round-trip test**

`game/net/snapshot.test.ts` **already exists** (imports `captureSnapshot, decode, encode` from `./snapshot`, `newState` from `../state`). It does **not** import `CONFIG` — add `import { CONFIG } from "../config";` at the top. Then add this `it(...)` inside the existing top-level `describe`:

```ts
it("round-trips searching / swingT / swingKind", () => {
  const s = newState();
  const p = s.players[0]!;
  p.searching = true;
  p.swingT = CONFIG.actionFeel.swingDecay * 0.6;
  p.swingKind = "mateHeal";
  const out = decode(encode(captureSnapshot(s)));
  const rp = out.players[0]!;
  expect(rp.searching).toBe(true);
  expect(rp.swingKind).toBe("mateHeal");
  expect(rp.swingT).toBeCloseTo(CONFIG.actionFeel.swingDecay * 0.6, 1);
});
```

- [ ] **Step 9: Run tests + typecheck + lint**

Run: `bun run test -- snapshot && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add game/net/net.ts game/net/snapshot.ts game/net/snapshot.test.ts game/systems/player.ts
git commit -m "feat(net): sync searching/swingT/swingKind; bump PROTOCOL_VERSION 14"
```

---

## Task 6: Reload — rig re-ready pose + eject + ready pop

**Files:**
- Modify: `game/game.ts` (`drawWeaponRig` call site in `drawPlayer:718`, and `drawWeaponRig` to accept reload phase)
- Modify: `game/systems/player.ts` (eject particle at reload start)

**Interfaces:**
- Consumes: `deriveActionChannel` (Task 2), `drawWeaponRig` (Task 3), `fxDust` (Task 4).

No new sync (reloadT already synced). Gates on typecheck/lint + playtest.

- [ ] **Step 1: Make the rig pose respond to reload as it does to switch**

Change `drawWeaponRig`'s signature to take a unified draw phase, and compute it from whichever of switch/reload is active. Replace the `raise` line:

```ts
function drawWeaponRig(
  R: typeof Renderer,
  px: number,
  py: number,
  aim: number,
  wd: WeaponDef,
  rigPhase: number, // 0 = lowered/mid-action, 1 = ready
): void {
  const e = 1 - (1 - rigPhase) * (1 - rigPhase);
  // ... unchanged from Task 3 below this line (DOWN, ang, fwdScale, aMul, parts, drawRigParts)
```

First, compute the action channel **once** at the top of `drawPlayer` (right after `col` is computed, before the `px`/`py` lines at game.ts:698-699) — Task 7 reuses this same `ch`:

```ts
  const ch = deriveActionChannel(pl, state);
```

Then at the rig call site (`drawPlayer`, game.ts:717-718), compute the phase from that channel:

```ts
  const heldWd = WEAPONS[pl.weapon];
  if (heldWd) {
    // reload and switch both lower→raise the rig; other kinds leave it ready (phase 1)
    const rigPhase = ch.kind === "switch" || ch.kind === "reload" ? ch.phase : 1;
    drawWeaponRig(R, px, py, pl.aim, heldWd, rigPhase);
  }
```

Add the import at the top of `game.ts`: `import { deriveActionChannel } from "./systems/actionFeel";`

- [ ] **Step 2: Eject a shell/mag puff at reload start**

In `player.ts`, where reload begins (`p.reloadT = wd.reload; Audio.reload();`), add an eject puff at the gun tip:

```ts
      p.reloadT = wd.reload;
      Audio.reload();
      fxDust(state, p.x - Math.cos(p.aim) * p.r, p.y - Math.sin(p.aim) * p.r, 2);
```

Add `fxDust` to the existing `fx` import in `player.ts` (`import { ..., fxDust } from "./fx";`).

- [ ] **Step 3: Typecheck + lint + tests**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 4: Playtest — reload feels like re-readying**

Run: `bun run dev`. Empty a magazine, reload.
Expected: the gun dips/lowers then rises back to ready over the reload (not just a bar); a small puff ejects at the start; the existing `reloadDone` clack lands as it finishes. Bar still present.

- [ ] **Step 5: Commit**

```bash
git add game/game.ts game/systems/player.ts
git commit -m "feat(reload): rig re-ready pose + eject puff (drive rig from action channel)"
```

---

## Task 7: Heal — pulsing aura + medkit prop + bob + motes + completion burst

**Files:**
- Modify: `game/game.ts` (`drawPlayer` heal block, game.ts:750-754)
- Modify: `game/systems/player.ts` (completion burst + audio on heal finish; ongoing motes)

**Interfaces:**
- Consumes: `deriveActionChannel`, `actionMotion`, `drawRigParts`, `fxMote`, `fxActionBurst`.

- [ ] **Step 1: Replace the static heal aura with pulsing aura + prop + bob**

Replace the heal block in `drawPlayer` (game.ts:750-754):

```ts
  // healing: breathing green aura + a medkit prop raised at the off-hand + rooted bob + bar
  if (pl.healT > 0) {
    const af = CONFIG.actionFeel;
    const prog = 1 - pl.healT / CONFIG.heal.duration;
    const pulse = af.heal.auraBase + af.heal.auraPulse * (0.5 + 0.5 * Math.sin(state.time * af.heal.auraPulseHz * Math.PI * 2));
    R.glow(px, py, pl.r * 3.4, 0.3, 1, 0.45, pulse);
    // medkit prop at the off-hand (lateral to aim): a white box + a green cross, via drawRigParts
    const ox = px - Math.sin(pl.aim) * af.propOffset;
    const oy = py + Math.cos(pl.aim) * af.propOffset;
    drawRigParts(R, MEDKIT_PROP, ox, oy, pl.aim, 1, 1);
    R.rect(pl.x, pl.y - pl.r - 12, 34 * prog, 4, 0, 0.3, 1, 0.45, 1);
  }
```

Add the prop definition near the top of `game.ts` (module scope, beside other draw constants):

```ts
// medkit overlay prop (viz-part shaped): a white case with a green cross. Posed by drawRigParts.
const MEDKIT_PROP: WeaponDef["viz"] = [
  { shape: "rect", dx: 0, dy: 0, len: 9, wid: 7, rot: 0, color: [0.9, 0.9, 0.92] },
  { shape: "rect", dx: 0, dy: 0, len: 6, wid: 2, rot: 0, color: [0.2, 0.85, 0.35] },
  { shape: "rect", dx: 0, dy: 0, len: 2, wid: 6, rot: 0, color: [0.2, 0.85, 0.35] },
];
```

(The bob is applied in Task 7 Step 2 via the shared motion helper so all rooted actions share it — see note. For heal specifically, the visible motion is the prop + aura; the bob offset is added to `px/py` in Step 2.)

- [ ] **Step 2: Apply shared body motion (lean/bob) in `drawPlayer`**

`ch` is already computed at the top of `drawPlayer` (added in Task 6). Using it, replace the plain `const px = pl.x + pl.recoilX;` / `const py = pl.y + pl.recoilY;` lines (game.ts:698-699) with motion-offset versions so every action shares one motion path:

```ts
  const mot = actionMotion(ch.kind, ch.phase, state.time, CONFIG.actionFeel);
  // lean toward the aim focus; bob perpendicular to it
  const px = pl.x + pl.recoilX + Math.cos(pl.aim) * mot.lean - Math.sin(pl.aim) * mot.bob;
  const py = pl.y + pl.recoilY + Math.sin(pl.aim) * mot.lean + Math.cos(pl.aim) * mot.bob;
```

Extend the Task-6 import to `import { actionMotion, deriveActionChannel } from "./systems/actionFeel";` (`CONFIG` is already imported).

- [ ] **Step 3: Ongoing motes + completion burst (host-side)**

In `player.ts`, in the healing block (`if (healing) { ... }`), emit a mote on an interval and fire a burst on the completing tick:

```ts
  const healing = p.healT > 0;
  if (healing) {
    const before = p.healT;
    p.healT -= dt;
    p.hp = Math.min(p.maxHp, p.hp + (CONFIG.heal.amount / CONFIG.heal.duration) * dt);
    // rising motes while it fills
    if (Math.floor(before / CONFIG.actionFeel.heal.moteEveryS) !== Math.floor(p.healT / CONFIG.actionFeel.heal.moteEveryS)) {
      fxMote(state, p.x, p.y, [0.3, 1, 0.45]);
    }
    // completion: green burst + up-chime (this edge; healT crosses 0)
    if (before > 0 && p.healT <= 0) {
      fxActionBurst(state, p.x, p.y, [0.3, 1, 0.45], false);
      Audio.heal();
    }
  }
```

Add `fxMote, fxActionBurst` to the `fx` import in `player.ts`.

- [ ] **Step 4: Client re-derives the heal completion (co-op)**

In `client.ts` `effects`, in the players loop (after the `hitFlash` block, ~line 275-278), add a heal-complete edge. The client never runs the sim, so `healT` for **every** player (including the local one) arrives only via the snapshot (`applySnapshot` sets `p.healT = sp.healT`; the client does *not* predict `healT`). So re-derive the burst from the synced `healT` edge for all players:

```ts
      if (p && p.healT > 0.05 && pl.healT <= 0.05) {
        fxActionBurst(st, pl.x, pl.y, [0.3, 1, 0.45], false);
        if (pl.id === st.localId) Audio.heal();
      }
```

Import `fxActionBurst` in `client.ts` (it already imports from `../systems/fx`).

> **Known limitation (accepted):** on a co-op **client**, the local player's own heal-complete chime/burst is re-derived from the snapshot, so it lags by ~`interpDelay` (≈100 ms) — the spec's "predict your own payoff immediately" isn't achieved for a client's self-heal (there's no local `healT` prediction path). This is accepted: the original complaint and the primary target is **single-player**, where heal fires host-side in `player.ts` immediately (Task 7 Step 3); co-op **host** is likewise immediate. Only a co-op client's *own* heal is slightly late. Predicting client-side `healT` is out of scope (would add a prediction path in `localInput`/`client.ts`); revisit only if it feels wrong in playtest.

- [ ] **Step 5: Typecheck + lint + tests**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 6: Playtest — healing feels active**

Run: `bun run dev`. Take damage, press H.
Expected: a breathing green aura (not flat), a medkit held to the side, a slight rooted bob, green motes rising, and a green pop + chime the instant it finishes. Bar still present.

- [ ] **Step 7: Commit**

```bash
git add game/game.ts game/systems/player.ts game/net/client.ts
git commit -m "feat(heal): pulsing aura, medkit prop, motes, completion burst; shared body motion"
```

---

## Task 8: Search — rummage motion + crate rattle + dust + loot burst

**Files:**
- Modify: `game/systems/player.ts` (set `searching` day+night; ongoing dust; the loot already spawns pickups)
- Modify: `game/game.ts` (`drawCaches` lid rattle + the player rummage motion is already handled by Task 7's shared motion via `searching`→channel)
- Modify: `game/net/client.ts` (loot burst on `looted` edge)

**Interfaces:**
- Consumes: `deriveActionChannel` (search kind from `searching`), `fxDust`, `fxActionBurst`. Note the AI-lure night behavior must be preserved.

- [ ] **Step 1: Set `searching` day AND night (preserve the night-only lure)**

In `player.ts` `interact()`, the SEARCH block currently sets `p.searching = true` only at night. Change so the flag is set whenever searching (for the draw/motion), but keep the AI-lure gated to night. Replace:

```ts
  if (cache && !moving && !healing) {
    cache.searchT += dt;
    searched.add(cache);
    p.searching = true; // drives the rummage motion (draw) for all phases
    // ongoing dust while rummaging
    if (Math.floor((cache.searchT - dt) / CONFIG.actionFeel.search.dustEveryS) !== Math.floor(cache.searchT / CONFIG.actionFeel.search.dustEveryS)) {
      fxDust(state, cache.x, cache.y, 2);
    }
    if (cache.searchT >= effectiveSearchTime(state.phase)) {
      lootCache(state, cache.x, cache.y, cache.tier);
      cache.looted = true;
      cache.searchT = 0;
      fxActionBurst(state, cache.x, cache.y, [0.9, 0.8, 0.4], false);
      Audio.pickup();
    }
  }
```

> **REQUIRED — gate the AI lure to night (single-player byte-identity):** `sysAI` reads `pl.searching` to surge nearby zombies (the "noise" lure). Verified: `ai.ts:119-128` has **no independent night gate** — the lure is night-only *today only because* `searching` is set night-only. Since this task sets `searching` in all phases, the lure loop **must** be wrapped in a night check, or the day scavenge phase gains a lure it never had (a feel change + a `single-player byte-for-byte unchanged` violation). This is mandatory, not conditional. Change `ai.ts:119-128` from:
>
> ```ts
>     let lureMul = 0;
>     for (const pl of state.players) {
>       if (!pl.searching) continue;
>       const lx = pl.x - z.x;
>       const ly = pl.y - z.y;
>       if (lx * lx + ly * ly <= lureR2) {
>         lureMul = CONFIG.cache.lureSpeedSurge;
>         break;
>       }
>     }
> ```
>
> to (add the outer `if`):
>
> ```ts
>     let lureMul = 0;
>     if (state.phase === "night") {
>       for (const pl of state.players) {
>         if (!pl.searching) continue;
>         const lx = pl.x - z.x;
>         const ly = pl.y - z.y;
>         if (lx * lx + ly * ly <= lureR2) {
>           lureMul = CONFIG.cache.lureSpeedSurge;
>           break;
>         }
>       }
>     }
> ```
>
> Verify no other reader of `pl.searching` exists that assumes night (`grep -rn "\.searching" game/` — expect only `sysAI` and the `player.ts` set/reset). (Single-player at night is unchanged; day gains no lure.)

`p.searching` is reset each tick at the top of `sysPlayerOne` (`p.searching = false`) and set here — that logic already exists; confirm it still runs for the day path.

Add `fxDust, fxActionBurst` to the `fx` import in `player.ts` (already added in earlier tasks).

- [ ] **Step 2: Crate lid rattle while searched**

In `drawCaches` (game.ts:951-955), jitter the lid while `searchT > 0`. Replace the search-progress block:

```ts
    if (c.searchT > 0) {
      const af = CONFIG.actionFeel.search;
      const rattle = Math.sin(state.time * af.digHz * Math.PI * 2) * af.lidRattle;
      R.rect(c.x + rattle, c.y + bob - 6, 22, 4, 0, 0.4, 0.33, 0.2, 1); // rattling lid
      const f = Math.min(1, c.searchT / effectiveSearchTime(state.phase));
      R.rect(c.x, c.y - 20, 30, 4, 0, 0.05, 0.05, 0.05, 0.8);
      R.rect(c.x - (30 * (1 - f)) / 2, c.y - 20, 30 * f, 4, 0, 0.3, 1, 0.45, 1);
    }
```

- [ ] **Step 3: Client re-derives the loot burst on the `looted` edge (co-op)**

In `client.ts` `effects`, the snapshot carries `caches: { looted, searchT }[]`. Add a caches diff (caches are index-matched, not id-matched):

```ts
    for (let i = 0; i < next.caches.length; i++) {
      const pc = prev.caches[i];
      const nc = next.caches[i];
      if (pc && nc && !pc.looted && nc.looted) {
        // cache positions aren't in the snapshot; use the live state's cache list (index-matched)
        const cache = st.caches[i];
        if (cache) fxActionBurst(st, cache.x, cache.y, [0.9, 0.8, 0.4], false);
      }
    }
```

(Loot pickups themselves already appear via the pickup snapshot + existing `fxPickup` on collect; this adds the crate-side pop. Audio.pickup on the client fires from the existing pickup-collect path — do not double-play here.)

- [ ] **Step 4: Typecheck + lint + tests**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 5: Playtest — rummaging reads as work**

Run: `bun run dev`. Stand on a cache (day) and search.
Expected: the character leans/bobs at the crate, the lid rattles, dust puffs rise, and a warm pop fires when it opens. At night, the existing zombie lure still triggers.

- [ ] **Step 6: Commit**

```bash
git add game/systems/player.ts game/game.ts game/net/client.ts
git commit -m "feat(search): rummage motion, crate rattle, dust, loot burst (searching synced)"
```

---

## Task 9: Revive — reviver tending aura + beam + completion burst

**Files:**
- Modify: `game/game.ts` (`drawPlayer` / a new `drawReviveLink`, driven by nearby downed teammates)
- Modify: `game/net/client.ts` (revive-complete burst on the downed player's `hp` 0→>0 edge)

**Interfaces:**
- Consumes: `state.players`, `assistT`, `CONFIG.assist.reviveTime`, `CONFIG.siege.interactRadius`, `fxActionBurst`. Reviver is derived client-side (nearest standing teammate to a downed body with `assistT > 0`).

Revive is co-op only (`state.players.length >= 2`). Single-player never triggers it.

- [ ] **Step 1: Draw the tending link + aura**

Add a draw pass (called from `draw()` after players are drawn). Add a function and a call:

```ts
/** Co-op: for each downed teammate being revived, draw a tending aura on the body + a faint beam
 *  from the nearest standing teammate (the reviver). Purely derived — no synced reviver id. */
function drawReviveLinks(R: typeof Renderer): void {
  if (state.players.length < 2) return;
  const af = CONFIG.actionFeel.revive;
  const reach2 = CONFIG.siege.interactRadius * CONFIG.siege.interactRadius;
  for (const t of state.players) {
    if (t.hp > 0 || t.absent || t.assistT <= 0) continue;
    const prog = Math.min(1, t.assistT / CONFIG.assist.reviveTime);
    const pulse = af.beamAlpha * (0.6 + 0.4 * Math.sin(state.time * af.auraPulseHz * Math.PI * 2));
    R.glow(t.x, t.y, t.r * 3, 0.4, 1, 0.6, pulse); // tending aura on the body
    // nearest standing teammate = the reviver; draw a faint beam
    let rv: Player | null = null;
    let best = reach2;
    for (const h of state.players) {
      if (h === t || h.hp <= 0 || h.absent) continue;
      const d = (h.x - t.x) ** 2 + (h.y - t.y) ** 2;
      if (d < best) { best = d; rv = h; }
    }
    if (rv) {
      const mx = (rv.x + t.x) / 2;
      const my = (rv.y + t.y) / 2;
      R.glow(mx, my, 8 + 10 * prog, 0.4, 1, 0.6, pulse * 0.8);
    }
  }
}
```

Call `drawReviveLinks(R);` in `draw()` right after the players are drawn (find the loop that calls `drawPlayer`/`drawDownedPlayer` and add the call after it).

- [ ] **Step 2: Completion burst on revive**

In `client.ts` `effects`, players loop, add the revive-complete edge:

```ts
      if (p && p.hp <= 0 && pl.hp > 0) {
        fxActionBurst(st, pl.x, pl.y, [0.4, 1, 0.6], true);
      }
```

For single-player/host, add the same burst in `revivePlayer` (`engine/players.ts`) is not possible (it can't import fx cleanly / it's an engine helper). Instead fire it host-side in `sysAssist` (`assist.ts`) right before/after `revivePlayer`:

```ts
    if (target.assistT >= CONFIG.assist.reviveTime) {
      fxActionBurst(state, target.x, target.y, [0.4, 1, 0.6], true);
      revivePlayer(state, target, { inPlace: true, hp: Math.round(target.maxHp * CONFIG.assist.reviveHpFrac) });
    }
```

Import `fxActionBurst` in `assist.ts`. (Host fires it; the client also re-derives via the `hp` edge — guard against double-play by firing the client burst only when NOT the host. Since a client never runs `sysAssist`, and the host never runs `effects`, there is no double-play: the two paths are mutually exclusive by role.)

- [ ] **Step 3: Typecheck + lint + tests**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 4: Playtest (co-op)**

Run: `bun run dev:coop` (or two browser tabs via room code). Down one player, stand the other on them.
Expected: a pulsing green aura on the body + a faint beam to the reviver while the gauge fills; a shockwave burst when they get up. Single-player unaffected.

- [ ] **Step 5: Commit**

```bash
git add game/game.ts game/net/client.ts game/systems/assist.ts
git commit -m "feat(revive): tending aura + beam + completion burst (reviver derived)"
```

---

## Task 10: Repair + mate-heal — swing ramp state

**Files:**
- Modify: `game/systems/player.ts` (`interact()`: set `swingT`/`swingKind` on each press)

**Interfaces:**
- Consumes: `CONFIG.actionFeel.swingDecay`. Produces the synced swing signal (already wired in Task 5) that `deriveActionChannel` reads.

- [ ] **Step 1: Set the swing ramp on each repair / mate-heal press**

In `interact()`, the costed E block (`player.ts:335-353`), set the swing on each successful action:

```ts
    if (mate && (!bar || mateD <= barD)) {
      p.medkits -= 1;
      mate.hp = Math.min(mate.maxHp, mate.hp + CONFIG.heal.amount);
      p.repairCd = CONFIG.siege.repairCd;
      p.swingT = CONFIG.actionFeel.swingDecay;
      p.swingKind = "mateHeal";
      Audio.heal();
    } else if (bar && p.money >= CONFIG.siege.repairCost) {
      const before = bar.hp;
      p.money -= CONFIG.siege.repairCost;
      bar.hp = Math.min(bar.maxHp, bar.hp + CONFIG.siege.repairAmount);
      const restored = bar.hp - before;
      p.money += Math.round(CONFIG.econ.repairReward * (restored / CONFIG.siege.repairAmount));
      p.repairCd = CONFIG.siege.repairCd;
      p.swingT = CONFIG.actionFeel.swingDecay;
      p.swingKind = "repair";
      // completion: barricade just reached full → burst on the segment midpoint
      if (before < bar.maxHp && bar.hp >= bar.maxHp) {
        const mx = (bar.x1 + bar.x2) / 2;
        const my = (bar.y1 + bar.y2) / 2;
        fxActionBurst(state, mx, my, [0.8, 0.7, 0.3], false);
      }
      Audio.repair();
    }
```

(`swingT` decay was already added host-side in Task 5 Step 7.)

- [ ] **Step 2: Typecheck + lint + tests**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add game/systems/player.ts
git commit -m "feat(repair): swing ramp on repair/mate-heal presses + repaired burst"
```

---

## Task 11: Repair + mate-heal — swing motion, tool/medkit prop, sparks

**Files:**
- Modify: `game/game.ts` (`drawPlayer`: render prop + sparks for `swing` kinds)
- Modify: `game/systems/player.ts` (ongoing sparks/dust on each swing edge)
- Modify: `game/net/client.ts` (repair-done on barricade `hp→maxHp`; mate-heal glow on receiver `hp` rise)

**Interfaces:**
- Consumes: `deriveActionChannel` (repair/mateHeal kinds already flow through the shared motion from Task 7 Step 2), `drawRigParts`, `fxImpact`/`fxDust`, `fxActionBurst`.

- [ ] **Step 1: Draw the tool / medkit prop for swing kinds**

In `drawPlayer`, after the heal block, add a prop for the active swing (reuse `MEDKIT_PROP` for mate-heal; a `TOOL_PROP` for repair):

```ts
  if (ch.kind === "repair" || ch.kind === "mateHeal") {
    const af = CONFIG.actionFeel;
    const ox = px - Math.sin(pl.aim) * af.propOffset;
    const oy = py + Math.cos(pl.aim) * af.propOffset;
    const prop = ch.kind === "repair" ? TOOL_PROP : MEDKIT_PROP;
    drawRigParts(R, prop, ox, oy, pl.aim + (1 - ch.phase) * 0.5, 1, 1); // slight swing rotation
  }
```

Add `TOOL_PROP` beside `MEDKIT_PROP`:

```ts
// hammer/tool overlay prop: a handle + a head.
const TOOL_PROP: WeaponDef["viz"] = [
  { shape: "rect", dx: 4, dy: 0, len: 12, wid: 2.5, rot: 0, color: [0.5, 0.4, 0.3] },
  { shape: "rect", dx: 10, dy: 0, len: 5, wid: 6, rot: 0, color: [0.7, 0.72, 0.75] },
];
```

(`ch` is already computed at the top of `drawPlayer` from Task 7.)

- [ ] **Step 2: Ongoing sparks/dust per swing (host-side)**

In `interact()`'s repair branch, emit debris at the wall on each press (add near the `Audio.repair()` line):

```ts
      const mx2 = (bar.x1 + bar.x2) / 2;
      const my2 = (bar.y1 + bar.y2) / 2;
      fxImpact(state, mx2, my2, p.aim, [0.85, 0.7, 0.35]); // sparks (intensity 0 = wall-spark look)
      fxDust(state, mx2, my2, CONFIG.actionFeel.repair.dust);
```

For mate-heal, emit a couple of green motes toward the mate (add in the mate branch):

```ts
      fxMote(state, mate.x, mate.y, [0.3, 1, 0.45]);
```

Ensure `fxImpact, fxMote` are imported in `player.ts` (`fxImpact` already is).

- [ ] **Step 3: Client re-derivation (co-op)**

In `client.ts` `effects`, add barricade repair-done (barricades are index-matched, snapshot carries `hp`):

```ts
    for (let i = 0; i < next.barricades.length; i++) {
      const pb = prev.barricades[i];
      const nb = next.barricades[i];
      const bar = st.barricades[i];
      if (pb && nb && bar && pb.hp < nb.hp && nb.hp >= bar.maxHp && pb.hp < bar.maxHp) {
        const mx = (bar.x1 + bar.x2) / 2;
        const my = (bar.y1 + bar.y2) / 2;
        fxActionBurst(st, mx, my, [0.8, 0.7, 0.3], false);
      }
    }
```

Mate-heal receiver glow: add in the players loop (receiver `hp` rose while not from revive — a small green glow):

```ts
      if (p && pl.hp > p.hp + 1 && p.hp > 0 && pl.hp < pl.maxHp + 1) {
        fxMote(st, pl.x, pl.y, [0.3, 1, 0.45]);
      }
```

Import `fxMote` in `client.ts`.

- [ ] **Step 4: Typecheck + lint + tests**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 5: Playtest**

Run: `bun run dev`. Stand by a damaged barricade at night, hold E to repair.
Expected: the character swings a tool toward the wall (continuous while held, one swing on a single tap), sparks + dust fly at the wall, and a burst fires when the wall reaches full. In co-op, giving a teammate a medkit shows a give-gesture + a glow on them.

- [ ] **Step 6: Commit**

```bash
git add game/game.ts game/systems/player.ts game/net/client.ts
git commit -m "feat(repair/mate-heal): swing motion, tool/medkit prop, sparks, completion cues"
```

---

## Task 12: Deploy — draw-only spawn-in

**Files:**
- Modify: `game/game.ts` (`drawDeployables` emerge scale via a draw-local first-seen map)
- Modify: `game/net/client.ts` (spawn burst on new-deployable-id edge)
- Modify: `game/game.ts` `applyPlace` / its caller (place accent audio)

**Interfaces:**
- Consumes: `state.time`, `state.deployables`, `CONFIG.actionFeel.deploy.emerge`, `fxActionBurst`. No new sync — the emerge is derived from first-seen time; the burst from the id-appear edge.

- [ ] **Step 1: Draw-local first-seen map for the emerge scale**

At module scope in `game.ts`, add:

```ts
// draw-only: first time each deployable id was seen (for the spawn-in emerge). Works for SP
// (id appears when placed) and co-op (id appears in a snapshot) — no synced spawn timer needed.
const deployableSeen = new Map<number, number>();
```

**Do NOT scale the body geometry.** `drawDeployables` (game.ts:836-922) draws each unit as many parts at **absolute coordinates** (`d.x + Math.cos(d.aim) * arm`, `d.x + sx * 8`, `bx + px * 3`, …). Multiplying only the *size* args would shrink parts without shrinking their offsets → a "disassembled" scatter, not a scale-in. Instead the emerge is an **overlay only**: an expanding landing ring + a fading glow flash on top of the normally-drawn body. This matches the spec ("rises/settles with a landing ring + dust") without touching the multi-part geometry.

In `drawDeployables`, at the top of the per-deployable loop (right after `const [r, g, b] = def.color;`), compute the emerge age and draw the overlay:

```ts
    if (!deployableSeen.has(d.id)) deployableSeen.set(d.id, state.time);
    const age = state.time - (deployableSeen.get(d.id) ?? state.time);
    const emerge = Math.min(1, age / CONFIG.actionFeel.deploy.emerge); // 0..1
    if (emerge < 1) {
      const k = 1 - emerge;
      R.ring(d.x, d.y, 30 * k + 8, r, g, b, 0.6 * k); // settling landing ring
      R.glow(d.x, d.y, 24, r, g, b, 0.5 * k); // spawn-in flash, fades to nothing
    }
```

The body draw below is unchanged (drawn at full immediately — the overlay reads as the settle). Prune stale ids at the end of the function so the map can't grow unbounded across a long run:

```ts
  if (deployableSeen.size > 64) {
    const live = new Set(state.deployables.map((d) => d.id));
    for (const id of deployableSeen.keys()) if (!live.has(id)) deployableSeen.delete(id);
  }
```

(Place the prune after the `for` loop, before the function's closing brace.)

- [ ] **Step 2: Spawn burst on a new deployable id (host + client)**

Client (`client.ts` `effects`) — mirror the existing destruction diff (which fires on id-vanish) with an id-appear burst:

```ts
    const prevDIds = new Set(prev.deployables.map((d) => d.id));
    for (const d of next.deployables) {
      if (!prevDIds.has(d.id)) {
        const def = DEPLOYABLE_TYPES[d.defId];
        fxActionBurst(st, d.x, d.y, (def?.color ?? GREY) as RGB, false);
      }
    }
```

Host/single: fire the burst in `placeDeployable` (`data/deployables.ts`) after the push:

```ts
  state.deployables.push(d);
  fxActionBurst(state, x, y, (def.color ?? [0.6, 0.6, 0.6]) as [number, number, number], false);
```

Import `fxActionBurst` in `deployables.ts`. (Host and client roles are mutually exclusive, so no double-play.)

- [ ] **Step 3: Place accent audio**

The place caller is `Audio.ui(applyPlace(state, localPlayer(state)));` (`game.ts:1263`). Replace the generic UI sound on a successful place with the repair "thud" accent:

```ts
  const placed = applyPlace(state, localPlayer(state));
  if (placed) Audio.repair();
  else Audio.ui(false);
```

- [ ] **Step 4: Typecheck + lint + tests**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 5: Playtest**

Run: `bun run dev`. Buy a deployable in the shop, deploy the day, place it with Q.
Expected: the object scales/settles in with a landing ring + a place thud, instead of popping into existence.

- [ ] **Step 6: Commit**

```bash
git add game/game.ts game/net/client.ts game/data/deployables.ts
git commit -m "feat(deploy): draw-only spawn-in + landing ring + place accent"
```

---

## Task 13 (optional): Weapon-switch ready flash

**Files:**
- Modify: `game/game.ts` (`drawPlayer`: a brief scale/flash as `switchT` hits 0)

Only do this if playtesting the other six shows switch now feels flat by comparison. Low priority.

- [ ] **Step 1: Add a ready pop**

In `drawPlayer`, near the rig draw, when the switch just completed (`pl.switchT > 0` is false but was recently), a cheap approach is a small muzzle-position glow keyed on a short window. Simplest: while `deriveActionChannel` reports `switch` with `phase > 0.85`, add a brief bright ring at the gun tip:

```ts
  if (ch.kind === "switch" && ch.phase > 0.85) {
    const tx = px + Math.cos(pl.aim) * pl.r * 1.5;
    const ty = py + Math.sin(pl.aim) * pl.r * 1.5;
    R.glow(tx, ty, pl.r * 1.1, 1, 1, 1, (ch.phase - 0.85) / 0.15 * 0.5);
  }
```

- [ ] **Step 2: Typecheck + lint + playtest + commit**

Run: `bun run typecheck && bun run lint`
Playtest: switch weapons; a subtle ready-shimmer lands as the gun raises.

```bash
git add game/game.ts
git commit -m "feat(switch): optional ready-flash on draw complete"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** reload (T6), heal (T7), search (T8), revive (T9), repair+mate-heal (T10/T11), deploy (T12), switch (T13 optional). Shared vocabulary: motion (T2/T7), prop (T3/T7/T11), particles (T4), payoff (T4 + per-action). Synced state + PROTOCOL bump (T5). `deriveActionChannel` pure + tested (T2). Payoffs anchored on persistent diffs — heal `healT` edge, search `looted` edge, repair barricade `hp→maxHp`, revive `hp` 0→>0, deploy new-id (all in T7–T12). Local-predict vs remote-rederive handled by role exclusivity (host runs systems, client runs `effects`).
- **No floating text:** confirmed — all payoffs are bursts/glows/audio.
- **Type consistency:** `ActionKind`/`ActionChannel`/`swingKind` union (`"" | "repair" | "mateHeal"`) consistent across `actionFeel.ts`, `types.ts`, `snapshot.ts`. `drawRigParts` signature consistent (T3 → T7/T11). `fxActionBurst(state, x, y, color, big)` consistent across callers.
- **AI-lure preservation** (T8) and **single-player byte-identity** are called out explicitly; verify `ai.ts` gates the lure on night after `searching` becomes all-phase.
