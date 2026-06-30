# HUD De-tell (Diegetic Feedback) — Design

**Date:** 2026-07-01
**Status:** Approved (design); implementation pending
**Spec ② of the "diegetic feedback" initiative** (show, don't tell). Sibling specs: ① combat gore (merged, PR #30), ③ player vitality (Integrity), ④ darkness & visibility.

## Principle (the dividing line)

Keep **control prompts** — text that tells the player *which key does what* (`[E] repair`, `[F]` flashlight). Push **state / fear / causality narration** — text, numbers, and UI meters that *describe* the world's state — off the HUD and into experiential channels (color, sound, camera, light). The reference "right way" already in this codebase: low-ammo = a `.low` color class (not text); dread = `#vignette` + heartbeat + red pulse; tension = `Audio.setTension(lurking count)`; the dart = a shadow streak; night-search rummage SFX that lures the horde.

## Problem

Three HUD readouts still *tell* the player state in text or a meter instead of letting the existing channels *show* it:

1. **Remaining-zombie count** (`game.ts:985` `el("remaining")` → `index.html:43` `#wavetag` "— hostiles: N —"). A live integer of how many enemies exist.
2. **Night-search causal annotation** (`game.ts:1467-1469`). The interact prompt appends a spoiler — `"stand still to search — risky! (draws the horde)"` — that *explains* a cause→effect the game already enacts.
3. **Flashlight battery readout** (`game.ts:941-949` + `index.html:24-27`). Both a text state (`OFF` / `DEAD` / `N%`) *and* a fill bar — a worded state plus a UI meter for a resource the cone's own behavior can show.

## Goal

Remove all three readouts and let already-built experiential channels carry the signal. Two are pure deletions; the battery one removes a meter and compensates with a small experiential cue (continuous cone dimming) so the resource stays readable without a bar.

This rides **existing mechanisms** (audio tension/groan, the clock-dial, rummage SFX + the AI lure, the flashlight cone) — no new bespoke code path (CLAUDE.md: extend the mechanism, zero special-case debt). New tuning lives in `CONFIG.flashlight`.

## Non-goals (explicit scope fence)

- **HP bar + "100/100" (Integrity) is untouched.** That is Spec ③'s territory. The HUD-top `#hpbar`/`#hpnum` block stays as-is.
- **Zombie glow halo / eyes (`R.glow` / `R.add`) are untouched.** That is Spec ④. This spec does not change zombie rendering or visibility.
- **The "Flashlight [F]" label stays.** It is a control prompt (which key toggles the light), not a state readout. Only the state span (`#bat-state`) and the fill bar (`#batbar`) leave.
- **The cache search-progress arc (`game.ts:904-906`) is untouched.** It is a diegetic over-the-cache indicator, not a HUD text/meter, and out of scope here.
- **No change to AI, sim, spawns, or the day/night clock.** Every edit is HUD/render-only. Single-player stays byte-for-byte; no net code is touched.

## Design

Three independent edits. ①② are deletions; ③ is a deletion plus one pure-function extension.

### ① Remaining-zombie count — full removal

- Delete `#wavetag` (and its child `#remaining` span) from `index.html:43`.
- Delete the `#wavetag` rule from `style.css:304`.
- Delete the `el("remaining")` write at `game.ts:985`.

**Why this loses nothing.** Verified in code: night ends **on the clock, not on a wipeout** (`siege.ts:74-87` — `state.phaseT -= dt`, returns `"dawn"` at `phaseT <= 0`; `sysWave(...)` keeps spawning, capped, until dawn). So the count never signaled night-progress — the **clock-dial** does that. The count only ever conveyed *current threat density*, which is already carried by `Audio.setTension(state.lurking / surrounded)` (`game.ts:163`) + groan density, and the dart cue keyed on `state.lurking` (`game.ts:337`). A coarse on-screen threat meter was rejected: it would add a new abstract UI meter — exactly what the principle says to avoid — and reads worse than the number it replaces.

**Crash safety.** `el()` (`ui.ts`) throws if the element is missing, so a half-removal would crash immediately. The three references above are the *only* references (`remaining` / `wavetag` grep is otherwise clean); removing all three together is consistent.

### ② Night-search causal annotation — remove the causal clause, unify day/night

- Collapse the ternary at `game.ts:1467-1469` to a single `"stand still to search"` for both phases.

**Why this is safe.** The control hint (`stand still to search`) stays. The causality the clause spelled out is fully enacted and already felt: `Audio.loop("search", …)` plays the rummage SFX while searching (`game.ts:230`), and at night `player.ts:325` sets `p.searching`, which makes `sysAI` surge nearby zombies toward the player via `lureSpeedSurge` within `lureRadius` (`ai.ts:117-129`). The player learns cause→effect by hearing the rummage and seeing the horde accelerate in — not by reading a parenthetical. This also removes a phase branch, simplifying the code.

### ③ Battery — remove text + bar, add continuous cone dimming

**HUD removal:**
- `index.html`: remove the `#bat-state` span (line 25) and the `#batbar-wrap`/`#batbar` element (line 26). Keep `<div id="battery">` carrying only the `Flashlight [F]` control label.
- `game.ts`: remove the entire battery readout block at `941-949` — the `batbar` width write, the `bat-state` text, **and** the `el("battery")` `.low`/`.off` class toggles (so no dead class is left pointing at deleted CSS).
- `style.css`: remove `#batbar-wrap`, `#batbar`, `#bat-state`, and the `#battery.low` / `#battery.off` rules (`192-223`, and the responsive `#battery.low #batbar` at `1349`). Keep `#battery`'s layout for the lone label.

**Continuous cone dimming (the compensating cue):**

The cone's brightness should fall *continuously* as the battery drains, so a thinner, weaker beam — the encroaching dark — communicates "running low" without a bar. This is one extension to the existing pure, unit-tested `flashlightIntensity` (`flashlight.ts`), whose return value feeds the cone brightness `u_lightInt` only (verified: shader `instance.frag` multiplies it into the cone term, not the personal pool or ambient). No bespoke path.

Two pitfalls the duck flagged, and how the design avoids them:

1. **A continuous dim plus the existing low-battery flicker must not compound into near-black at low charge.** The cone falloff (`smoothstep` over `range`) already shrinks the usable beam; a naïve `dim * (1 - flickerDepth*noise)` would over-darken exactly when the player most needs to see. So the composition keeps a **non-zero usable floor**: brightness = `max(dimFloor, charge-curve)` for the steady level, with the flicker applied as a bounded tremor that **cannot drive the result below the floor** until the battery is actually empty (`<= 0`), where it still returns 0 (the cone goes out — unchanged "going dark"). `dimFloor` is a real, playable lower bound (tune ~0.35–0.5), never 0.
2. **Dimming must not make the whole game feel dark from the start.** The charge curve stays ~1.0 across the high-charge range and only ramps down as the battery approaches the low band (roughly `smoothstep`-shaped around `lowThreshold`), so a fresh battery looks bright and the dimming reads as a *progression* toward the dying, deep-flickering low state.

New `CONFIG.flashlight` knobs (exact names finalized in the plan): a `dimFloor` and the curve's onset/shape. Curve and floor are **tuned in CONFIG and validated by playtest** — feel-first; not done until felt.

**Unaffected by the removal (verified):** the "going dark" die cue (`game.ts:178-182`) edge-detects `p.battery`/`p.lightOn` directly and is independent of the HUD readout — it keeps firing. Dust motes gate on `lightOn && battery > 0` (`game.ts:322`) and do **not** read `flashlightIntensity`, so they won't auto-follow the dim (a minor cosmetic note; revisit only if playtest shows the motes reading too bright against a dimmed cone).

## Co-op / single-player safety

All three edits are HUD/render-only; no sim state changes, no net code touched. `battery` and `lightOn` are already synced in snapshots, and `flashlightIntensity` is computed locally per player in `draw()` from synced fields plus an id-seeded flicker noise — so the dimming is deterministic and identical across host and all clients, and single-player stays byte-for-byte unchanged.

## Testing

- **Unit (pure, deterministic):** extend `flashlight.test.ts` for the new dimming. The existing cases need their call signature updated (a breaking arg addition). New cases: brightness is monotonically non-increasing as charge falls; the steady level respects `dimFloor` (never below it while `battery > 0`); returns exactly 0 at empty; the low-battery deep flicker still applies below `lowThreshold` but cannot punch through `dimFloor`; high-charge stays ~1.0.
- **Playtest (mandatory — feel-first):** with `bun run dev`. Confirm: the HUD reads clean with no count and no battery meter; threat density is legible by ear (tension/groan) and the night's progress by the clock-dial; the beam visibly weakens as the battery drains and the low-battery flicker still reads as a dying bulb, **without** the cone becoming unfairly dark at usable charge; the night-search prompt no longer spoils the lure yet the rummage SFX + accelerating horde still teach the risk.

## Files touched

- `index.html` — remove `#wavetag`, `#bat-state`, `#batbar-wrap`/`#batbar`.
- `game/style.css` — remove `#wavetag`, `#batbar*`, `#bat-state`, `#battery.low/.off` rules.
- `game/game.ts` — remove `el("remaining")` write; collapse the night-search prompt ternary; remove the battery readout block (`941-949`).
- `game/systems/flashlight.ts` — extend `flashlightIntensity` with the continuous dim (floor + curve).
- `game/systems/flashlight.test.ts` — update existing cases, add dim cases.
- `game/config.ts` — add the `dimFloor` + curve knobs under `flashlight`.
