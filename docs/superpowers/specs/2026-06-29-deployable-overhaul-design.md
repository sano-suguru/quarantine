# Deployable Overhaul — Power Scaling, Limited-Duration Drone & Directional Lights

*Date: 2026-06-29 · Status: design (pending implementation plan)*

## 1. Context & Problem

Deployables (`Hunter Drone`, `Auto-Sentry`) are bought with run credits and placed at the
base; they benefit the whole squad and are removed only when their HP reaches 0. Two problems:

1. **Underpowered.** Both fire at ~20 burst DPS (drone `dmg 10 / 0.5s`, sentry `dmg 14 / 0.7s`),
   vs player weapons at ~87–290 DPS. Deployables do ~1/5–1/10 of a player's output.
2. **They fall off late-game (compounding).** Deployable stats are fixed, while:
   - Enemy HP scales `hpScale = 1 + n*0.1` per night `n` (`src/data/waves.ts`).
   - Player damage compounds: weapon level (`+15%/Lv`, max 3) × `dmgMul` (×1.25 per perk,
     multiplicative) × `fireRateMul` (×1.3). Confirmed `wave.n === state.day` at night
     (`siege.ts:67` calls `startWave(state, state.day)`), so enemies use `waveDef(state.day)`.

   A fixed-stat deployable is irrelevant by ~night 8–10.

The user's framing (from SAS3): powerful support that is *temporary*, rather than weak-but-permanent.

## 2. Goals / Non-goals

**Goals**
- Make deployables feel impactful early and stay *relevant* (never trivialized, never useless) all run.
- Give the two deployables distinct roles: a **spike** (drone) and a **steady backbone** (sentry).
- Add atmospheric, useful **directional lights** to deployables that fit the horror lighting model.
- Stay data-driven; reuse existing system seams; keep single-player byte-identical and co-op safe.

**Non-goals**
- No host migration / economy redesign. No new deployable *types*. No per-deployable shop upgrade
  tree (considered and rejected: new UI + co-op ownership ambiguity for marginal benefit).
- Not trying to make deployables *match* an invested player late-game — the player stays the hero.

## 3. Design

### A. Night-curve damage scaling (both deployables)

Scale fired damage by the **same factor currently applied to enemy HP**, so a deployable's
shots-to-kill ratio against the zombies it faces is **preserved across the whole run** (±1 from
`ceil` rounding) — it neither falls off nor trivializes.

**Phase-correct basis (corrected after review).** Enemy `hpScale` is *not* simply `1 + state.day*0.1`
in every phase: at night, `siege.ts:67` calls `startWave(state, state.day)` so the horde uses
`waveDef(state.day).hpScale = 1 + state.day*0.1`; during the **day**, `startDay` seeds roamers at
`hpScale = 1` (base HP). And `state.day` is incremented at dawn (`game.ts:1144`, `shopDeploy`), so
during a day phase `state.day` already holds the *upcoming* night's number. Therefore deployable
damage must be gated by phase, not by raw `state.day`:

```
scale  = state.phase === "night" ? (1 + state.day * CONFIG.deployables.dmgScalePerNight) : 1
effDmg = w.dmg * scale                                          // dmgScalePerNight = 0.1
```

- This keeps the shots-to-kill ratio matched in **both** phases (night vs scaled horde, day vs
  base-HP roamers). Without the gate, a drone that survives into the day (§B persistence) would hit
  `hpScale=1` roamers with `(1 + day*0.1)×` damage — overkill — and even day 1 (pre-first-night)
  would over-scale at 1.1×.
- Applied at the single shot-damage site in `tickWeapon` (`src/systems/deployables.ts`). No
  per-type branching; the curve is uniform across deployable types, base values set the power tier.
- The ratio is exact in the multiplier (same factor on `dmg` and `hp` across walker/runner/brute);
  `ceil` rounding can shift the count by ±1 at boundaries. `knockback`/`pierce` are unaffected
  (deployables use `pierce 0`; knockback is dmg-independent, as today).
- Player `dmgMul` compounds faster than this linear curve, so late-game the player outscales the
  horde *relative to* deployables — the intended "hero = player, deployables = steady support".

### B. Hunter Drone — strong spike, limited by an ammo budget

- **Power (night 1, strawman):** `dmg 26 / interval 0.2` → active ~130 DPS; `magSize 24 /
  reloadTime 1.3` → sustained ~100 DPS. Clearly above a single player weapon. Scales per §A.
- **Limit = finite ammo budget (NOT a wall-clock timer).** The drone holds a finite **reserve**
  (strawman `ammoBudget = 90` rounds). Reloads draw from the reserve. When **reserve and magazine
  are both empty**, the drone retires (RTB) and is removed.
  - **No time limit, no dawn cutoff.** Idle time does not drain value; the player always gets
    "what they actually fired". A drone with rounds left persists across dawn (shoots day roamers,
    carries into the next night). Bounded by total ammo + `cap`, so it can't run away.
  - Rationale: a wall-clock timer (the rejected `15s`) felt too short relative to a 55–150s night
    and punished quiet stretches; an ammo budget ties value to engagement and reads as SAS3-style.
- **Cost of power:** finite ammo + fragility (60 HP, dives into the horde) + credits (~150) + `cap 2`.

### C. Auto-Sentry — permanent steady backbone

- **Power (night 1, strawman):** `dmg 22 / interval 0.4` → active ~55 DPS, sustained ~42 DPS
  (~2× current). Scales per §A. Stays below the drone's burst and below the player.
- **Permanent. No lifespan, no finite ammo** — keeps the self-recharging magazine (fires forever
  with reload gaps). Its cost is being **stationary + destructible + capped + credits**: a fixed
  emplacement that gets swarmed and destroyed on a breach.
- HP / `collider` (lane-blocking body) unchanged.

### D. Finite-reserve mechanic & sync

- **Data:** add `ammoBudget?: number` to `DeployableDef.weapon` (drone `90`; sentry omits → infinite).
- **Sim (host) — exact reload/retire state machine.** Instance gains host-only `reserveLeft?: number`,
  initialised to `ammoBudget` at placement. The current reload completes with `d.ammoLeft = magSize`
  (`deployables.ts:133-139`); change the *reload-complete* branch to **partial refill from reserve**:
  `refill = min(magSize, reserveLeft); d.ammoLeft = refill; reserveLeft -= refill`. Retirement is a
  **new condition** evaluated when a reload would start (mag just emptied) **and** `reserveLeft <= 0`,
  or equivalently when `reserveLeft <= 0 && ammoLeft <= 0`: push to the existing `dead[]` swap-pop
  path (same removal as `hp <= 0`, but a *different trigger* — this is a deliberate extension of the
  weapon tick, not a one-off branch). Infinite-reserve types (no `ammoBudget`) keep the current
  full-refill behavior untouched.
- **Sync — wire-format change (NOT backward compatible).** Add `ammoFrac` (`reserveLeft/ammoBudget`,
  `1` for infinite-reserve types; 1 byte quantized) to the deployable snapshot struct. This **changes
  the wire format**, so it requires:
  - **`PROTOCOL_VERSION` 8 → 9** (`net.ts:19`) — old/new clients are incompatible by design.
  - **Regenerate two golden tests** in `snapshot.test.ts`: the byte-layout golden (`len=281
    fnv=1f81b5f2`, line ~118) **and** the deployable-specific pin (line ~225, which the layout golden
    can't catch since it encodes zero deployables).
  - Size impact is safe: +1 byte/deployable, ≤ ~8 deployables, far under the ~16KB snapshot bound.
  - Clients render only (no sim); mirrors the existing `hpFrac`/`reloading` synced display pattern.
- **Client RTB vs destroyed (re-derived, no new sync).** Both removal paths drop the id from the
  snapshot, so a raw disappearance is ambiguous. The client distinguishes them the same way it
  already re-derives hit/kill fx from snapshot diffs: a drone whose **`ammoFrac` reached ~0** before
  vanishing → spawn a **power-down / fly-off** cue; one whose **`hpFrac` reached ~0** → the existing
  destruction fx. No extra synced field needed.
- **Render:** repurpose the drone's under-body scanner glow into a **remaining-ammo ring**; blink
  when low (“about to RTB”). Per memory `extend-mechanism-over-fake-with-primitives`, use the `ring`
  primitive rather than stacking glows.

### E. Directional deployable lights

Deployables cast an aimed light cone in their facing direction, fitting the near-black night
(`nightAmbient 0.04`) where the flashlight cone is the core horror mechanic.

- **Engine reality (verified):** the lighting model supports `MAX_LIGHTS = 4` aimed cones, one per
  player, mirrored in `grid.frag` + `instance.frag`. The shader loop early-breaks at
  `u_lightCount`, so cost scales with *active* lights, not `MAX_LIGHTS`. Cone **shape**
  (`u_cone` = cos halfAngle, range, ambient floor) is **shared**; **intensity** (`u_lightInt[]`) is
  **per-light**.
- **Change:** raise `MAX_LIGHTS` (strawman `8`) in both shaders + the renderer's light arrays.
  Add deployable cones via the existing `addLight()` path.
- **Performance model (the governing constraint).** The shader loop runs **once per active light,
  per fragment**, on *both* the full-screen `grid.frag` (every screen pixel) **and** every instance
  fragment. So cost ≈ `activeLights × (screenPixels + instanceFragments)`. An **off-screen** light
  contributes zero visible illumination but still costs every on-screen pixel. Therefore active
  lights must be bounded by *what actually lights the visible frame*, not by how many deployables
  exist in the world. (Today there is **no** light culling — `game.ts` just adds one cone per living
  player; harmless at ≤4 players, but it must be added with this feature.)
- **Light selection — two stages (required):**
  1. **Viewport cull first.** A light affects the frame only if its lit region intersects the view
     rect. The lit region ≈ a disc of radius `range` (cone reach; the personal pool is smaller and
     subsumed) around the light origin. Keep a light iff `circle(origin, range)` intersects the
     world-space view rect (+ small hysteresis margin to avoid edge popping). This is a cheap
     circle-vs-AABB test per light and correctly **keeps an off-screen deployable whose cone reaches
     into view**, while dropping fully off-screen lights (including distant co-op teammates) so they
     cost nothing.
  2. **Budget cap with priority.** If the surviving (frame-relevant) set still exceeds `MAX_LIGHTS`,
     keep by priority: player cones first, then **nearest-to-camera** deployables; drop the rest.
- **Net effect:** worst-case per-fragment light cost is bounded by `MAX_LIGHTS` (strawman 8)
  *regardless of world deployable count*, and is typically lower (early-break + viewport cull).
  Single-player near the base = 1 player + up to 5 deployables = 6 ≤ 8 (no cull needed on-screen);
  4-player co-op fills player cones + nearest visible deployables to the cap.
- **Why lights and not geometry/sim.** Off-screen culling is only worth it where cost is
  *per-pixel / multiplicative*. Lights are exactly that. By contrast, drawn geometry is **not**
  viewport-culled today (`renderer.ts write()` pushes every instance up to `CONFIG.maxInstances`
  = 40000), and that is correct: an off-screen instance costs ~O(1) (a 6-vertex transform, clipped
  before rasterization → zero fragment cost), and live counts are bounded (zombie night cap 45–90,
  particles ≤ 2400) far below the buffer cap, so per-entity CPU culling would cost more than it
  saves. Simulation likewise updates all entities regardless of screen (off-screen zombies must keep
  advancing on the player) and is bounded by the night cap. **This feature adds viewport culling for
  lights only**; geometry/sim are intentionally left as-is.
- **Dread guard (review raised this risk to HIGH).** `u_cone` (halfAngle, range, ambient floor) is a
  **single shared uniform** (`renderer.ts`), so intensity is the only per-light dial today. Lowering
  only `u_lightInt` makes a deployable cone *dimmer* but it still **lights the same area** (same wide
  angle, same range) as the player's flashlight — in a near-black scene that coverage is what erodes
  dread, more than brightness. So **per-light cone shape (shorter + narrower) is likely required, not
  optional**: add per-light cone params (e.g. `vec2 u_lightCone[MAX_LIGHTS]` = range-scale +
  cos-halfAngle) so deployable cones are physically smaller pools of light. Treat intensity-only as a
  quick first look, but expect the per-light-shape change to land. Final call is a dread playtest.
- **Behavior:** cones follow the already-synced `d.aim` — **Sentry** = a searchlight that tracks its
  target along the guarded lane; **Drone** = a flying searchlight along its aim/travel. Optionally
  dim the cone further while reloading (mirrors the existing glow-dims-on-reload cue).
- **Networking:** visual only, derived from synced `aim` + position. No new sync; single-player
  unchanged; co-op safe (same treatment as the player flashlight).

## 4. Data / Config changes (concrete)

- `src/config.ts`: add `CONFIG.deployables.dmgScalePerNight = 0.1`; light tuning
  (`deployLightIntensity`, optional `deployLightRangeMul` / `deployLightHalfAngle`).
- `src/types.ts`: `DeployableDef.weapon.ammoBudget?: number`; `Deployable.reserveLeft?: number`;
  snapshot struct gains `ammoFrac`.
- `src/data/deployables.ts`: drone → `dmg 26 / interval 0.2 / magSize 24 / reloadTime 1.3 /
  ammoBudget 90 / cost 150 / cap 2`; sentry → `dmg 22 / interval 0.4` (other fields unchanged).
- `src/systems/deployables.ts`: §A damage scale; §D reserve draw + retirement; (light emission may
  live in the draw/light pass, see §E).
- `src/net/snapshot.ts`: encode/decode + capture/apply `ammoFrac`. **`src/net/net.ts`: bump
  `PROTOCOL_VERSION` 8→9.** Regenerate the two `snapshot.test.ts` goldens (byte-layout + deployable pin).
- `src/game.ts`: ammo ring render; deployable light emission into `addLight()`.
- `src/engine/renderer.ts` + `shaders/{grid,instance}.frag`: raise `MAX_LIGHTS`; (optional per-light
  cone params for the dread refinement).

## 5. Networking & single-player safety

- All new sim state (`reserveLeft`) is host-only; clients render from `ammoFrac` + existing synced
  fields. Lights are visual-only and derived. No system imports net code. Single-player path is
  byte-identical (no co-op code touched); the snapshot change is additive.

## 6. Balance strawman & tuning knobs

All numbers above are **playtest starting points**, not final. Primary knobs: `dmgScalePerNight`
(relevance curve), drone `dmg`/`interval`/`ammoBudget`/`cost` (spike strength & value-per-buy),
sentry `dmg`/`interval` (backbone strength), `MAX_LIGHTS` + deploy light intensity/range (perf vs
dread). The requirement is the *ratios* (drone > 1 player weapon; sentry ≈ 2× current; deployable
cones dimmer/shorter than the player's), tuned by feel.

## 7. Testing & verification

- **Pure unit tests (Vitest):** the damage-scaling helper (e.g. `deployScaledDmg(base, day)`) and
  the reserve-drain/retirement predicate — in the spirit of the existing `scaledDmg`/`waveDef` tests.
- **Playtest (feel-first; required, not optional):**
  - Drone reads as a strong spike; ammo ring legible; RTB-on-empty feels fair, not abrupt.
  - Sentry stays a meaningful wall of fire at night ~1, ~8, ~15 (relevance curve holds).
  - Deployable searchlights add atmosphere **without** killing the dark/dread; verify at full
    deployable count.
  - **Perf check** with `MAX_LIGHTS` cones simultaneously on-screen (grid + instances) at target
    resolution; confirm no frame-time regression. Also verify the **viewport cull works**: with many
    deployables placed but most off-screen, the active-light count (and frame time) stays bounded —
    panning the camera should not scale cost with total world deployables. If on-screen worst case
    regresses, lower `MAX_LIGHTS` and/or cap deployable cones below the player budget.

## 8. Risks & open questions

- **Dread erosion** from too many/too-bright cones → mitigated by dim + (refinement) short/narrow
  cones + culling; final call is a playtest.
- **Perf** of the per-fragment light loop → bounded by `MAX_LIGHTS` via the §E viewport cull +
  budget cap (off-screen lights cost nothing); measure the on-screen worst case; early-break helps.
- **Light culling stability** (cones popping at the screen edge as the camera moves / deployables
  die) → viewport test uses a hysteresis margin and a stable nearest-to-camera order; accept minor
  pop on dim supplementary cones, revisit if distracting.
- **Drone lingering / "temporary" in name only.** With no time limit, a drone kept out of combat
  drains its budget slowly and can persist across multiple nights (×2 via `cap`). In practice a
  night always has targets, so ~90 rounds deplete within ~1–2 nights; but the edge case exists. We
  keep no timer (the user explicitly rejected dawn-removal — value must not be confiscated). **Watch
  in playtest:** if drones routinely camp idle across nights, reconsider (e.g. a generous idle-only
  RTB), not a hard duration.
- Open: does the drone persisting into the day feel good or odd? (Leaning: fine — §A now gates day
  damage to 1.0 so it's not an overkill roamer-sweeper.) Revisit in playtest.

## 8a. Scope decision (recorded)

An independent review (and the initial recommendation) suggested splitting the lighting work (§E)
from the balance/lifespan/scaling work (§A–D), since they have different verification profiles
(unit tests + balance playtest vs. shader/perf + dread playtest) and bundling risks §E's open
questions delaying §A–D. **Decision: keep it integrated — one spec, one implementation unit** — with
that delivery risk consciously accepted. If §E's dread/perf validation stalls during implementation,
revisit splitting then.

## 9. Out of scope / future

Per-deployable shop upgrade levels; new deployable types; host migration; light shadows/occlusion.
