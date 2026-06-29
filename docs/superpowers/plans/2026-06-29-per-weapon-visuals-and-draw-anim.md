# Per-weapon Visuals + Weapon-switch Draw Animation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every weapon a distinct held silhouette and replace the flat `switchRaise` fire-lockout with a per-weapon `switchT` timer that drives a lower→raise "drawing" animation, synced for co-op.

**Architecture:** Silhouettes are **data** on `WeaponDef` (a `viz: GunPart[]` parts array); `drawPlayer` iterates parts through a generic shape dispatch — zero per-weapon branches. A new `Player.switchT` timer (host-driven, set to the new weapon's `drawTime` on switch) drives the draw pose and is synced to clients u8-quantized, mirroring how `reloadT` flows but at 1 byte/player.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Bun, Vite, Vitest, custom WebGL2 renderer (instanced, `SHAPE` enum + `FLOATS=10`).

## Global Constraints

- **Data-driven, zero special-case:** new look/timing rides `WeaponDef` fields; `drawPlayer` gets a generic per-*shape* dispatch, never a per-*weapon* branch. (CLAUDE.md)
- **Feel-first:** the silhouette + draw pose are **not done until played and felt** in `bun run dev`. Tuning constants below are starting points, not targets. (CLAUDE.md)
- **Co-op:** systems stay net-agnostic; sync state via snapshots only. Single-player gameplay change here (per-weapon `drawTime` replacing `switchRaise 0.5`) is *intentional*; the co-op plumbing must not cause any *unintended* SP change.
- **Wire format:** any change to the snapshot byte layout REQUIRES bumping `PROTOCOL_VERSION` (`game/net/net.ts:19`) and regenerating the golden test (`snapshot.test.ts`). Silent desync is the guarded failure mode.
- **Invariant:** every weapon must have `drawTime > 0` (the draw pose divides by it) and a non-empty `viz`.
- `bun run typecheck`, `bun run test`, `bun run lint` must pass (pre-push + CI gates).

Spec: `docs/superpowers/specs/2026-06-29-per-weapon-visuals-and-draw-anim-design.md`

---

## File Structure

- `game/types.ts` — add `GunPart` interface; add `viz`/`drawTime` to `WeaponDef`; add `switchT` to `Player`.
- `game/data/weapons.ts` — add `viz` + `drawTime` to all 7 weapon entries.
- `game/data/weapons.test.ts` *(new)* — invariant test: every weapon has `drawTime > 0` and non-empty `viz`.
- `game/systems/player.ts` — switch block sets `switchT`/`fireCd` from the new weapon's `drawTime`; decrement `switchT` each tick.
- `game/systems/player.test.ts` — update the switch test (switchRaise → drawTime) + assert `switchT`.
- `game/config.ts` — remove `CONFIG.player.switchRaise` + its comment.
- `game/engine/players.ts` — init `switchT: 0` (`makePlayer`) + reset (`revivePlayer`).
- `game/game.ts` — replace the single generic gun rect in `drawPlayer` with a `drawWeaponRig` helper (parts loop + draw pose).
- `game/net/snapshot.ts` — add `switchT` to `SnapshotPlayer` + capture/apply/encode(u8)/decode; add `MAX_DRAWTIME`.
- `game/net/net.ts` — bump `PROTOCOL_VERSION` 9 → 10.
- `game/net/snapshot.test.ts` — round-trip assertion for `switchT`; regenerate the golden inline snapshot.
- `game/net/client.ts` — add `lp.switchT <= 0` to the local fire-feel prediction gate.

---

## Task 1: WeaponDef visual data — `GunPart`, `viz`, `drawTime`

**Files:**
- Modify: `game/types.ts` (add `GunPart`; extend `WeaponDef`)
- Modify: `game/data/weapons.ts` (add `viz` + `drawTime` to all 7 entries)
- Test: `game/data/weapons.test.ts` (create)

**Interfaces:**
- Produces: `GunPart` interface; `WeaponDef.viz: GunPart[]`; `WeaponDef.drawTime: number`. Consumed by Task 3 (`drawWeaponRig`) and Task 2 (`drawTime` for the switch timer).

```ts
export interface GunPart {
  /** forward offset along aim, world units (+ = toward muzzle) */
  dx: number;
  /** lateral offset perpendicular to aim, world units (a mag hangs / a sight sits) */
  dy: number;
  /** rotation relative to the rig, radians (0 = aligned with the barrel) */
  rot: number;
  /** for rect: length along the barrel axis. For radial shapes: the diameter (rad = len/2). World units. */
  len: number;
  /** rect width across the axis (world units). Ignored by radial shapes. */
  wid: number;
  /** primitive; defaults to "rect". radial shapes (circle/ring/tri/hex) use rad = len/2 */
  shape?: "rect" | "circle" | "ring" | "tri" | "hex";
  /** rgb; defaults to the weapon's `color` */
  color?: [number, number, number];
  /** 0..1; defaults to 1 (multiplied by the draw-pose dim) */
  alpha?: number;
}
```

- [ ] **Step 1: Write the failing test** — `game/data/weapons.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { WEAPONS } from "./weapons";

describe("weapon visual data invariants", () => {
  it("every weapon has drawTime > 0 (the draw pose divides by it)", () => {
    for (const [id, w] of Object.entries(WEAPONS)) {
      expect(w.drawTime, `${id}.drawTime`).toBeGreaterThan(0);
    }
  });

  it("every weapon has a non-empty viz parts array", () => {
    for (const [id, w] of Object.entries(WEAPONS)) {
      expect(w.viz.length, `${id}.viz`).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run game/data/weapons.test.ts`
Expected: FAIL — type error / `drawTime` is `undefined` (the fields don't exist yet).

- [ ] **Step 3: Add the types** — `game/types.ts`

Add the `GunPart` interface (above) just before `WeaponDef`. Then add two fields to `WeaponDef` (after `reserveMax`, before the optional melee fields):

```ts
  /** held-weapon silhouette: primitives in gun-local space (x = forward along aim, y = lateral).
   *  drawPlayer applies the player transform + draw-anim pose and renders each part. No per-weapon
   *  branching — drawWeaponRig dispatches per shape only. */
  viz: GunPart[];
  /** seconds to "draw" (lower→raise) after a switch; also the post-switch fire-lockout. Heavier guns
   *  are slower. MUST be > 0 (the draw pose divides by it). Supersedes CONFIG.player.switchRaise. */
  drawTime: number;
```

- [ ] **Step 4: Add `viz` + `drawTime` to all 7 weapons** — `game/data/weapons.ts`

Add these two fields to each weapon object (starting values — **tune in dev**; ~2 parts each, player r=16):

```ts
// pistol — short, stubby
drawTime: 0.35,
viz: [{ dx: 11, dy: 0, rot: 0, len: 15, wid: 6 }],

// smg — thin barrel + small mag
drawTime: 0.4,
viz: [
  { dx: 13, dy: 0, rot: 0, len: 20, wid: 5 },
  { dx: 9, dy: 5, rot: 0, len: 7, wid: 4 },
],

// shotgun — thick barrel + stock
drawTime: 0.5,
viz: [
  { dx: 14, dy: 0, rot: 0, len: 23, wid: 9 },
  { dx: -2, dy: 0, rot: 0, len: 8, wid: 6 },
],

// rifle — long thin barrel + mag
drawTime: 0.45,
viz: [
  { dx: 16, dy: 0, rot: 0, len: 26, wid: 4 },
  { dx: 10, dy: 5, rot: 0, len: 7, wid: 4 },
],

// lmg — longest barrel + drum (circle) + ...
drawTime: 0.7,
viz: [
  { dx: 20, dy: 0, rot: 0, len: 34, wid: 5 },
  { dx: 8, dy: 6, rot: 0, len: 10, wid: 10, shape: "circle" },
],

// magnum — short but very thick + cylinder (hex)
drawTime: 0.55,
viz: [
  { dx: 11, dy: 0, rot: 0, len: 16, wid: 8 },
  { dx: 5, dy: 0, rot: 0, len: 9, wid: 9, shape: "hex" },
],

// knife — short blade only
drawTime: 0.3,
viz: [{ dx: 10, dy: 0, rot: 0, len: 12, wid: 3 }],
```

- [ ] **Step 5: Run test + typecheck to verify pass**

Run: `bunx vitest run game/data/weapons.test.ts && bun run typecheck`
Expected: PASS (both tests green; tsc clean — every `WeaponDef` now has the required fields).

- [ ] **Step 6: Commit**

```bash
git add game/types.ts game/data/weapons.ts game/data/weapons.test.ts
git commit -m "feat(weapons): add per-weapon viz silhouette + drawTime data"
```

---

## Task 2: `switchT` timer — sim, init, config removal

**Files:**
- Modify: `game/types.ts` (add `Player.switchT`)
- Modify: `game/engine/players.ts:37` (`makePlayer`), `:99` (`revivePlayer`)
- Modify: `game/systems/player.ts:120-134` (switch block) + the per-frame decrement
- Modify: `game/config.ts:79-82` (remove `switchRaise`)
- Test: `game/systems/player.test.ts:157-166` (update)

**Interfaces:**
- Consumes: `WEAPONS[id].drawTime` (Task 1).
- Produces: `Player.switchT: number` (0 when not drawing; counts down from `drawTime`). Consumed by Task 3 (draw pose), Task 4 (snapshot), Task 5 (client gate).

- [ ] **Step 1: Update the failing test** — `game/systems/player.test.ts`

Replace the body of the `"switches to an owned weapon and applies the fire raise"` test (lines 157-166) with (slot 1 = `smg` per `WEAPON_ORDER`):

```ts
  it("switches to an owned weapon and applies the draw timer (no instant fire)", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    p.input = { ...emptyInput(), weaponSlot: 1 }; // smg (owned starter)
    sysPlayer(s, 0.016);
    expect(p.weapon).toBe("smg");
    const drawTime = WEAPONS.smg?.drawTime ?? 0;
    // switch sets switchT and the fire-lockout to the new weapon's drawTime, then this tick
    // decrements them once (by dt=0.016)
    expect(p.fireCd).toBeGreaterThan(drawTime - 0.02);
    expect(p.switchT).toBeGreaterThan(drawTime - 0.02);
    expect(p.input.weaponSlot).toBeNull(); // edge consumed (no double-switch next sub-step)
  });
```

(`WEAPONS` and `State` are already imported in this test file — confirm at the top; both are used elsewhere in it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run game/systems/player.test.ts`
Expected: FAIL — `p.switchT` is `undefined` (field doesn't exist) and `CONFIG.player.switchRaise` reference is gone once removed; compile/runtime error.

- [ ] **Step 3: Add `Player.switchT`** — `game/types.ts`

Immediately after `reloadT: number;` (line 92) in the `Player` interface:

```ts
  /** weapon-draw timer: set to the new weapon's drawTime on switch, counts down to 0. Drives the
   *  lower→raise held-weapon animation. Cosmetic — the fire-lockout is fireCd. Synced (u8). */
  switchT: number;
```

- [ ] **Step 4: Init `switchT`** — `game/engine/players.ts`

In `makePlayer`, after `reloadT: 0,` (line 38):

```ts
    switchT: 0,
```

In `revivePlayer`, after `p.reloadT = 0;` (line 99):

```ts
  p.switchT = 0;
```

- [ ] **Step 5: Drive `switchT` in the switch block** — `game/systems/player.ts`

Replace the switch block (lines 120-134) with:

```ts
  // switch weapons — only to ones you own; magazine state is preserved per weapon
  if (inp.weaponSlot !== null) {
    const id = WEAPON_ORDER[inp.weaponSlot];
    if (id && p.weapon !== id && state.owned[id]) {
      p.mags[p.weapon] = p.ammo; // stash the rounds left in the current mag
      p.weapon = id;
      p.ammo = p.mags[id] ?? 0; // restore the new weapon's mag
      p.reloadT = 0;
      // draw timer: the gun is lowered then raised over drawTime; you can't fire until it's up.
      // drawTime is wlevel-independent so read WEAPONS directly. Heavier guns draw slower.
      const drawTime = WEAPONS[id]?.drawTime ?? 0.5;
      p.switchT = drawTime;
      p.fireCd = Math.max(p.fireCd, drawTime);
      Audio.switchWeapon(); // holster-away + ready (mirrors reload(): same host-side path)
    }
  }
```

Then add the per-frame decrement next to the existing `fireCd` decrement (line 155, `if (p.fireCd > 0) p.fireCd -= dt;`):

```ts
  if (p.switchT > 0) p.switchT -= dt;
```

**`player.ts` currently imports only `WEAPON_ORDER`** (`game/systems/player.ts:4`). Add `WEAPONS`:

```ts
import { WEAPON_ORDER, WEAPONS } from "../data/weapons";
```

- [ ] **Step 6: Remove `switchRaise`** — `game/config.ts`

Replace lines 79-82 with:

```ts
  // drawTime (per-weapon, in WeaponDef) is the fire-lockout + lower→raise draw beat after a swap,
  // paired with the weapon_switch SFX + move ramp. Tune per weapon by playtest, not clip length.
  player: { radius: 16, speed: 200, maxHp: 100, moveRampRate: 1.5 },
```

- [ ] **Step 7: Run test + typecheck to verify pass**

Run: `bunx vitest run game/systems/player.test.ts && bun run typecheck`
Expected: PASS. typecheck clean (no remaining `switchRaise` references — `grep -rn switchRaise game/` should return nothing).

- [ ] **Step 8: Commit**

```bash
git add game/types.ts game/engine/players.ts game/systems/player.ts game/systems/player.test.ts game/config.ts
git commit -m "feat(player): switchT draw timer replaces flat switchRaise lockout"
```

---

## Task 3: Per-weapon silhouette + draw pose in `drawPlayer`

**Files:**
- Modify: `game/game.ts` (`drawPlayer` ~615-673; add `drawWeaponRig` helper)

**Interfaces:**
- Consumes: `WeaponDef.viz`/`drawTime` (Task 1), `Player.switchT` (Task 2), `R.rect/circle/ring/tri/hex` (existing).
- Produces: visual only. No exported symbols other than the local `drawWeaponRig`.

**No unit test — this is the feel-first visual core.** Its gate is the `bun run dev` playtest in Step 4 (CLAUDE.md: not done until played and felt). typecheck must still pass.

- [ ] **Step 1: Add the `drawWeaponRig` helper** — `game/game.ts`

Add near `drawPlayer` (e.g. just above it). `WEAPONS` is already imported in `game.ts`:

```ts
/** Draw the held-weapon silhouette from its data-driven `viz` parts, posed by the draw-anim timer.
 *  Generic per-shape dispatch only — no per-weapon branches (CLAUDE.md). The whole rig dips toward
 *  the body and dims at switch start, then extends out and aligns to aim as switchT → 0. */
function drawWeaponRig(
  R: typeof Renderer,
  px: number,
  py: number,
  aim: number,
  wd: WeaponDef,
  switchT: number,
): void {
  const raise = switchT > 0 ? 1 - switchT / wd.drawTime : 1; // 0 = just switched, 1 = ready
  const e = 1 - (1 - raise) * (1 - raise); // ease-out
  const DOWN = 0.6; // rad the rig dips off-aim mid-draw (sign may need flipping in dev — Y is flipped)
  const ang = aim + (1 - e) * DOWN; // dip while drawing → align when ready
  const fwdScale = 0.3 + 0.7 * e; // pulled in → full extension
  const aMul = 0.6 + 0.4 * e; // dimmed → full
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  for (const part of wd.viz) {
    const fwd = part.dx * fwdScale;
    const lat = part.dy;
    const wx = px + ca * fwd - sa * lat;
    const wy = py + sa * fwd + ca * lat;
    const [cr, cg, cb] = part.color ?? wd.color;
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
```

**`game.ts:31` currently imports `import type { Player, State } from "./types";`** — add `WeaponDef`:

```ts
import type { Player, State, WeaponDef } from "./types";
```

(`WEAPONS` is already imported in `game.ts` — it's used at the current line 629.)

- [ ] **Step 2: Replace the generic gun rect** — `game/game.ts:625-627`

Replace these three lines:

```ts
  const bx = px + Math.cos(pl.aim) * pl.r * 0.9;
  const by = py + Math.sin(pl.aim) * pl.r * 0.9;
  R.rect(bx, by, pl.r * 1.4, 6, pl.aim, 0.85, 0.95, 0.8, 1);
```

with:

```ts
  const heldWd = WEAPONS[pl.weapon];
  if (heldWd) drawWeaponRig(R, px, py, pl.aim, heldWd, pl.switchT);
```

(The melee swing block at 628-652 and everything after is unchanged — the knife's idle blade comes from its `viz`; the `slash` crescent still draws on top during a swing.)

- [ ] **Step 3: Verify it compiles**

Run: `bun run typecheck`
Expected: PASS (no type errors; `part.shape` union is exhaustive with a `default`).

- [ ] **Step 4: PLAYTEST GATE — `bun run dev` (feel-first, required)**

Run: `bun run dev` → open http://localhost:5173 → start a run.
Confirm by **looking** (this is the done-bar, not the compile):
- Each weapon (1/2/3 + knife) reads as a **distinct silhouette** — pistol stubby, smg with mag, shotgun thick + stock, rifle long, lmg longest + drum, magnum thick + hex cylinder, knife small blade. Each tinted by its `color`.
- On every switch the gun **dips/dims then raises** to point along aim over the draw time; heavier guns (lmg/magnum) are visibly slower.
- Firing is locked until the gun is up.
- The dip direction reads correctly (not inverted) — if it dips the wrong way, flip the sign of `DOWN`. Adjust `viz` dx/len/wid, `DOWN`, `fwdScale`/`aMul` ranges, and `drawTime` values **until it feels right**. Re-run as needed.

- [ ] **Step 5: Commit (after the look is tuned and felt)**

```bash
git add game/game.ts game/data/weapons.ts
git commit -m "feat(render): per-weapon silhouettes + lower-raise draw animation"
```

---

## Task 4: Sync `switchT` in snapshots (u8) + protocol bump

**Files:**
- Modify: `game/net/snapshot.ts` (`SnapshotPlayer` ~58; capture ~167; apply ~310; encode ~535; decode ~652/685; `MAX_DRAWTIME` const near `q01`/`dq01` ~428)
- Modify: `game/net/net.ts:19` (`PROTOCOL_VERSION`)
- Test: `game/net/snapshot.test.ts` (round-trip + regenerate golden)

**Interfaces:**
- Consumes: `Player.switchT` (Task 2); `q01`/`dq01` (existing, `snapshot.ts:426-428`).
- Produces: `SnapshotPlayer.switchT: number`; clients receive `p.switchT` via `applySnapshot`.

- [ ] **Step 1: Write the failing round-trip test** — `game/net/snapshot.test.ts`

Add a test (place it near the other round-trip tests). Use the existing `encode`/`decode`/`captureSnapshot` imports already in this file:

```ts
it("round-trips switchT (u8-quantized) through encode/decode", () => {
  const s = newState();
  const p = s.players[0] as State["players"][number];
  p.switchT = 0.4;
  const snap = decode(encode(captureSnapshot(s, 100)));
  // u8 over MAX_DRAWTIME (0.8): step ≈ 0.003, so 2-dp closeness is comfortable
  expect(snap.players[0]?.switchT).toBeCloseTo(0.4, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run game/net/snapshot.test.ts -t "round-trips switchT"`
Expected: FAIL — `switchT` is `undefined` on the decoded player (not in the wire format yet).

- [ ] **Step 3: Add the `MAX_DRAWTIME` constant** — `game/net/snapshot.ts`

After the `dq01` helper (line 428):

```ts
/** quantization ceiling for Player.switchT (≥ the largest WeaponDef.drawTime, with headroom) */
const MAX_DRAWTIME = 0.8;
```

- [ ] **Step 4: Add `switchT` to the 5 snapshot sites** — `game/net/snapshot.ts`

1. `SnapshotPlayer` interface, after `reloadT: number;` (line 58):
```ts
  switchT: number;
```
2. `captureSnapshot`, after `reloadT: p.reloadT,` (line 167):
```ts
      switchT: p.switchT,
```
3. `applySnapshot`, after `p.reloadT = sp.reloadT;` (line 310):
```ts
    p.switchT = sp.switchT;
```
4. `encode`, after `w.f32(p.reloadT);` (line 535):
```ts
    w.u8(q01(p.switchT, MAX_DRAWTIME));
```
5. `decode`, after `const reloadT = r.f32();` (line 652):
```ts
    const switchT = dq01(r.u8(), MAX_DRAWTIME);
```
   and in the `players.push({ ... })` object, after `reloadT,` (line 685):
```ts
      switchT,
```

- [ ] **Step 5: Bump the protocol version** — `game/net/net.ts:19`

```ts
export const PROTOCOL_VERSION = 10;
```

- [ ] **Step 6: Run the round-trip test to verify it passes**

Run: `bunx vitest run game/net/snapshot.test.ts -t "round-trips switchT"`
Expected: PASS (`switchT` ≈ 0.4 survives the round-trip).

- [ ] **Step 7: Regenerate the golden byte-layout snapshot (consciously — we bumped PROTOCOL_VERSION)**

The golden test (`snapshot.test.ts:98-131`) now fails because the per-player byte length grew by 1. This is the intended change and `PROTOCOL_VERSION` is already bumped, so accept the new value:

Run: `bunx vitest run -u game/net/snapshot.test.ts`
Then verify the diff: the inline snapshot `len=...` increased (by 1 per player in the fixture) and `fnv` changed; nothing else in the test moved. Run again without `-u` to confirm green:

Run: `bunx vitest run game/net/snapshot.test.ts`
Expected: PASS (all snapshot tests, including the regenerated golden).

- [ ] **Step 8: Full test + typecheck**

Run: `bun run typecheck && bun run test`
Expected: PASS (whole suite).

- [ ] **Step 9: Commit**

```bash
git add game/net/snapshot.ts game/net/net.ts game/net/snapshot.test.ts
git commit -m "feat(net): sync switchT (u8), bump PROTOCOL_VERSION 9->10"
```

---

## Task 5: Client fire-gate + co-op playtest

**Files:**
- Modify: `game/net/client.ts:431-437` (local fire-feel prediction gate)

**Interfaces:**
- Consumes: `Player.switchT` synced to the client (Task 4).
- Produces: none (prediction-only behavior).

**No unit test — client prediction isn't unit-tested in this codebase.** Gate is the co-op playtest in Step 3 + typecheck.

- [ ] **Step 1: Add `switchT` to the fire-feel gate** — `game/net/client.ts`

In the local fire prediction guard (currently gating on `lp.reloadT <= 0` at line 434), add the `switchT` condition so the client doesn't predict a muzzle flash during the draw window (the host's `fireCd` lockout would reject the shot anyway):

```ts
      if (
        wantFire &&
        this.fireCdLocal <= 0 &&
        lp.reloadT <= 0 &&
        lp.switchT <= 0 &&
        lp.healT <= 0 &&
        (wd.melee || lp.ammo > 0)
      ) {
```

- [ ] **Step 2: Verify it compiles**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: CO-OP PLAYTEST GATE — `bun run dev` + manual SDP (feel-first)**

Run: `bun run dev`. Open two browser windows, connect via the manual-SDP fallback (the `<details>` in the lobby). With two players in a run:
- A teammate's weapon switch shows the **draw animation** (gun dips→raises), not an instant pop.
- No **false muzzle flash** on your own screen if you spam fire immediately after switching (the gun must be up first).
- Single-player still works unchanged (start a solo run, switch weapons, confirm the draw + lockout feel match Task 3).

- [ ] **Step 4: Commit**

```bash
git add game/net/client.ts
git commit -m "feat(net): gate client fire-feel prediction on switchT (no mid-draw flash)"
```

---

## Final verification

- [ ] `bun run typecheck` — clean
- [ ] `bun run test` — green (incl. new `weapons.test.ts`, updated `player.test.ts`, `snapshot.test.ts` round-trip + golden)
- [ ] `bun run lint` — clean
- [ ] `bun run build` — succeeds
- [ ] `grep -rn switchRaise game/` — returns nothing (constant fully removed)
- [ ] Single-player playtest: every weapon has a distinct silhouette + lower→raise draw; heavy guns slower; fire locked until up.
- [ ] Co-op playtest: teammate draw anim visible; no mid-draw false flash; SP unchanged.
- [ ] Open PR (CI `check` + `worker` must pass before merge).
