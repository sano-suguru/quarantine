# Light / Vision Occlusion by Walls — Design

**Date:** 2026-07-05
**Status:** Brainstormed; feel target chosen (crisp/hard edge); **revised after independent (rubber-duck) review against the codebase**; **pending user review**, then plan.
**Kind:** Engine foundation. **Foundation 1 of 3 for the Stalker** (`2026-07-05-stalker-core-design.md`) — *and* a standalone fix for the "aim-through-buildings" stress plus a horror multiplier. Build order: **this → enemy AI navigation → Stalker.**
**Note on the Stalker dependency:** this provides the Stalker's **visual** foundation only (you can't *see* a Stalker standing in shadow). The **functional** side — "routes to the least-watched opening", enemy line-of-sight — needs AI-side LOS and belongs to the **AI-navigation spec**. Render-occlusion ≠ AI-occlusion; do not conflate them.

## Problem

The flashlight cone and the ambient reveal are computed by `lightAt(w)` — duplicated in **`grid.frag`** (floor) and **`instance.frag`** (entities/props) — with **no wall occlusion**. The beam and the dim reveal pass straight through buildings, so an enemy behind a wall is lit and fully visible.

But **bullets already stop at solid walls** (`bullets.ts:26`, "windows/boards let you fire out"). The result is a **see / aim / can't-hit mismatch**: you see and aim at an enemy through a building, fire, and hit the wall. That mismatch is the reported stress (user: 建物越しにエイムしちゃう).

It also **flattens the horror**: no dark corners, nothing can hide behind structure, sight is free. And it is the Stalker's **visual foundation** — "lurks behind walls / at the edge of the light" presumes a visual occlusion the engine does not have (the *functional* "routes to the least-watched opening" is AI-side LOS, see the Note above).

## Goal

**Walls block light.** A world point with a wall between it and a given flashlight receives **no** cone/pool contribution from that light. Crucially — a wall **shadow** falls to a **separate, darker `u_shadowFloor`, NOT the open-night `u_ambient`**:

- **Open night** (no wall between you and the light, but out of cone/range) stays at `u_ambient` = the existing gloom (dimly visible, *not* a void — [[lighting-gloom-albedo-model]] preserved, `nightAmbient` unchanged).
- **Wall shadow** (a wall between the light and the point) drops to `u_shadowFloor`, which can go **much darker (near-black)** — so a Stalker/enemy standing behind a building is genuinely *unseen*, not "dimly tempting to shoot at."

This split resolves the core tension the review flagged: if shadow used the gloom floor, enemies behind walls stay faintly visible and the aim-urge (the very stress we're fixing) survives; if we darkened the *global* ambient instead, the open night becomes an unreadable void. Two independent floors give **both**: readable open gloom + truly hiding shadows. `nightAmbient` also stops doing double duty (global darkness *and* shadow darkness).

**Crisp lit-cone boundary; open gloom preserved; shadow genuinely dark.**

## Design

### Where the change lives

Extend `lightAt(w)` in **both** `grid.frag` and `instance.frag` (they intentionally duplicate the function — the two copies must stay byte-identical). For each light `i`, before adding its cone/pool contribution, **test whether the segment `u_lightPos[i] → w` is blocked by any occluder**; if blocked, that light contributes `0` at `w`, so the point drops to `u_shadowFloor` (per Goal — a darker, separate floor), *not* the open-night `u_ambient`.

### The occlusion test

- Upload wall segments as a uniform array mirrored in both shaders (exactly like `MAX_LIGHTS`): `uniform vec4 u_wall[MAX_WALLS]` = `(x1,y1,x2,y2)` and `uniform int u_wallCount`. Dynamic index `u_wall[i]` in a fragment loop is legal in GLSL ES 3.00 (unlike 2.0) — confirmed OK.
- Per fragment, per light: loop occluders and test whether the segment `(lightPos, w)` crosses each wall. If any does ⇒ shadowed ⇒ that light contributes `0`; the point drops to `u_shadowFloor`.
- The **hard edge falls out naturally**. Soft penumbra is a later upgrade (see Non-goals).

**Numerical hygiene (must be in the design — the review showed these WILL bite otherwise, because in a fragment every pixel *is* `w`):**

- **Endpoint self-shadow / caster-edge acne.** A pixel *on* a wall makes `light→w` end exactly on that wall's endpoint; a naive `segmentHitsSegment` reports a hit (its collinear-touch branch) and the wall outlines *itself* in black. **Fix:** compute the intersection parameter `t` along `light→w` and require `t ∈ (ε, 1−ε)` — ignore hits at the very end (the point's own surface). Skip the game's collinear/`onSeg` branch entirely in the port (a measure-zero case not worth a per-pixel branch).
- **mediump cancellation.** Cross products of raw world coords (±1600) lose sign precision in `mediump` → shadow acne / shimmer. **Fix:** do the occlusion cross-products in **light-relative coordinates** (translate so the light is the origin, as the CPU `geometry.ts` already does) and use **`highp`** for just this math. Verify no Mali/Adreno regression from the mixed precision.

### Occluders (Phase 1 = walls only)

- **`state.walls`** (solid) occlude.
- **Barricades / boarded openings do NOT occlude** by default — consistent with bullets passing boarded windows (`bullets.ts`): a boarded opening is your **firing slit**; you must be able to watch and shoot through it. (Deferred synergy — "intact barricade gates your sightline; smashing it opens light + sight" — is an Open question; it conflicts with firing-out and needs its own feel call.)
- **Enemies/props do NOT cast shadows** (dynamic self-shadowing is out of scope).

### Cost control (mobile / co-op are real targets) — corrected after review

The review found the original "CPU-cull near each light" plan **wrong on two counts**: (a) occlusion is done by walls *between the light and the point*, not walls *near the light* — near-light culling would drop a long exterior wall that shadows a far point; (b) per-light wall lists blow the uniform budget (`8 lights × 32 = 256 vec4 > 224` guaranteed max). So:

- **No CPU per-light culling.** The whole world is only **~28 static wall segments** (HOME 8 + POIs, built once in `state.ts:44`, never mutated). Send **all of them, once** (walls are immutable — not a per-frame upload; re-send only if `state.walls` ever changes, which it doesn't in a run). `MAX_WALLS` ≈ 32 headroom; uniform budget fine (`~112/224` vec4 with the new array).
- **Early-reject in the shader**, not on the CPU: before the segment test, skip any wall whose closest point to the light is beyond the cone `range` (`dist(light, closestPointOnSegment) > range` ⇒ can't matter). Correct criterion (light-to-wall proximity, not fragment-to-wall), cheap, per-light.
- **Count ALL lights, not just "one per player".** `MAX_LIGHTS = 8` and **weapon-bearing deployables also `addLight`** (`game.ts` `selectLights`). Cost is `frags × up-to-8-lights × up-to-28-walls` — and occlusion applies to deployable lights too (desirable). Profile against this, not against a single flashlight.
- **`grid.frag` (floor) is the dominant cost** (full-screen). Default: occlude **both** shaders (floor + entities) for consistency — a lit floor patch behind a wall with a dark enemy on it looks broken. **Fallback if mobile can't hold it:** drop *floor* occlusion (keep entity occlusion) and/or disable occlusion on low-end. This is a profiling decision, called out so it isn't a surprise.
- Personal "feet" pool occlusion: still an Open question (it's an omni pool, so the same `light→w` test applies cleanly; cost is tiny).

### Purity / safety

This is **pure render** — a shader change plus a **one-time** uniform upload of the static `state.walls` (walls are immutable within a run; no per-frame upload). Like the darting-shadow streaks (`game.ts` — deliberately "NOT in `state.particles` → single-player safe"), it adds **no sim/AI/synced state**. Therefore **single-player stays byte-for-byte unchanged and co-op is unaffected**. Review confirmed this against the code: `state.walls` is built from the static map in `newState()` (`state.ts:44`), host and client each hold the identical copy, and `snapshot.ts:20` explicitly excludes walls from sync — so each client computes occlusion locally and agrees, with nothing to synchronize.

### What does NOT change

- **Bullets** (already wall-blocked), **aim** (the mouse is still free — you simply can't *see* past walls, so you won't aim there), **enemy sense / dread** (still not line-of-sight — that belongs to the AI-navigation spec), and the lighting model otherwise.

## Non-goals (scope fence)

- **No soft shadows / penumbra.** Crisp first; soft is a later upgrade (multi-sample or edge-distance estimate) only if playtest wants it.
- **No LOS-based AI or dread.** Whether enemy `sense`/`lurking` becomes line-of-sight is the **AI-navigation spec's** decision, not this one.
- **No dynamic occluders.** Enemies/props/the player do not cast shadows.
- **No change to bullets, aim mechanics, or economy.**

## Validation plan (feel-first — not done until played)

Playtest in gloom:
1. Is the **aim-through-buildings stress gone** — do you stop trying to shoot enemies you can't see? (Depends on `u_shadowFloor` being dark enough that shadowed enemies read as *hidden*, not faintly tempting.)
2. Do walls/structures create **real dark hiding spots** (corner dread up) while the **open night stays readable gloom** (the two-floor split working)?
3. **No visual artifacts:** no black outline on wall edges (caster-edge acne), no distracting *double* dark boundary where a cone edge meets a shadow edge, no shimmer from precision.
4. **Deployable searchlights** cast shadows correctly too (not just the player flashlight).
5. **Boarded-opening feel:** since barricades don't occlude, light/sight still leak through a boarded window — does "I boarded it but can still see/shoot out" read as intended (firing slit) or wrong?
6. Does **performance hold** on target devices (incl. mobile/co-op) with up to 8 lights × 28 walls?

Any "no" → retune (`u_shadowFloor`, `nightAmbient`, floor-occlusion on/off, ε, precision) before proceeding.

## Open questions

- **`u_shadowFloor` value:** how dark (near-0 to fully hide vs. a hair of gloom for legibility), and whether it should scale with day/phase like `nightAmbient` does.
- **Barricade occlusion:** never (default, firing-slit friendly) vs. intact-blocks (integrity-gates-sightline synergy). A feel call, deferred.
- **Floor (`grid.frag`) occlusion:** keep it (consistency) vs. drop it (perf) — resolved by profiling, defaulting to keep.
- **Personal-pool occlusion:** occlude the feet bubble too, or leave it unoccluded for cost/fairness.
- **Precision:** confirm `highp` occlusion math + light-relative coords is artifact-free across Mali/Adreno; pick final `ε`.
- **Mobile perf budget** (8 lights × 28 walls × full-screen) and low-end fallback (drop floor occlusion / disable).
- **Soft-shadow upgrade path** if a later playtest wants atmosphere over crispness.
