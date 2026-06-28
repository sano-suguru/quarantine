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

**Engaging is unchanged:** the instant a zombie is within weapon range the existing target
branch (`deployables.ts:60-68`) takes over — the drone breaks orbit, stands off, and aims at
the target. So orbit is purely the "nothing to shoot" state.

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

## 4. Supply station visual — supply crate

Extend the `visual === "crate"` block (keep the brown `rect` + colour band + `ring` + pulse).

- **Corner bolts:** four small `rect`s at the crate corners.
- **Supply mark:** a small cross (two thin `rect`s) or ammo-band line on the top face.
- **Beacon:** a `glow` that ramps brighter as the next drop nears and flashes on emit. Drive
  it from the existing emitter cadence — `d.emitCd` vs `def.emitter.interval` gives a 0..1
  "time to next drop" with no new state (purely visual, read on the render side).

## Affected files

- `src/types.ts` — add `orbitSpeed` to `DeployableDef.movement`.
- `src/data/deployables.ts` — `orbitSpeed` on the `drone` def.
- `src/systems/deployables.ts` — orbit branch + tangent/scan facing in `tickMovement`.
- `src/game.ts` — rewrite the three branches of `drawDeployables`.

No changes to: snapshot wire format, net layer, AI, bullets, collision, or `CONFIG`.

## Testing / validation

- `deployables.test.ts` is movement/placement logic — keep it green; the orbit change is in
  the idle branch, so add/adjust a deterministic assertion only if it's cheap (e.g. an idle
  drone stays within ~`hoverDist` of its anchor). The look itself is **not** unit-tested.
- Real validation is **playtest**: spawn drone + sentry + station, confirm the drone reads as
  a quad and visibly circles on watch, the turret reads as a cannon, the station beacon ramps.
  Tune `orbitSpeed`, rotor speed, barrel offset, beacon ramp in-game.
