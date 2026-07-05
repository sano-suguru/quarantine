# Stalker Phase 1.5 — Phantom Perception (fake cues) Design

**Date:** 2026-07-06
**Status:** Brainstormed & approved; **rubber-duck reviewed and revised** (fairness discriminator strengthened for mono, lockout seam defined, silhouette-first staging, gate corrected to `vis`/`state`); **pending user review**, then plan.
**Kind:** Feel-deepening pass on the merged Stalker Phase 1 (PR #46). Not a new core mechanic — it sharpens the **"can't trust your own eyes"** pillar the user chose (自分の目が信じられない).
**Depends on:** Stalker Phase 1 (merged): `state.stalker` slot, `sysStalker`, `vis`/telegraph/ward systems, `stalkerFx.ts` (dread telegraph). Reads the same `dread` signal stalkerFx computes.
**Parent spec:** `docs/superpowers/specs/2026-07-05-stalker-core-design.md` (§Phase 1.5). This spec details the "fake perception cues" slice of that phase.

## Problem

Stalker Phase 1 shipped the *real* telegraph (localizable footfall, cone flicker, heartbeat) and the ward/grab loop. What it deliberately deferred is the **perception-lies layer** — the cues that make the player doubt what they see and hear. Without it, the night reads as "quiet, then the real stalker arrives"; the dread only exists when the stalker is actually close. The Phase 1.5 goal is to fill the *quiet* with doubt, so being hunted frays your perception even when the stalker is far — the RE2/Darkwood "was that it?" tension.

## Goal

Add **fake perception cues** — fleeting stalker-shaped silhouettes and phantom (non-localizable) footsteps — that drift during the quiet of a stalker night and recede as the real threat approaches. They unsettle but **never punish**: no hitbox, no damage. The player learns to distinguish a real approach (a **localizable** directional footfall) from a lie (a **non-localizable** phantom), keeping "I heard it and reacted" a learnable skill rather than a coin-flip.

## Scope

**In scope (this spec):**
- Fake stalker-shaped silhouettes (visual, no hitbox, render-only).
- Phantom footsteps (audio, footfall-like rhythm but non-localizable).
- The minimal audio priority needed so a real localizable footfall always cuts through (achieved mostly by the trigger model; see §Trigger).

**Implementation staging (risk-ordered — the two channels ship in sequence, not at once).** The chosen pillar is literally *"can't trust your **eyes**"* (自分の目が信じられない), and the two channels carry very different risk:
- **Stage 1 — silhouettes (low-risk, high-return).** The visual fake directly serves the pillar and is fairness-safe: the player never observes a hitbox, so a fleeting silhouette is harmless misinformation by construction (exactly like `darts`). Ship this first and validate **Feel gate #1** (doubt in the quiet).
- **Stage 2 — phantom steps (higher-risk).** The audio fake carries all the fairness/masking risk (§Fairness). Add it only after Stage 1 passes, and validate **Feel gate #2** (real cuts through) on mono + a dense night before accepting. If the discriminators don't hold up in playtest, the phantom step can be cut or deferred without losing Stage 1's value.

This ordering does not change the end state (both channels), only the sequence, so the risky channel can be validated or dropped independently.

**Deferred (separate specs, from the parent §Phase 1.5 / Phase 2):**
- **Map loop/hide geometry rework** (`data/map.ts`) — separate level-design work; entangles collision/nav/co-op verification. Its own spec.
- **Full audio ducking/priority polish** beyond the minimal cut-through rule below.
- **Cumulative `menace`** (Phase 2).

## Non-goals (scope fence)

- **No fake flicker (YAGNI).** The flashlight cone-flicker stays a *real* tell of stalker proximity (Phase 1). Faking it too would erode a legible real cue; two fake channels (silhouette + phantom step) are enough.
- **No hitbox, no damage, ever.** Fakes are perception distortion, not entities. They are never in `state.zombies`/`state.stalker`/`state.particles` and never touch sim state — same guarantee as `darts`.
- **No new sim/wire state.** Fakes are re-derived locally per client from the already-synced `state.stalker` + local player; nothing is added to the snapshot. Single-player stays byte-for-byte safe.
- **Fakes do not reuse the real localizable footfall sound.** A fake silhouette must never be accompanied by `Audio.stalkerFootfall` (the real, localizable cue). Doing so would falsely signal a real approach and break the fairness invariant.

## Fairness invariant (the load-bearing rule)

The perception-lies goal and the Phase-1 fairness principle (#2: *heard before seen*) coexist **only** if the player can tell a real cue from a fake one. The naive encoding — "real = localizable pan, fake = non-localizable" — is **too weak on its own**: the real footfall already pans only left/right (`pan = clamp(dx/400, ±1)` in `stalkerFx.ts:117`, `dy` ignored — top-down front/back is not encoded), and on mono output `Audio.stalkerFootfall` bypasses the panner entirely (`audio.ts` `else` branch), so pan-vs-no-pan collapses. The encoding therefore rests on **two discriminators, at least one of which works on mono**:

1. **Volume-tracks-proximity (the mono-safe, primary discriminator).** The **real** footfall's volume rises monotonically as the stalker nears — this is already true: its `vol = footfallVolMin + (footfallVolMax − footfallVolMin) · dread` (`stalkerFx.ts:118`), and `dread` rises with nearness. The **fake** step's volume is **distance-independent** (a flat, low CONFIG level, never scaled by any real distance). The learnable rule that survives mono and a dense night: *"a step that gets louder as it repeats is the real approach; a step at constant low volume is a lie."*
2. **Timbre + pan (the stereo-only, secondary discriminator).** The fake step uses a distinct procedural timbre (duller/reverberant) and a **fixed centre pan** (not jittered — a jittered pan overlaps the real cue's pan continuum; a hard centre is binary and easier to learn). The fake silhouette carries **no hitbox** and is never paired with a real `Audio.stalkerFootfall`.

Lies unsettle; they never kill. Because the real cue always precedes contact (Phase-1 #2 holds — the footfall is real), the worst a fake can do is *distract*; it can never be the sole warning before a hit. **Feel gate #2 must be validated specifically on mono output during a dense night** (the masking worst-case), not just in stereo quiet.

## Architecture

A new **render/audio-only** sibling to `stalkerFx.ts`:

**`game/systems/stalkerPhantom.ts`** — mirrors `stalkerFx.ts`'s contract exactly:
- No sim state mutated; nothing written to `state.particles` or any sim field. Purely re-derived from the snapshot world each draw frame. Single-player byte-for-byte safe; co-op clients re-derive their own (perception is personal — *my* phantoms ≠ *your* phantoms; nothing synced).
- Module-level bookkeeping only (an array of active fake silhouettes + spawn/audio timers), reset between runs via a `resetStalkerPhantom()` called from `resetAtmosphere` (same as `resetStalkerFx`).
- Called once per draw frame from `game.ts:draw()`, after `stalkerFx` (so it can read the same `dread`; see §Trigger).

**Lockout seam (who owns it).** The real footfall is fired *inside* `stalkerFx` (`stalkerFx.ts:119`), which today returns only `dread` — the phantom module has no way to know a real footfall just played. Rather than duplicate `stalkerFx`'s footfall-interval logic (which would be the exact "special-case debt" CLAUDE.md forbids), **`stalkerFx` owns the lockout**: when it fires `Audio.stalkerFootfall` it also sets a module-level lockout timer, and exposes `export function phantomStepLocked(): boolean` (true while the timer is live). `stalkerPhantom` calls it before firing a phantom step. The real cue's firer is the single source of truth for "a real step just played." (`resetStalkerFx` also clears the lockout timer.)

**Interface:**
```ts
/** One fleeting fake silhouette (render-only; NO hitbox, NOT in state.particles). */
interface Phantom {
  x: number; y: number;   // world position (near the local player's vision edge)
  face: number;           // facing for the sprite
  life: number;           // remaining seconds
  maxLife: number;        // for fade-in/out alpha
}

/** Reset per-run bookkeeping (active phantoms + timers). Call from resetAtmosphere. */
export function resetStalkerPhantom(): void;

/**
 * Update phantom silhouettes + fire phantom audio for this draw frame.
 * @param state  read-only (stalker + local player)
 * @param lp     local player (localPlayer(state))
 * @param ddt    render-side dt (state.time delta, clamped ≤ 0.1 by game.ts)
 * @param dread  the dread value stalkerFx already computed this frame (0..1)
 * @returns      the active phantom silhouettes to draw (game.ts owns the renderer)
 */
export function sysStalkerPhantom(state: State, lp: Player, ddt: number, dread: number): readonly Phantom[];
```

`game.ts:draw()` draws the returned phantoms the way it draws `darts` — a short loop pushing dark, low-alpha, stalker-shaped sprites to the renderer. `stalkerFx` already returns `dread`; pass it in so both modules agree on one value and the phantom rate is a pure function of it.

**Audio:** one new procedural primitive **`Audio.stalkerPhantomStep()`** — a footfall-*like* thud (so it plausibly reads as the stalker) but engineered to fail both localization tests: a **fixed centre pan** (not jittered) and a subtly different timbre from `Audio.stalkerFootfall` (e.g. duller/reverberant). It takes **no distance/volume argument** — it always plays at a flat, low CONFIG level, so it can never mimic the real cue's approach-tracking loudness (the primary mono-safe discriminator, §Fairness). Fully procedural (oscillator/noise + envelope), consistent with the asset-free `audio.ts`.

## Trigger / rate model

Fakes drift during the quiet and recede as the real threat rises — the rate is **inverse to `dread`**:

- Gate (identical to `stalkerFx`'s, plus a state filter): only when `state.stalker` is non-null **and** `state.phase === "night"`. The `Stalker` type has **no `present` field** — `stalkerFx` gates on `!sk || phase !== "night"` (`stalkerFx.ts:88`) and lets `sk.vis` fade the cues out during withdraw; phantoms use the **same** gate. **Additionally, phantoms only run while `sk.state` is `"lull"` or `"aggro"`** — `"stagger"` (just warded) and `"retreat"` (post-grab / dawn) are moments the tension *should* release, and their `vis→0` fade would otherwise drive `dread→0` and spam phantoms at exactly the wrong beat. (This is why the gate is on `state`, not on `vis`/`dread` alone.)
- `phantomRate = maxRate * (1 - dread)^k` (k a CONFIG shaping exponent). At `dread ≈ 0` (stalker far or lit — the quiet) phantoms drift at the ambient max; as `dread` rises toward a real approach, the rate falls to ~0. `dread` here is the value `stalkerFx` computed this frame; a light EMA smoothing may be applied to damp the step-change when the player sweeps light across the stalker (`unlit` is binary) — see §Open questions.
- **Cut-through / minimal audio priority:** because phantom audio is gated by `(1 - dread)`, a rising real telegraph already silences phantoms. Additionally, `stalkerPhantom` checks `phantomStepLocked()` (owned by `stalkerFx`, §Architecture) before firing a phantom step, so a real `stalkerFootfall` that just played on this beat suppresses the fake — the real localizable cue is never muddied. This covers the mid-`dread` window where the real footfall fires but the rate gate hasn't fully closed yet.
- Silhouettes and phantom steps fire on **independent** low-rate timers (they may coincide by chance, adding variety); neither is required for the other.
- Concurrency/lifetime caps: at most `phantomMax` (1–2) silhouettes at once, each `phantomLife` (~0.3 s) with fade-in/out; a phantom step interval jittered around a CONFIG mean. All values in `CONFIG.stalker` (new `phantom*` fields), conservative defaults, playtest-tuned.

### Placement of silhouettes

Spawned near the **local player's vision edge** — at the flashlight cone's outer edge or just into the surrounding gloom (the `darts` spawn logic is the reference: pick a side, an angle near `lp.aim ± halfAngle`, a distance in `flc.range`). They read as "something at the corner of the beam," then fade. Rendered as the stalker sprite, darkened + desaturated + low alpha, brief.

## Config (new `CONFIG.stalker` fields)

All new, conservative, playtest-tuned. Indicative names/defaults (tunable):
- `phantomMax` (2) — concurrent silhouette cap.
- `phantomLife` (0.3) — silhouette lifetime (s), with fade.
- `phantomSpawnIntervalMax` (~5 s) — mean interval between silhouette spawns at ambient max rate.
- `phantomStepIntervalMax` (~4 s) — mean interval between phantom steps at ambient max rate.
- `phantomDreadExp` (k, e.g. 1.5) — shaping exponent for the `(1-dread)^k` falloff.
- `phantomStepLockout` (~0.6 s) — window after a real `stalkerFootfall` during which no phantom step fires (the timer lives in `stalkerFx`, the lockout's owner; §Architecture).
- `phantomStepVol` (low, flat) — the fixed phantom-step volume; deliberately **not** distance-scaled (§Fairness).
- `phantomAlphaMax` (~0.5) — peak silhouette alpha.
- `phantomDreadSmooth` (optional, e.g. EMA factor) — smooths `dread` before the rate falloff so a light-sweep across the stalker (binary `unlit`) doesn't jump the rate; omit if playtest shows no jank.

## Co-op

Host-authoritative unaffected: `state.stalker` is already synced (Phase 1). Phantoms are re-derived **locally on every client** from that synced stalker + the client's own local player — nothing new crosses the wire, and each player's phantoms are independent (personal perception distortion). Same net-agnostic posture as `stalkerFx`/`darts`.

## Testing

`stalkerPhantom.ts` is render/audio-only feel code — **excluded from coverage** exactly like `stalkerFx.ts`, `ai.ts`, `fx.ts` (add to the `vite.config.ts` exclude list). Any genuinely pure helper worth pinning (e.g. the `(1-dread)^k` rate function or the spawn-position geometry) may be extracted and unit-tested; otherwise the feel is validated by the playtest gates below. `Audio.stalkerPhantomStep` is procedural audio (not unit-tested, like the rest of `audio.ts`).

## Feel gates (human playtest — the real acceptance)

1. **Doubt in the quiet (Stage 1, silhouettes):** during a lull, do the fleeting silhouettes make you second-guess ("いる…？") without the real stalker being near?
2. **Real cuts through (Stage 2, phantom steps) — test on mono + a dense night:** when the stalker actually approaches, does the real footfall's *rising, approach-tracking* loudness clearly read as real and distinct from the flat-volume phantom steps, so you can react correctly *even without stereo and amid the crowd's groans/screeches*? This is the fairness worst-case; if it fails, retune the discriminators or cut the phantom step (Stage 1 still stands).
3. **Not noisy:** are the fakes rare/subtle enough that they unsettle rather than annoy (メリハリ preserved)? In particular, no phantom spam right after a ward (`stagger`) or grab/withdraw (`retreat`). Any "no" → retune CONFIG before proceeding.

## Open questions (resolve during plan/playtest, not blocking)

- Exact `phantom*` tuning (rates, alpha, timbre of the phantom step) — set conservative, tune by feel.
- Whether phantoms should also spawn briefly **after** a grab/withdraw (a lingering "afterimage" of terror) — default no (and the `stagger`/`retreat` gate exclusion actively prevents it); revisit only if the withdraw feels too clean.
- Whether `phantomDreadSmooth` (EMA on `dread`) is needed — decide by playtest; the `unlit` binary can jump the rate when the player sweeps light, but existing-phantom `life` may absorb it. Add only if jank shows.
- Whether the phantom step survives Stage-2 playtest at all, or is cut/deferred if the mono/dense-night discriminators don't hold (§Feel gate #2).
