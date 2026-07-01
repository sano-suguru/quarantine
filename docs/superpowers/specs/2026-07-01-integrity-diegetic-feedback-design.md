# Integrity De-tell (Diegetic Feedback) — Design

**Date:** 2026-07-01
**Status:** Approved (design); implementation pending
**Spec ③ of the "diegetic feedback" initiative** (show, don't tell). Sibling specs: ① combat gore (merged, PR #30), ② HUD de-tell (merged, PR #31), ④ darkness & visibility (future).

## Principle (the dividing line)

Keep **control prompts** — text that tells the player *which key does what* (`[E] repair`, `[F]` flashlight). Push **state / fear / causality narration** — text, numbers, and UI meters that *describe* the world's state — off the HUD and into experiential channels (color, sound, camera, light). The reference "right way" already in this codebase: low-ammo = a `.low` color class (not text); dread = `#vignette` + heartbeat + red pulse (`CONFIG.horror.lowHp`); tension = `Audio.setTension(lurking count)`; the dart = a shadow streak; night-search rummage SFX that lures the horde; and (added in ②) flashlight battery = continuous cone dimming via the pure `flashlightIntensity` (`dimFloor`/`dimStart`, CONFIG-driven). The type established by ① and ② is **full migration to an existing experiential channel**, not softening a meter.

## Problem

The HUD-top **Integrity** block still *tells* the player their vitality in a meter plus a number:

- **`#hpbar`** (`game.ts:921-922`, `style.css:153-167`) — a 240px fill bar, width `= hp%`, color toxic→blood at `hpf < 0.3`.
- **`#hpnum`** (`game.ts:923`, `style.css:169-173`) — the exact integer readout, e.g. `"73 / 100"`.
- **`#hud.low`** decorations (`style.css:175-189`, `1300`) — at `hpf < lowHp` the number turns blood-red and the bar-wrap pulses (`@keyframes hppulse`).

This is the last numeric/meter state readout on the HUD. The existing dread channel (heartbeat + red `#dread-pulse`, gated at `CONFIG.horror.lowHp = 0.35`) already *shows* near-death — but only as a binary alarm below 35%. Between 35% and 100% the **bar is the only feedback**, so removing it naively would leave that whole range silent (100% and 36% would look identical), which is unfair: the player could not feel accumulating damage until the cliff at 35%.

## Goal

Remove the Integrity bar and number, and replace the bar's *informational role* (continuous "how hurt am I") with a felt, continuous channel — **world desaturation + dimming driven by HP** — while the existing heartbeat + red dread-pulse stay the unmistakable near-death alarm. Near-death must read clearly (avoid unfairness); full health must read clean (the day explore phase stays legible).

This rides **existing mechanisms** — the established "full-screen overlay / CSS layer driven per frame in `updateHUD` from the local view" pattern (`#vignette`, `#dread-pulse`, `#flash`), and a pure CONFIG-driven function modeled exactly on ②'s `flashlightIntensity`. No new bespoke code path (CLAUDE.md: extend the mechanism, zero special-case debt). New tuning lives in `CONFIG.horror`.

## Non-goals (explicit scope fence)

- **The heartbeat + red `#dread-pulse` near-death alarm is unchanged.** Its mechanism, the `CONFIG.horror.lowHp = 0.35` gate, and the `audioAmbience` heartbeat scaling (`game.ts:165-176`) all stay byte-identical. It simply stops being the *only* HP feedback above 35%.
- **`#vignette` stays static and untouched.** The new world-dimming is folded into the canvas `filter` (one channel, one place), not into `#vignette` (whose `transition: box-shadow 0.4s` would smear a per-frame write).
- **`#ammo.low`** (`style.css:247-251`) is the low-ammo color class on a different element — **untouched**.
- **The renderer and shaders are untouched.** Desaturation is a CSS `filter` on the `#game` canvas (a presentation layer), not a shader uniform. The sim and the rendered pixels are unchanged.
- **The "Flashlight [F]" control prompt and the rest of the HUD-top block stay.** Only the Integrity label + bar + number leave; the shared `hud-block` also holds the flashlight sub-block, so the block element itself remains.
- **No change to AI, sim, spawns, HP values, or the day/night clock.** Every edit is HUD/render-only. Single-player stays byte-for-byte; no net code is touched.

## Design

Two channels, split by role (mirroring the codebase's existing dread-vs-tension role split):

| Channel | Role | Band | Mechanism |
|---|---|---|---|
| **World desaturation + dimming** (new) | continuous "wound accumulation" readout (replaces the bar's *informational* role) | `hpf < desatOnset` (~0.65) → grades to death | CSS `filter` on `#game` canvas, set each `updateHUD` from **`cameraTarget`** (see co-op section) |
| **Heartbeat + red `#dread-pulse`** (existing, unchanged) | near-death alarm (unmistakable) | `hpf < lowHp` (0.35) → max at death | existing `audioAmbience` / `#dread-pulse` |

Above `desatOnset` the world is full color and `filter` is cleared (`""`) — the day explore phase stays legible and no compositing pass is added at high HP. As HP drains below `desatOnset`, saturation eases toward `desatFloor` (kept > 0 so blood and toxic-green still read) and brightness eases down by `desatDim`, the world visibly draining as the player is worn down. In the deep band the heartbeat and red pulse layer on top, escalating to death.

### ① New pure function — `integrityGrade`

New file `game/systems/integrity.ts`, modeled on `flashlightIntensity` (primitives in, deterministic, clamped, unit-tested):

```ts
/**
 * Pure HP→world-desaturation grade. Full color (0) at or above `onset` (the calm zone that
 * keeps the day explore phase legible); rises to 1 as HP drains to 0. `gamma` shapes the
 * curve: 1 = linear, < 1 front-loads sensitivity so mid-HP damage is felt (not numb) rather
 * than the whole ramp bunching near death. The caller maps the grade onto a CSS
 * `saturate`/`brightness` filter; the heartbeat + red dread-pulse remain the near-death alarm.
 */
export function integrityGrade(hpFrac: number, onset: number, gamma: number): number {
  if (hpFrac >= onset) return 0;
  if (hpFrac <= 0) return 1;
  return ((onset - hpFrac) / onset) ** gamma;
}
```

The `gamma` parameter (vs `flashlightIntensity`'s plain linear) is deliberate: removing the bar makes the mid-HP range the *only* range without a separate alarm, so the curve must be tunable in CONFIG without editing the function — a linear `(onset - hpf)/onset` leaves saturation ~18% / brightness ~4% off at HP 50%, near-imperceptible, which would just move the "cliff" from 35% up to ~50%. `gamma < 1` front-loads the ramp so accumulating damage reads earlier.

### ② CONFIG additions (`CONFIG.horror`)

```ts
// HP→world desaturation: the continuous "wound" readout that replaces the Integrity bar.
// Full color at/above desatOnset (calm zone, day readability); saturation eases to
// desatFloor and brightness drops by desatDim as HP drains to 0. The heartbeat + red
// dread-pulse (gated at lowHp above) stay the separate near-death alarm.
desatOnset: 0.65, // hp fraction at/above which the world is full color
desatFloor: 0.2,  // saturate() multiplier at death (>0 so blood/toxic still read)
desatDim: 0.18,   // brightness() reduction at death (1 → 1 - desatDim)
desatGamma: 0.7,  // curve shaping: <1 front-loads sensitivity (mid-HP felt); 1 = linear
```

All four are playtest starting points (feel-first); the curve and floors are tuned in-game.

### ③ `updateHUD` — replace the bar/number writes (`game.ts:921-923`)

The desaturation tracks the **player the camera follows** (`cameraTarget`, imported from `./engine/players`), not the local player — so a downed spectator sees the living teammate's view at that teammate's vitality, not a corpse's locked-max drain (see co-op section). In single-player and while alive, `cameraTarget === localPlayer`, so the value is identical.

```ts
const cam = cameraTarget(state);
const chpf = Math.max(0, cam.hp) / cam.maxHp;
const g = integrityGrade(chpf, CONFIG.horror.desatOnset, CONFIG.horror.desatGamma);
const filter = g > 0
  ? `saturate(${1 - g * (1 - CONFIG.horror.desatFloor)}) brightness(${1 - g * CONFIG.horror.desatDim})`
  : ""; // calm zone → no filter (no extra compositing pass)
// write only on change: HP is stable most frames, so this avoids a per-frame style-recalc
// and stops the composite layer thrashing as `filter` toggles on/off at the onset boundary.
if (filter !== lastFilter) {
  gameCanvas.style.filter = filter;
  lastFilter = filter;
}
```

`gameCanvas` is the `#game` element cached once at module scope (already obtained in `main.ts:132`); `lastFilter` is a module-scope string (init `""`). The local-player `hpf` at `game.ts:920` stays as-is (it still feeds the unchanged dread block below); the `el("hpbar")` / `el("hpnum")` writes are deleted.

### ④ Dead-code cleanup

The `#hud.low` CSS class was used **only** for the bar/number decorations (the red `#dread-pulse` is gated by the JS `low` boolean in `updateHUD`, not the CSS class). After removal:

- Delete `hud.classList.toggle("low", low)` (`game.ts:986`). Keep the `low` boolean (`game.ts:985`) — it still gates the `#dread-pulse` opacity (`game.ts:989`).

### ⑤ Removals (grep-confirmed)

- **`index.html:21-23`** — the `Integrity` `stat-label`, `#hpbar-wrap` (with child `#hpbar`), and `#hpnum`. The enclosing `hud-block` and the `#battery` / `Flashlight [F]` sub-block stay.
- **`style.css:153-189`** — `#hpbar-wrap`, `#hpbar`, `#hpnum`, `#hud.low #hpnum`, `#hud.low #hpbar-wrap`, and `@keyframes hppulse`.
- **`style.css:1300`** — the `#hud.low #hpbar-wrap` entry in the `prefers-reduced-motion` block (delete that selector from the rule).

### ⑥ CSS — smooth the filter (`style.css`, `#game`)

Add a short transition so a sudden HP change (medkit, dawn `revivePlayer` → full HP, or a switch of `cameraTarget` when a spectator's target changes) eases the color back rather than popping:

```css
#game { transition: filter 0.25s ease-out; }
```

Trade-off to settle in playtest: too long and the desaturation lags behind taking damage, dulling the hit causality (the instant `#flash` red still fires regardless); too short and recovery pops. `0.25s` is a starting point. (`prefers-reduced-motion` need not disable this — it animates a color filter, not motion — but it can be added to that media block if it reads as distracting.)

## co-op / single-player invariance

The `filter` is computed from `cameraTarget(state).hp` (HP is already synced per-player in snapshots) in `updateHUD`, which runs on host, client, and single-player alike — a purely local presentation layer. The sim and renderer pixel generation are unchanged, so **single-player stays byte-for-byte** and **no net code is touched**.

**Why `cameraTarget`, not `localPlayer`:** the camera follows `cameraTarget(state)` (`players.ts:79-83`) — yourself while alive, else the nearest living teammate so a downed player spectates the fight. If the filter read `localPlayer().hp`, a downed spectator would have `hpf = 0` → `integrityGrade = 1` → **max desaturation locked on** while watching a *healthy* teammate fight — the view drained for a body that isn't on screen. Reading `cameraTarget.hp` keeps the screen's color matched to the player actually shown. Single-player and any living player have `cameraTarget === localPlayer`, so the result is identical and SP stays byte-for-byte. The unchanged dread block (heartbeat + `#dread-pulse`) keeps reading the local player's `hpf` — out of scope for ③, and a downed player's own heartbeat reads as death ambience.

The transition (⑥) animates only the color filter, so `prefers-reduced-motion` is unaffected; removing `@keyframes hppulse` also tidies that media block.

## Testing

- **Unit test** (`game/systems/integrity.test.ts`, Vitest, co-located): `integrityGrade` returns 0 at and above `onset`, 1 at `hpFrac = 0`, is monotonic decreasing in `hpFrac` across the band, clamps for out-of-range input, and — with `gamma < 1` — sits above the linear value mid-band (front-loading holds). Add `integrityGrade` to the tested-helpers list in `CLAUDE.md`.
- **Feel verification** (mandatory, `bun run dev`): not done until played and felt — per feel-first, compile/test passing ≠ complete. Confirm:
  - Near-death is unmistakable; **mid-HP damage is felt** (not numb) — the central reason for `desatGamma`. Tune `desatGamma` / `desatOnset` / `desatFloor` / `desatDim` in `CONFIG.horror`.
  - Full HP reads clean. Note: a wounded player carries desaturation **into the day** (the wound readout is continuous across the day/night boundary, by design) — "full health reads clean," not "the day is always clean."
  - **Recovery pop**: medkit / dawn revive eases color back smoothly via the `transition` (⑥), without lagging the hit-time desaturation. Tune the duration.
  - **Near-death red saturation**: drained-dark world + `#dread-pulse` red + `#flash` red don't wash out readability.
  - **HUD top-left layout**: after removing the bar/number, the block isn't awkwardly cramped (adjust `#battery` margin if needed).
  - **Co-op spectate**: when downed, the spectated teammate's view desaturates by *their* HP (not locked to max), and recovers on dawn revive.

## Out of scope (future, Spec ④)

Zombie glow halo / eyes (`R.glow` / `R.add`) and darkness/visibility tuning. This spec does not change zombie rendering or the flashlight cone.
