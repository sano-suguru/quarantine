# Per-weapon visuals + weapon-switch draw animation — design

**Date:** 2026-06-29
**Scope:** Give every weapon a distinct held-weapon silhouette (data-driven, no
per-weapon branches in the renderer), and promote the lightweight `switchRaise`
fire-lockout into a dedicated `switchT` timer that drives a lower→raise "drawing
your weapon" animation. Synced for co-op like `reloadT`.

## Background

PR #26 added the audible + mechanical half of weapon switching (the
`weapon_switch` SFX and a `switchRaise` fire-lockout = the "drawing" beat) on top
of the existing `fireCd`-based raise, and deliberately deferred the visual half.
Extension-point comments mark the three seams:

- `game/config.ts:79-82` — `switchRaise` becomes the draw-time once visuals land.
- `game/systems/player.ts:127-131` — the switch block; `fireCd = max(fireCd, switchRaise)`.
- `game/engine/audio.ts:113` — `switchWeapon()` plays `weapon_switch`.

Today every gun is drawn as **one identical rect** (`game/game.ts:627`):
`R.rect(bx, by, pl.r*1.4, 6, pl.aim, 0.85,0.95,0.8, 1)` — a fixed gray-white bar
that does not even read `wd.color`. Melee (knife) is the one special case: its
swing draws a `slash` crescent (`game.ts:630-646`). `WeaponDef.color` exists but
for guns is used only on bullets/muzzle, never the held weapon.

## Decisions (resolved in brainstorming)

1. **Visual scope:** distinct silhouette per weapon — **not** color-only, **not**
   mere proportion. Achieved data-driven via a **full-transform parts array** on
   `WeaponDef`, so `drawPlayer` has zero per-weapon branches.
2. **Animation:** a dedicated `switchT` timer drives a lower→raise pose.
3. **Draw time:** per-weapon (`WeaponDef.drawTime`), not a single CONFIG constant —
   heavy guns are slower to ready, integrating with `moveMul` weight.
4. **Co-op:** `switchT` is synced exactly like `reloadT` (host-authoritative, f32).

## Principles

Stay inside the existing seams — no engine changes, no bespoke branches:

- Silhouettes use only existing render primitives (`rect/circle/ring/tri/hex`),
  composed from **data** on `WeaponDef`. `drawPlayer` iterates the parts; no
  `if (weapon === …)`. The knife also gets a `viz` (short blade), so the idle
  silhouette needs no melee branch — the `slash` crescent stays for the swing only.
- `switchT` rides the established net seam: it mirrors `reloadT` through the 5
  snapshot touch-points + the client fire-gate. Systems stay net-agnostic.
- All new look/timing values are **data** (`WeaponDef` fields). No new `CONFIG`
  special-case; `CONFIG.player.switchRaise` is **removed** (superseded by `drawTime`).
- **Feel-first:** nothing here is "done" until playtested in `bun run dev`. The
  constants below are starting points to tune in-game.

## 1. Data model — `WeaponDef` extensions

`game/types.ts` — add to `WeaponDef`:

```ts
/** held-weapon silhouette: primitives placed in gun-local space (x = forward along
 *  aim, y = lateral). drawPlayer applies the player transform + draw-anim pose and
 *  renders each part. No per-weapon branching. */
viz: GunPart[];
/** seconds to "draw" (lower→raise) after a switch; also the post-switch fire-lockout.
 *  Heavier guns are slower. Supersedes CONFIG.player.switchRaise. */
drawTime: number;
```

```ts
export interface GunPart {
  /** forward offset along aim, world units (+ = toward muzzle) */
  dx: number;
  /** lateral offset perpendicular to aim, world units (+ = one side; a mag hangs, a sight sits) */
  dy: number;
  /** rotation relative to aim, radians (0 = aligned with barrel) */
  rot: number;
  /** length along the part's own axis (world units) */
  len: number;
  /** width across (world units) */
  wid: number;
  /** SHAPE key; defaults to "rect". circle/hex for drums/cylinders, tri for a muzzle/sight */
  shape?: "rect" | "circle" | "ring" | "tri" | "hex";
  /** rgb; defaults to wd.color */
  color?: [number, number, number];
  /** 0..1; defaults to 1 */
  alpha?: number;
}
```

`game/data/weapons.ts` — give every weapon a `viz` + `drawTime`. Overall size is
just the extent of its parts (no global cap): heavy guns are physically larger.
Starting points (player r=16; **tune by feel**):

| weapon  | ≈ overall len | distinctive parts                               | drawTime |
|---------|---------------|-------------------------------------------------|----------|
| pistol  | ~r×1.0        | short receiver + stub barrel (stubby)           | 0.35     |
| smg     | ~r×1.3        | thin barrel + small mag                         | 0.40     |
| shotgun | ~r×1.5 (wide) | **thick** twin barrel + stock                   | 0.50     |
| rifle   | ~r×1.7        | long thin barrel + mag + small sight            | 0.45     |
| lmg     | ~r×2.2        | **longest** barrel + drum (circle, dy−) + stock | 0.70     |
| magnum  | ~r×1.1        | short but **very thick** barrel + cylinder(hex) | 0.55     |
| knife   | ~r×0.7        | short blade only                                | 0.30     |

Distinctiveness budget is honest about the ~6px on-screen size: silhouette outline
+ a color accent + one hanging element (mag/drum/cylinder). That ceiling is above
the screen's resolution ceiling, so the parts array is sufficient. (Escape hatch if
ever needed: a `draw?(R, ctx)` callback field — the same function-as-data pattern as
`upgrades.ts`/`pickups.ts` `apply()` — but **not** part of this scope.)

## 2. Silhouette rendering — `drawPlayer` (`game/game.ts`)

Replace the single generic rect at `game.ts:627` with a parts loop. The current line
is unconditional for all players; the replacement is too — every player draws
`effWeapon(pl, pl.weapon).viz`.

```
const wd = effWeapon(pl, pl.weapon);
const raise = pl.switchT > 0 ? 1 - pl.switchT / wd.drawTime : 1;   // 0 = just switched, 1 = ready
// draw-anim pose applied once to the whole rig (see §3), then:
for (const part of wd.viz) {
  // transform part's (dx,dy) by aim (+ pose), rot by aim (+ pose), pick shape, color ?? wd.color, alpha ?? 1
  R.<shape>(wx, wy, ..., partRot, cr, cg, cb, a);
}
```

The melee `slash`/`glow` swing block (`game.ts:630-646`) is unchanged — it draws on
`pl.muzzle` during a swing, on top of the knife's idle blade `viz`. The non-melee
muzzle glow (`game.ts:648-650`) stays.

## 3. Draw animation — `switchT` timer

`game/types.ts` — add `switchT: number` to `Player`.

`game/engine/players.ts` — init `switchT: 0` in `makePlayer` (next to `reloadT: 0`,
~line 38) and reset in `revivePlayer` (next to `p.reloadT = 0`, ~line 99).

`game/systems/player.ts` — in the switch block (`120-134`):
- set `p.switchT = wd.drawTime` for the **new** weapon (compute `effWeapon` for the
  new id, or read `WEAPONS[id].drawTime`),
- replace `p.fireCd = Math.max(p.fireCd, CONFIG.player.switchRaise)` with
  `p.fireCd = Math.max(p.fireCd, drawTime)` (lockout = draw time),
- decrement each frame alongside the existing timers: `if (p.switchT > 0) p.switchT -= dt;`
- update the `127-130` comment (no longer "becomes" — it now drives the anim).

`game/config.ts` — **remove** `switchRaise` from `CONFIG.player` and its `79-81`
comment (kept short: note `drawTime` lives per-weapon now).

**Pose** (in `drawPlayer`, applied to the whole rig before the parts loop): with
`raise` from §2,
- at `raise=0` (just switched): rig **pulled in** toward the body (forward offset
  scaled down, e.g. ×0.3), **rotated down** off aim (e.g. +0.6 rad), **dimmed**
  (alpha ×~0.6);
- at `raise=1` (ready): full forward offset, aligned to aim, full alpha.
- interpolate with an ease-out (and optionally a small overshoot) for juice; **tune
  in dev**. Larger guns naturally swing wider since the pose scales the whole rig.

This is purely cosmetic — the fire-lockout is the `fireCd` set above; `switchT`
never gates the sim except via the client fire-feel guard in §4.

## 4. Co-op sync — mirror `reloadT`

`switchT` is host-authoritative and host-decremented (it lives in `sysPlayer`, which
only the host runs). Clients receive it via snapshots, exactly like `reloadT`. There
is **no separate client prediction** of `switchT` — `reloadT` isn't predicted either
(the reload bar already updates at snapshot rate); weapon switching is itself
host-authoritative (`lp.weapon` arrives via snapshot), so `switchT` arriving with the
new weapon in the same snapshot is consistent. The own-player draw anim updates at
snapshot rate — the same accepted limitation as the reload bar and remote muzzle.

Touch-points (`game/net/snapshot.ts`), each next to the existing `reloadT` line:

1. `SnapshotPlayer.switchT: number` (interface, ~line 58)
2. capture: `switchT: p.switchT` (~line 167)
3. apply: `p.switchT = sp.switchT` (~line 310)
4. encode: `w.f32(p.switchT)` (~line 535)
5. decode: `const switchT = r.f32()` (~line 652) + include in the built object (~line 685)

`game/net/client.ts` — add `lp.switchT <= 0` to the local fire-feel gate
(`~line 434`, next to `lp.reloadT <= 0`), so the client doesn't predict a muzzle
flash during the draw window (the host's `fireCd` lockout would reject the shot).

## Out of scope

- New render primitives / shaders (SHAPE enum is unchanged — parts reuse existing shapes).
- A per-weapon `draw?()` callback (kept as a documented escape hatch only).
- Delta-compressing the (already full) snapshot.
- Any change to bullet/muzzle visuals beyond the held-weapon silhouette.

## Verification

1. `bun run typecheck` + `bun run test` (pure-function tests; `waveDef`/arsenal/math
   unaffected — expect green).
2. **`bun run dev`** — switch through every owned weapon and **look**: each reads as a
   distinct silhouette; the lower→raise draw plays; heavy guns visibly slower to ready;
   fire is locked until the gun is up. This is the done-bar (feel-first).
3. Co-op: connect two windows via manual-SDP, confirm a teammate's weapon switch shows
   the draw anim (not an instant pop) and no false muzzle flash mid-draw.
4. Single-player gameplay change is intentional (switchRaise 0.5 → per-weapon
   drawTime); confirm no *unintended* SP regression from the co-op plumbing.
