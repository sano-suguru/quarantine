# Deployable look + drone orbit — design

**Date:** 2026-06-29
**Scope:** Visual redesign of all three deployables (drone, sentry/turret, supply
station) plus an autonomous **orbit-on-watch** idle behaviour for the drone.

## Problem

The deployables don't read as what they are, and the drone feels inert:

- **Drone** (`game.ts:722-734`) — over-drawn but illegible. Three `tri()` "rotor
  blades" spin around the *same centre* with a `hex` + `ring` on top, so it reads as
  a rotating star-blob, not a quadcopter. Rotors only read as rotors when they sit at
  the ends of arms, offset from the body.
- **Sentry/turret** (`game.ts:743-751`) — too minimal: a circle base + ring + a single
  rod barrel. "A dot with a stick", no weight or machinery.
- **Supply station** (`game.ts:735-742`) — plain crate; fine but flat, and gives no
  read on when the next drop is coming.
- **Drone idle behaviour** (`deployables.ts:69-74`) — when it has no target it pins to a
  fixed angle *behind* the anchor (`anchor.aim + π + idOffset`). Zero "on watch" feel; it
  looks like luggage being dragged.

## Principles

Stay inside the existing seams — no engine changes, no bespoke branches:

- Visuals use only the current render primitives (`rect/circle/glow/ring/tri/hex`).
- Behaviour rides the existing `DeployableDef.movement` block and the host-only,
  `state.time`-driven sim (deterministic → co-op stays in sync, no new wire fields).
- All new tuning is data: one new field on the `movement` def. No new `CONFIG` special-case.
- **Feel-first:** none of this is "done" until playtested. The constants below are
  starting points to tune in-game.

## 1. Drone idle behaviour — autonomous orbit watch

Add `orbitSpeed: number` (rad/s) to `DeployableDef.movement` (type + the `drone` entry in
`data/deployables.ts`). Starting value: `~0.7` (≈ a lazy full circle every ~9 s).

Replace the no-target branch in `tickMovement` (`deployables.ts:69-74`):

- **Goal position** = a point on a circle of radius `hoverDist` around the anchor, at angle
  `phase(d.id) + state.time * orbitSpeed`, where `phase(d.id)` reuses the existing
  `(d.id * 1.618) % 2π` golden-angle offset so multiple drones spread around the ring
  instead of stacking. The existing move-toward-goal code (`deployables.ts:76-82`) is unchanged.
- **Facing (`d.aim`)** while idle = the orbit *tangent* (direction of travel) so the drone
  looks like it's patrolling, plus a small slow scan wobble (e.g. `+ sin(state.time*1.3)*0.25`).

**Engage→idle transition fix (REQUIRED — current code is broken for this).** `tickMovement`
(`deployables.ts:60`) resolves its target from `d.targetId`, but `tickWeapon`
(`deployables.ts:104-114`) **never nulls `d.targetId` when no zombie is in range** — it only
overwrites it with a new target. So when a zombie wanders out of weapon range but is still
alive, `d.targetId` stays set, `tickMovement` keeps resolving it, and the drone stands off and
chases it forever instead of returning to orbit. The "existing branch just takes over" claim
only holds once the target *dies*. Fix: in `tickWeapon`, when the resolved `target === null`,
clear `d.targetId = undefined`. One line, filling a gap in existing logic — not a new branch.
With that, `tickMovement` falls into the orbit branch the moment the last in-range zombie leaves.

**Engaging is otherwise unchanged:** the instant a zombie is within weapon range the existing
target branch (`deployables.ts:60-68`) takes over — the drone breaks orbit, stands off, and aims
at the target. So orbit is purely the "nothing to shoot" state.

**Dynamics to accept (not bugs, just honest about the model):**
- The "radius `hoverDist` circle" is exact only while the anchor is *still*. The orbit tangent
  speed is `orbitSpeed * hoverDist ≈ 0.7 * 46 ≈ 32 px/s`, far below the drone's `speed = 210`,
  so a stationary anchor is circled cleanly. While the player *runs*, the anchor outpaces the
  orbit and the circle collapses into a trailing arc — reads as "following", which is acceptable;
  the watchful orbit is most visible when the player holds position.
- The move deadzone (`if (dist < 4) return`, `deployables.ts:79`) is effectively inert during
  orbit because the goal point keeps moving ~32 px/s, so the drone micro-steps every frame
  rather than parking. That's fine (smooth circle, not jitter) — noted so it isn't mistaken for
  a regression.

## 2. Drone visual — quad / X silhouette

Rewrite the `visual === "drone"` block in `drawDeployables`. Body bob + ground shadow stay.
Read target: "small quadcopter on watch", oriented to `d.aim`.

- Ground shadow `circle` (no bob) + under-body `glow` scanner (dims while reloading) — keep.
- **Chassis:** a small central `hex` (core) + two `rect` arms crossing in an **X**, rotated to
  `d.aim`, so the four arm tips point out diagonally.
- **Rotors ×4:** at each arm tip — a `ring` (housing) + one fast-spinning `tri`
  (`rot = state.time * ~14`) for blade blur. Tips are `d.aim ± 45°/135°` at the arm length.
- **Camera eye:** a bright small `glow` at the front along `d.aim`; flares brighter while
  firing/engaging (reuse the reloading flag / target presence for intensity).
- HP bar via existing `drawDeployableHp` at the bobbed `y`.

Net: replaces the centre-stacked spinning tris with offset rotors → reads as a drone.

## 3. Sentry/turret visual — heavier sentry

Rewrite the turret `else` block. Read target: "anchored auto-cannon".

- Base `glow` (dims on reload) — keep.
- **Tripod legs:** three short `rect`s splayed radially from centre (static, fixed angles) →
  gives a footprint and machined base.
- **Base plate:** a dark `circle` (slightly larger than now) + `ring` accent — keep ring.
- **Rotating housing:** a `hex` that tracks `d.aim` (the turret head).
- **Twin barrels:** two parallel `rect`s along `d.aim`, offset perpendicular by a few px →
  reads as a gun, not a stick.
- **Muzzle:** a small `glow` at the barrel tips; flares on fire (cheap: brighten for a short
  window after a shot, or simply tie to not-reloading — tune in-game).

**Collider stays at `radius: 12` (visual-only change).** The footprint/legs/base are drawn
larger than the collider for weight, but the physical body and lane-blocking are unchanged. Keep
the drawn base from sprawling far past the collider so the "what blocks me" read doesn't drift
too far from the silhouette — heavier-looking, same hitbox, by intent.

## 4. Supply station visual — supply crate

Extend the `visual === "crate"` block (keep the brown `rect` + colour band + `ring` + pulse).

- **Corner bolts:** four small `rect`s at the crate corners.
- **Supply mark:** a small cross (two thin `rect`s) or ammo-band line on the top face.
- **Beacon:** a `glow` that pulses on a cadence, brightest near each drop. **Drive it from
  `state.time`, NOT a host-only countdown.** Host-only sim state is not in the snapshot
  (`id/defId/x/y/aim/hpFrac/reloading` only) and clients build deployables via `applySnapshot`,
  so a client never has it and the beacon would be dead/wrong on every non-host screen.
  Instead phase the pulse off `state.time` with the period taken from `def.emitter.interval`
  (e.g. `frac = (state.time % interval) / interval`, ramp brightness toward `frac→1`). This is
  exactly how the existing crate pulse (`Math.sin(state.time*… )`) already runs on both host and
  client. **The emitter drops on the same `state.time` grid** (`tickEmitter` schedules `emitAt`
  on `k*interval` boundaries — see §“emitter alignment” below), so the beacon ramp peaks exactly
  as a drop lands instead of being offset by an arbitrary `placementTime mod interval`. No new
  wire field, no new state.

### Emitter alignment (the beacon's counterpart)

The original emitter was a placement-relative countdown (`emitCd` from `interval`, first drop
immediate), so drops landed at `placementTime + k*interval` while the beacon ramps on absolute
`state.time % interval` — the two share a period but their phase is offset by `placementTime mod
interval`, which can be anti-phase (beacon brightest right *after* a drop). To make the beacon
honest, the emitter is moved onto the same absolute grid: `placeDeployable` schedules
`emitAt = (floor(state.time / interval) + 1) * interval` (the next boundary), and `tickEmitter`
drops when `state.time >= emitAt` then advances `emitAt += interval` (stays exactly on the grid,
no float drift). Trade-off: the first drop now lands at the next interval boundary (0–`interval`s
after placement) instead of immediately — accepted, since both host and client read the same
synced `state.time` so the cadence stays deterministic with no new wire field.

## Affected files

- `src/types.ts` — add `orbitSpeed` to `DeployableDef.movement`.
- `src/data/deployables.ts` — `orbitSpeed` on the `drone` def.
- `src/systems/deployables.ts` — orbit branch + tangent/scan facing in `tickMovement`, **and the
  `d.targetId = undefined` clear in `tickWeapon` when no target is in range** (the transition fix).
- `src/game.ts` — rewrite the three branches of `drawDeployables` (beacon driven by `state.time`).

No changes to: snapshot wire format, net layer, AI, bullets, collision, or `CONFIG`.

## Testing / validation

- `deployables.test.ts` is movement/placement logic — keep it green. Add two cheap deterministic
  assertions (no RNG in this path):
  - **Idle orbit bound:** with a still anchor and zero zombies, tick several frames and assert the
    drone settles to `len(d − anchor) <= hoverDist + 4` (the `+4` absorbs the deadzone / one
    step of overshoot). Assert the *upper bound* only — it converges over multiple ticks, not in
    one frame, so don't assert a tight band.
  - **Engage→idle release:** place a zombie in weapon range (drone targets it), then move/remove it
    out of range and tick — assert `d.targetId` is cleared and the drone heads back toward the
    orbit radius (regression guard for the transition fix).
  The look itself is **not** unit-tested.
- Real validation is **playtest**: spawn drone + sentry + station, confirm the drone reads as
  a quad and visibly circles on watch, the turret reads as a cannon, the station beacon ramps.
  Tune `orbitSpeed`, rotor speed, barrel offset, beacon ramp in-game.
