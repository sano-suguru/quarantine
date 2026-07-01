# Integrity Desaturation → Render Pipeline (compositing-order fix)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the compositing-order inversion introduced by PR #32. The HP "wound" readout has two layers — a **desaturation/dim base** (currently a CSS `filter` on the `#game` canvas) and a **blood vignette** (a full-screen shader pass drawn *inside* the canvas). Because CSS `filter` post-processes the whole canvas output, it desaturates the blood vignette too — draining exactly the layer meant to be the readable cue. Move desaturation/dim **into the render pipeline** (world shaders), drawn **before** the blood pass, so the world drains while the blood stays vivid.

**Architecture (Option B — no FBO):** Add a `u_sat`/`u_dim` grade uniform to the two world shaders (`grid.frag` = floor, `instance.frag` = all sprites) and apply it as the final step of each fragment (`col = mix(vec3(luma), col, u_sat) * u_dim;`), immediately after existing lighting. The blood pass runs later in `flush()`, so it is not graded. A new `Renderer.setGrade(sat, dim)` (mirroring `setBlood`) pushes the values; `game.ts draw()` computes them from the pure `integrityGrade` and eases them frame-rate-independently. The CSS `filter` and its transition are removed. Render-only — no `state`/sim/net change; single-player byte-for-byte for the *world*; the *blood* deliberately no longer desaturates (an intentional feel change — see Global Constraints).

**Tech Stack:** WebGL2 (GLSL ES 3.00, `?raw`-imported shaders), TypeScript strict + `noUncheckedIndexedAccess`, Vite, Bun, Vitest, Biome. CSS in `game/style.css`.

Reviews folded in: my PR #32 review findings #1 (this fix), #2 (comment), #4 (optional); rubber-duck independent review (2026-07-01, verdict: Option B sound, FBO rejection correct, 5 concrete holes to close — all incorporated below).

## Global Constraints

- **This is a feel change, not an equivalent migration.** After the move, the world desaturates but the blood vignette stays fully saturated (that is the whole point). The look *will* differ from `main` at low HP. Per the project's feel-first non-negotiable, this is **not done until played and felt** — see Task 0 (confirm the regression is real) and the final Playtest (confirm the new look is better). Compiling + green tests is **not** the completion bar.
- **Render-only; sim & net untouched.** `setGrade` reads `cameraTarget(state)` (== `localPlayer` while alive / single-player) read-only and pushes two floats. No change to `state`, `update`, `sysFx`/`sysAI`, snapshots, or `game/net/` — the **simulation stays byte-for-byte** (the PR's byte-for-byte guarantee is about the sim, and it holds). The rendered *world pixels* at full HP are **visually identical** to `main` but **not** guaranteed bit-identical: `mix(luma, col, 1.0) * 1.0` still executes float ops the GPU may not fold away (≤1 ULP). Do not claim pixel byte-equality; claim "indistinguishable at full HP".
- **`draw()` runs on EVERY frame — title, shop, pause, game-over included** (`main.ts:359` is unconditional; only `updateHUD` at `:361` is `running`-gated). This is the load-bearing fact for correctness: the grade computation moves from the `running`-gated `updateHUD` to the always-on `draw()`, so it **must self-gate on `state.running`** or it will recompute a max-desat target from `cameraTarget` (which returns a hp=0 corpse on game-over, `players.ts:79-83`) and drain the debrief/title screen (visible because `.overlay` backgrounds are only ~0.82–0.96 alpha — the frozen canvas shows through). See Task 2 for the exact gating.
- **Grade math is a per-pixel uniform multiply/mix applied after lighting** — for the *world* it reproduces the old CSS `saturate()`/`brightness()`: both are per-pixel, and `dim` is linear so `dim*(grid+glow) == dim*grid + dim*glow`. **Caveat:** the equivalence is exact only where the additive sum doesn't clamp to 1.0; in blown-out glow regions (rare in this dark scene) `dim*clamp(a+b) ≠ clamp(dim*a+dim*b)`, and `saturate` on additive is non-linear (a deliberate feel knob, not a faithful reproduction). Insert **after** the existing `lightAt` multiply so order matches the old "grade the final lit color" behavior.
- **Two shaders, one insertion each.** `instance.frag`'s shape branches all converge on the final line `frag.rgb *= mix(u_emissive, 1.0, lightAt(v_world));` — one insertion after it covers every shape. `grid.frag` ends at `frag = vec4(col, 1.0);` — one insertion before it. `blood.frag` is **not** touched.
- **`integrityGrade` reused as-is** — no new pure function, no new unit test (the curve is already covered). Grade knobs stay in `CONFIG.horror` (`desatOnset`/`desatFloor`/`desatDim`/`desatGamma`), meaning unchanged.
- **Frame-rate-independent easing.** The old CSS `transition: filter 0.25s` is replaced by an exponential ease in `draw()` using the **existing render dt `ddt`** (already computed from `state.time` and used for `drawAtmosphere`): `cur += (target - cur) * (1 - Math.exp(-rate * ddt))`. Do **not** use a raw `*k` lerp (frame-rate dependent). Do **not** invent a new dt source — `ddt` is the correct render-side clock.
- **Grade state ownership: `draw()` only *advances* it while running; the meta-screen transitions *own* the reset.** The old code cleared the CSS filter (`filter=""`) in `resetAtmosphere`/`endRun`/`toTitle`. That responsibility **does not disappear** — those three sites instead snap the eased grade to full color (`gradeSatCur=gradeDimCur=1`). `draw()` recomputes+eases the target from `cameraTarget` **only when `state.running`**; when not running it re-pushes the held `cur` values unchanged. This split (advance-if-running in `draw`, snap-to-1 in endRun/toTitle) is what makes pause **hold** the current desaturation (running may still be true, or cur is simply held) while game-over/title **return to full color** — matching the old CSS behavior exactly and avoiding the corpse-driven debrief drain. Do **not** force 1/1 unconditionally in `draw()` (that would wipe desaturation the instant you pause).
- **`prefers-reduced-motion`:** the grade is a static color change (not motion), so it is exempt from the churn-freeze that governs the blood clock. But the 0.25 s ease itself is motion — under reduced-motion, snap the grade to target instantly (skip the lerp).
- **Branch/commits:** work is on `feat/integrity-diegetic-feedback` (already checked out). Commit messages end with the repository footer (Co-Authored-By + Claude-Session lines).
- **Quality gates:** pre-commit `biome check --write`; pre-push `typecheck` + `test`. `?raw` does not compile GLSL at build — shader validity is confirmed by launching `bun run dev` (programs link at `init` or throw; a `?netlog`-free GL-error smoke check on startup).

## File structure

- **Modify** `game/engine/shaders/grid.frag` — add `uniform float u_sat, u_dim;`; grade `col` before the final `frag`.
- **Modify** `game/engine/shaders/instance.frag` — add `uniform float u_sat, u_dim;`; grade `frag.rgb` after the `lightAt` line.
- **Modify** `game/engine/renderer.ts` — grade uniform locations for both programs in `init`; module state `gradeSat`/`gradeDim`; `setGrade` setter; push uniforms in `flush` before the grid + instance passes (and, if additive is treated differently, re-push before the additive draw); export `setGrade`.
- **Modify** `game/game.ts` — eased grade state + `state.running`-gated `setGrade` call in `draw()` (using `ddt`); remove the CSS-filter block in `updateHUD`; replace the three filter-clear sites (`resetAtmosphere`/`endRun`/`toTitle`) with a grade snap-reset (+ `lastDrawT` reset in `resetAtmosphere`); fold both the grade and the existing blood HP-drive into one `state.running` gate in `draw()`. Fix stale comments (finding #2). Optionally re-evaluate `reducedMotion` per run (finding #4).
- **Modify** `game/style.css` — remove `transition: filter 0.25s ease-out;` from `#game`.

---

### Task 0: Confirm the regression is felt (feel gate — decision point, not a code step)

Before writing any code, verify the problem is real (rubber-duck flagged that PR #32 playtested as "readable", and the worst case `saturate(0.2)` coincides with death → gameOver, so it's rarely seen; the real concern is the mid-HP band).

- [ ] `bun run dev`, take damage to the HP 0.10–0.35 band, and judge whether the blood vignette reads noticeably worse than it should.
- [ ] **Objective A/B (don't rely on memory):** at that HP, in devtools set `document.getElementById('game').style.filter=''` to strip the desaturation live, then toggle it back. If the blood's readability jumps visibly with the filter off, the regression is real. This needs zero code changes and gives a concrete before/after.
- [ ] **Decision:**
  - If the blood is clearly muddied and the readout suffers → proceed to Task 1.
  - If it reads fine → **do not** do Tasks 1–2 (no architecture for an unfelt problem). Ship only finding #2 (comment fix) and optionally #4. Record the decision.

---

### Task 1: Grade uniform in the world shaders + renderer plumbing

**Files:** `game/engine/shaders/grid.frag`, `game/engine/shaders/instance.frag`, `game/engine/renderer.ts`

- [ ] `grid.frag`: add `uniform float u_sat; uniform float u_dim;`. Before `frag = vec4(col,1.0);`, insert:
      `col = mix(vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), col, u_sat) * u_dim;`
- [ ] `instance.frag`: add the same two uniforms. After the final `frag.rgb *= mix(u_emissive, 1.0, lightAt(v_world));`, insert:
      `frag.rgb = mix(vec3(dot(frag.rgb, vec3(0.2126, 0.7152, 0.0722))), frag.rgb, u_sat) * u_dim;`
- [ ] `renderer.ts`: in `init`, get uniform locations for **both** `gridProg` and `instProg` (`g_sat`/`g_dim`, `u_sat`/`u_dim`). Add module state `let gradeSat = 1, gradeDim = 1;`.
- [ ] `renderer.ts`: add `function setGrade(sat: number, dim: number): void { gradeSat = sat; gradeDim = dim; }` (render-only doc comment mirroring `setBlood`). Export it in the `Renderer` object.
- [ ] `renderer.ts` `flush`: after `useProgram(gridProg)` set `g_sat`/`g_dim`; after `useProgram(instProg)` set `u_sat`/`u_dim`. **These pushes MUST be unconditional** — outside the `if (bloodIntensity > 0)` guard (unlike the blood pass). This is what guarantees the world is always graded by the current `gradeSat`/`gradeDim` module values even on frames where `draw()`'s `setGrade` path is gated off; a stray GL-default `u_sat=0` (full gray) can never leak.
- [ ] **Additive-pass decision:** default = grade normal *and* additive identically (dim is linear → equivalent to old CSS; simplest). Only if the playtest wants vivid eyes/muzzle at low HP, re-push `u_sat = 1` (keep `u_dim`) between `drawLayer(normal)` and the additive `drawLayer(additive)`. If you do, the **next frame's** unconditional `u_sat` push (above) restores the graded value before the normal pass, so no explicit "restore after additive" line is needed — but note this ordering in a comment so it isn't broken later. Also comment that `saturate` on additive is non-linear (not a faithful CSS reproduction) and is a deliberate feel knob; `dim` on additive is linear/equivalent either way.
- [ ] Sanity: with `gradeSat=1, gradeDim=1` (full HP) the world is byte-identical to `main`.

**Verify:** `bun run dev` → programs link (no GL error at `init`); grade at 1/1 looks unchanged.

---

### Task 2: Drive grade from HP in `game.ts`; remove CSS filter

**Files:** `game/game.ts`, `game/style.css`

- [ ] `game.ts`: add module state `let gradeSatCur = 1, gradeDimCur = 1;` (eased current values).
- [ ] `game.ts` `draw()`: **gate the grade advance on `state.running`** (the load-bearing fix — see Global Constraints). Only when running: compute the target from the same `cameraTarget` grade already used for blood — reuse `integrityGrade(Math.max(0,cb.hp)/cb.maxHp, CONFIG.horror.desatOnset, CONFIG.horror.desatGamma)` (call it once, share with the blood path). Then ease frame-rate-independently with the existing `ddt`:
      `if (state.running) {`
      `  const satT = 1 - cg * (1 - CONFIG.horror.desatFloor);`
      `  const dimT = 1 - cg * CONFIG.horror.desatDim;`
      `  const k = reducedMotion ? 1 : 1 - Math.exp(-CONFIG.horror.desatEaseRate * ddt);`
      `  gradeSatCur += (satT - gradeSatCur) * k; gradeDimCur += (dimT - gradeDimCur) * k;`
      `}`
      `R.setGrade(gradeSatCur, gradeDimCur);  // always push; held when not running`
      When not running the `cur` vars are left as-is (held), and endRun/toTitle have already snapped them to 1 — so debrief/title show full color, but a mere pause holds the current desaturation. **Do not** recompute the target off `cameraTarget` when not running (it returns a hp=0 corpse → max desat drain).
- [ ] **Fold the blood HP-drive into the same `state.running` gate.** The *existing* blood pass has the same latent shape — `draw()` recomputes `setBlood` from the corpse on game-over, so faint max blood already bleeds behind the ~0.82–0.96α debrief overlay in PR #32. Put the blood computation (`cb`/`bloodG`/`bLow`/`bPulse`/`setBlood`) inside the same `if (state.running) { … }` block as the grade; in the `else` path call `R.setBlood(0, 0, state.time)` so the pass is fully gated off (`flush` skips it at `bloodIntensity===0`). Both HP cues then switch off together on meta screens — one gate, no asymmetry. This also fixes the pre-existing PR #32 debrief-blood artifact.
- [ ] `config.ts`: add `desatEaseRate` to `CONFIG.horror` (e.g. `~12` → ≈0.25 s settle, matching the old CSS transition). Comment it.
- [ ] `game.ts` `updateHUD`: **remove** the `#game` CSS-filter block (the `cameraTarget`/`integrityGrade`/`filter`/`gameCanvas`/`lastFilter` lines that write `gameCanvas.style.filter`). The grade now lives entirely in `draw()`.
- [ ] `game.ts` `resetAtmosphere`: **replace** the `lastFilter=""` + `gameCanvas.style.filter=""` lines with `gradeSatCur = 1; gradeDimCur = 1;` (snap so a new run starts at full color). Also **reset `lastDrawT`** here (it currently isn't) so the first `draw()` of a fresh run — where `state.time` is back to 0 — doesn't compute a negative/garbage `ddt` (it clamps to 0, harmless for the lerp, but reset it for correctness alongside the other per-run render clocks).
- [ ] `game.ts` `endRun` and `toTitle`: **replace** the two filter-clear blocks with the same `gradeSatCur = 1; gradeDimCur = 1;` snap (bounds the grade to active gameplay; debrief/title/arsenal show full color). These two sites are what *own* the reset — `draw()` will then hold 1/1 on those screens.
- [ ] Delete the now-unused `gameCanvas`/`lastFilter` module vars and `el("game")` cache. **Verify with** `grep -n 'gameCanvas\|lastFilter\|el("game")' game/game.ts` returning empty (knip is CI-informational and won't catch a stray leftover).
- [ ] `style.css`: remove `transition: filter 0.25s ease-out;` from the `#game` rule (leave `display/width/height/cursor`).
- [ ] **Finding #2 (comment fix):** update the `flush()` trailing-blendFunc comment to state the accurate reason — the grid pass is blend-mode-independent (framebuffer auto-clears each frame since `preserveDrawingBuffer` is unset, and grid outputs `alpha=1`); the unconditional reset exists to make the end-of-`flush` blend state deterministic after the (optional) blood pass, not because the next grid pass depends on it.
- [ ] **Finding #4 (optional):** move the `reducedMotion` read into `resetAtmosphere()` so an OS toggle takes effect on the next run instead of only at page load. **Note:** `reducedMotion` is currently `const` and **shared with the blood clock** (`draw()` passes `reducedMotion ? 0 : state.time` to `setBlood`). Re-reading per run requires changing it to `let` — which also affects the blood freeze. Keep the single shared source (don't fork into two flags). Skip #4 entirely if not worth the churn.

**Verify:** `bun run typecheck` + `bun run test` (304 tests unchanged — `integrityGrade` untouched). `bun run dev`: grep-confirm no `el("game").style.filter` writes remain; run start/game-over/title all show full color; HP damage desaturates the world smoothly while the blood stays saturated.

---

## Playtest (after Task 2 — mandatory, not a code step)

- [ ] **Mid-HP readability:** HP 0.10–0.35, day and night — the blood vignette now reads (vivid) against a drained world; confirm this is a clear improvement over the pre-fix muddied blood.
- [ ] **Additive decision:** judge whether enemy eyes / muzzle flashes / toxic glow should desaturate with the world (grade applied) or stay vivid (saturate skipped on additive). Set the uniform accordingly.
- [ ] **Easing feel:** HP jumps ease over ~0.25 s (no pop, no smear); matches the old CSS transition cadence.
- [ ] **Run boundaries:** death → debrief, title, arsenal, and a fresh run all start at full color (no grade bleed-through behind the translucent overlay, no first-frame flash). Specifically check the game-over screen is NOT desaturated **and shows no blood** from the corpse's 0 HP (both cues share the running-gate — this also confirms the pre-existing PR #32 debrief-blood leak is gone).
- [ ] **Pause holds:** pausing at low HP keeps the world desaturated (does not snap back to full color); unpausing resumes.
- [ ] **Co-op spectate:** downed → camera follows a teammate; the world grades by *their* HP, easing on the target switch (not locked to the corpse). Watch the easing **smoothness on a client** — `state.time` (hence `ddt`) steps at snapshot rate, so the ease is coarser than host/single (same known limitation as the darts/dust). Confirm it's acceptable, not stuttery.
- [ ] **reduced-motion:** grade applies instantly (no ease); world still legible.
- [ ] Confirm single-player world at full HP is visually identical to `main`.
