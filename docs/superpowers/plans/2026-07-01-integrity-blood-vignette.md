# Integrity Blood Vignette (Shader) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a screen-space blood vignette (a final full-screen fragment-shader pass, HP-driven) so the player can *read* that they're taking damage — organic arterial red creeps in from the edges and churns, growing with damage; the near-death heartbeat throb is folded into this same layer (the DOM `#dread-pulse` is removed).

**Architecture:** A new `bloodProg` shader program draws one full-screen triangle (reusing the existing grid VAO) last in `flush()`, alpha-over on top of everything. `game.ts draw()` computes an HP grade (reusing the pure `integrityGrade`) from `cameraTarget` plus a heartbeat throb from the local player, and pushes them via a new `Renderer.setBlood(intensity, pulse, time)` (mirroring `setLightParams`). Render-only — reads `state` read-only, draws pixels — so the sim stays byte-for-byte and no net code is touched, matching the existing render-side FX (darts/dust/flicker).

**Tech Stack:** WebGL2 (GLSL ES 3.00, `?raw`-imported shaders), TypeScript strict + `noUncheckedIndexedAccess`, Vite, Bun, Vitest, Biome. CSS in `game/style.css`.

Spec: `docs/superpowers/specs/2026-07-01-integrity-blood-vignette-design.md`

## Global Constraints

- **Single-player byte-for-byte; net code untouched.** The blood pass is render-only, driven from a read-only `Renderer.setBlood(...)` call reading `cameraTarget(state)` (== `localPlayer` while alive / single-player), `state.time`, and the existing `beatStrength`/`lastBeatT`. No change to `state`, the sim (`update`), `sysFx`/`sysAI`, snapshots, or `game/net/`.
- **Instanced pipeline & existing passes untouched.** No change to `FLOATS`, the instance layout/attributes, the background/normal/additive passes, `setLightParams`/`beginLights`/`addLight`, or `lightAt`. The blood is a new, separate final pass.
- **Data-driven.** HP-facing knobs live in `CONFIG.horror` (`bloodOnset`/`bloodGamma`/`bloodMax`); shader-internal noise constants live in the shader with a comment. Reuse the pure `integrityGrade` — no new pure function, no new unit test.
- **`blood.frag` must declare `precision highp float;`** (not `mediump`) — `u_time` grows unbounded and `mediump` breaks `sin`/noise within minutes. Do **not** wrap `u_time`.
- **GL state hygiene:** the blood pass must `useProgram(bloodProg)`, bind the grid VAO, set `blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)`; and `flush` must reset `blendFunc` to that default at the end regardless of whether the pass ran.
- **Fold in `#dread-pulse`:** the heartbeat throb becomes the shader's `u_pulse` term; the DOM `#dread-pulse` element/CSS/opacity-write are removed. The heartbeat *audio* and `beatStrength`/`lastBeatT` bookkeeping are unchanged.
- **Accessibility:** honor `prefers-reduced-motion` by passing a constant clock (freeze churn/breathe); blood must read by area+motion, not hue alone.
- **Branch/commits:** work is on `feat/integrity-diegetic-feedback` (already checked out). Commit messages end with the repository footer (Co-Authored-By: Claude Opus 4.8 (1M context) + Claude-Session lines).
- **Quality gates:** pre-commit runs `biome check --write` on staged files; pre-push runs `bun run typecheck` + `bun run test`. Keep both green. `?raw` does not compile GLSL at build time — shader validity is confirmed by launching `bun run dev` (the program links at `init` or throws).

## File structure

- **Create** `game/engine/shaders/blood.vert` — clip passthrough (identical to `grid.vert`, attribute location 0).
- **Create** `game/engine/shaders/blood.frag` — procedural blood vignette.
- **Modify** `game/engine/renderer.ts` — import blood shaders; `bloodProg` + uniform locations in `init`; module state `bloodIntensity`/`bloodPulse`/`bloodTime`; `setBlood` setter; blood pass + blendFunc reset in `flush`; export `setBlood`.
- **Modify** `game/config.ts` — `CONFIG.horror` blood keys.
- **Modify** `game/game.ts` — `reducedMotion` const; `setBlood` call in `draw()` before `R.flush`; remove the `#dread-pulse` block in `updateHUD`.
- **Modify** `index.html` — remove the `#dread-pulse` div.
- **Modify** `game/style.css` — remove the `#dread-pulse` comment + rule.

---

### Task 1: Renderer blood pass (shaders + plumbing)

**Files:**
- Create: `game/engine/shaders/blood.vert`
- Create: `game/engine/shaders/blood.frag`
- Modify: `game/engine/renderer.ts` (imports ~`:2-5`; module decls ~`:12-53`; `init` ~`:135-152`; `flush` ~`:413-447`; `Renderer` export `:453-472`)

**Interfaces:**
- Consumes: nothing from other tasks. Uses existing `program()`, `gridVAO`, `viewHalfX`/`viewHalfY`.
- Produces: `Renderer.setBlood(intensity: number, pulse: number, time: number): void` — stores the three values; the blood pass in `flush` renders them. `intensity` 0 skips the pass entirely. Consumed by Task 2.

- [ ] **Step 1: Create `blood.vert`** (identical to `grid.vert` so it reuses attribute location 0)

`game/engine/shaders/blood.vert`:
```glsl
#version 300 es
layout(location=0) in vec2 a_p;
out vec2 v_clip;
void main(){ v_clip=a_p; gl_Position=vec4(a_p,0.0,1.0); }
```

- [ ] **Step 2: Create `blood.frag`** (procedural organic blood; `highp` required)

`game/engine/shaders/blood.frag`:
```glsl
#version 300 es
precision highp float; // REQUIRED: u_time grows unbounded; mediump breaks sin/noise in minutes
in vec2 v_clip;        // NDC ~[-1,1] over the visible screen
uniform float u_blood; // 0 (full HP) .. 1 (death): the HP creep
uniform float u_pulse; // 0..1 heartbeat throb (folded-in #dread-pulse); 0 above lowHp
uniform float u_time;  // churn/breathe clock (0 when prefers-reduced-motion)
uniform vec2  u_half;  // world half-extent → aspect = u_half.x / u_half.y
out vec4 outColor;

float hash(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){ // 3 octaves, fixed (no u_blood-dependent branching → no GPU divergence)
  float s = 0.0, amp = 0.5;
  for(int i = 0; i < 3; i++){ s += amp * vnoise(p); p *= 2.0; amp *= 0.5; }
  return s;
}

void main(){
  float aspect = u_half.x / max(u_half.y, 1e-3);
  vec2 nc = vec2(v_clip.x * aspect, v_clip.y);      // aspect-corrected so blobs aren't stretched
  float edge = max(abs(v_clip.x), abs(v_clip.y));   // 0 center → 1 screen edge (rectangular hug)

  // one domain-warp step, drifting with time → organic, non-radial, churning boundary
  vec2 wc = nc * 2.5 + vec2(fbm(nc * 1.7 + u_time * 0.05), u_time * 0.15);
  float n = fbm(wc);
  float warpedEdge = edge + (n - 0.5) * 0.35;

  // creep: higher drive pushes the blood further in. HP + a heartbeat throb push, one layer.
  float drive = clamp(u_blood + u_pulse * 0.35, 0.0, 1.0);
  float threshold = mix(1.05, 0.35, drive);
  float shape = smoothstep(threshold, threshold + 0.35, warpedEdge);

  float breathe = 1.0 + 0.14 * sin(u_time * 3.14159); // undulation (static when u_time==0)
  vec3 bloodCol = mix(vec3(0.55, 0.0, 0.0), vec3(0.75, 0.06, 0.06), n); // arterial, varied
  float a = clamp(shape * drive * breathe, 0.0, 0.85);
  outColor = vec4(bloodCol, a);
}
```

- [ ] **Step 3: Import the blood shaders in `renderer.ts`**

After the existing shader imports (`renderer.ts:2-5`), add:
```ts
import bloodFrag from "./shaders/blood.frag?raw";
import bloodVert from "./shaders/blood.vert?raw";
```

- [ ] **Step 4: Declare the blood program, uniform locations, and state**

In the module-scope declarations (near `renderer.ts:15-16` for programs and `:48-53` for state), add:
```ts
let bloodProg: WebGLProgram;
let b_blood: WebGLUniformLocation | null;
let b_pulse: WebGLUniformLocation | null;
let b_time: WebGLUniformLocation | null;
let b_half: WebGLUniformLocation | null;
let bloodIntensity = 0;
let bloodPulse = 0;
let bloodTime = 0;
```

- [ ] **Step 5: Compile the blood program in `init`**

In `init`, after the `gridVAO` setup block ends (`renderer.ts:152`, right after `gl.bindVertexArray(null);` for the grid), add:
```ts
  bloodProg = program(bloodVert, bloodFrag);
  b_blood = gl.getUniformLocation(bloodProg, "u_blood");
  b_pulse = gl.getUniformLocation(bloodProg, "u_pulse");
  b_time = gl.getUniformLocation(bloodProg, "u_time");
  b_half = gl.getUniformLocation(bloodProg, "u_half");
```

- [ ] **Step 6: Add the `setBlood` setter**

Near `setLightParams` (after `renderer.ts:187`), add:
```ts
/** HP-driven blood vignette: intensity (0..1 HP creep), pulse (0..1 heartbeat throb), time
 *  (churn/breathe clock; pass 0 to freeze for prefers-reduced-motion). Render-only. */
function setBlood(intensity: number, pulse: number, time: number): void {
  bloodIntensity = intensity;
  bloodPulse = pulse;
  bloodTime = time;
}
```

- [ ] **Step 7: Draw the blood pass + reset blend state in `flush`**

In `flush`, replace the final `gl.bindVertexArray(null);` (`renderer.ts:446`) with:
```ts
  // blood vignette (HP-driven, render-only): final full-screen pass, alpha-over on top of all.
  if (bloodIntensity > 0) {
    gl.useProgram(bloodProg);
    gl.uniform1f(b_blood, bloodIntensity);
    gl.uniform1f(b_pulse, bloodPulse);
    gl.uniform1f(b_time, bloodTime);
    gl.uniform2f(b_half, viewHalfX, viewHalfY);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(gridVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // always leave flush in the default blend state (additive left SRC_ALPHA,ONE; the next
  // frame's grid pass sets no blendFunc and relies on this being the alpha-over default).
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(null);
```

- [ ] **Step 8: Export `setBlood`**

In the `Renderer` export object (`renderer.ts:453-472`), add `setBlood,` (e.g. after `addLight,`).

- [ ] **Step 9: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: both PASS, no unused-variable errors (all new decls are used).

- [ ] **Step 10: Build**

Run: `bun run build`
Expected: `tsc --noEmit` clean + `vite build` writes `dist/` (note: this bundles the shader strings but does NOT compile GLSL — runtime link is verified in Task 2's playtest).

- [ ] **Step 11: Commit**

```bash
git add game/engine/shaders/blood.vert game/engine/shaders/blood.frag game/engine/renderer.ts
git commit -m "feat(fx): add HP-driven blood-vignette shader pass to the renderer

New bloodProg draws one full-screen triangle last in flush(), alpha-over on
top of everything, gated on setBlood intensity>0. Procedural fbm+domain-warp
gives organic churning blood from the edges; u_pulse folds in the heartbeat
throb. highp precision (u_time is unbounded). flush now always resets blendFunc
to the alpha-over default. Instanced pipeline / existing passes untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 2: Wire HP → blood in `game.ts` + CONFIG, fold in `#dread-pulse`

**Files:**
- Modify: `game/config.ts` (`CONFIG.horror`, after `desatGamma`)
- Modify: `game/game.ts` (module-scope `reducedMotion`; `draw()` before `R.flush` at `:620`; remove the `#dread-pulse` block in `updateHUD` at `:1007-1011`)
- Modify: `index.html` (remove `#dread-pulse` div, `:12`)
- Modify: `game/style.css` (remove the `#dread-pulse` comment + rule, `:44-53`)

**Interfaces:**
- Consumes: `Renderer.setBlood(intensity, pulse, time)` (Task 1); `integrityGrade(hpFrac, onset, gamma)` and `cameraTarget(state)` (already imported in `game.ts`); existing module vars `beatStrength`/`lastBeatT`.
- Produces: nothing for later tasks.

- [ ] **Step 1: Add CONFIG keys**

In `game/config.ts`, inside `CONFIG.horror`, immediately after the `desatGamma: …` line, add:
```ts
    // HP→blood vignette (shader pass): organic arterial red that creeps in from the edges and
    // churns as HP drops — the readable "you're bleeding" cue. Reuses integrityGrade. The
    // heartbeat throb is folded into the same shader (u_pulse). Shader-internal noise/breathe
    // constants live in blood.frag.
    bloodOnset: 0.85, // hp fraction at/above which no blood shows (starts early so damage reads)
    bloodGamma: 0.6, // <1 front-loads: mid-HP bleeding reads before the deep band
    bloodMax: 1.0, // scales the grade into u_blood; >1 also deepens the creep reach, not just opacity
```

- [ ] **Step 2: Add the `reducedMotion` module const in `game.ts`**

Near the other module-scope render-side state (after `renderer.ts`-style vars, e.g. after `let prevBattery = 1;` ~`game.ts:96`), add:
```ts
// honor the OS "reduce motion" setting: shaders can't read CSS media queries, so we freeze the
// blood churn/breathe by passing a constant clock (read once; guarded for non-DOM test env).
const reducedMotion =
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
```

- [ ] **Step 3: Push HP → blood in `draw()`**

In `game/game.ts` `draw()`, immediately before `R.flush(camX, camY);` (`:620`), add:
```ts
  // blood vignette (Spec ③ follow-up): readable HP readout. Creep from the camera-followed
  // player's HP (== local player in SP) + heartbeat throb folded in from the old #dread-pulse
  // (local player's own beat). Render-only → single-player byte-for-byte, net untouched.
  const cb = cameraTarget(state);
  const bloodG = integrityGrade(
    Math.max(0, cb.hp) / cb.maxHp,
    CONFIG.horror.bloodOnset,
    CONFIG.horror.bloodGamma,
  );
  const bLow = lp.hp / lp.maxHp < CONFIG.horror.lowHp;
  const bPulse = bLow ? beatStrength * Math.exp(-(state.time - lastBeatT) * 7) : 0;
  R.setBlood(bloodG * CONFIG.horror.bloodMax, bPulse, reducedMotion ? 0 : state.time);
```
(`lp` = `localPlayer(state)` is already defined at `draw()`'s top, `:393`.)

- [ ] **Step 4: Remove the `#dread-pulse` block from `updateHUD` (and its now-orphaned `hpf`)**

In `game/game.ts` `updateHUD`, delete the whole dread-pulse block (`:1007-1011`):
```ts
  // dread vignette intensity
  const low = hpf < CONFIG.horror.lowHp;
  // heartbeat-synced red pulse: a quick throb in time with the heartbeat audio (set in
  // audioAmbience). Decays from state.time so audio and visuals beat together.
  const pulse = low ? beatStrength * Math.exp(-(state.time - lastBeatT) * 7) : 0;
  el("dread-pulse").style.opacity = String(Math.min(0.5, pulse));
```
This was `hpf`'s only consumer in `updateHUD` (verified: `updateHUD`'s `const hpf = Math.max(0, p.hp) / p.maxHp;` at `:928` is used nowhere else — the other `hpf` uses at `:153/165/173/176` are in `audioAmbience`, a different function). So **also delete that `const hpf` line (`:928`)**, or `noUnusedLocals` fails typecheck. Keep `const p = localPlayer(state)` (used throughout `updateHUD` for weapon/ammo/medkits/money/downed). The throb now lives in `draw()` → the shader; `beatStrength`/`lastBeatT` stay, set by `audioAmbience`.

- [ ] **Step 5: Remove the `#dread-pulse` element**

In `index.html`, delete line `:12`:
```html
<div id="dread-pulse"></div>
```

- [ ] **Step 6: Remove the `#dread-pulse` CSS**

In `game/style.css`, delete the comment + rule (`:44-53`):
```css
/* heartbeat-synced dread pulse: a red inner vignette throbbing in time with the heartbeat
     (opacity driven from JS each frame, so NO transition here or it would smear the beat) */
#dread-pulse {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 1;
  opacity: 0;
  box-shadow: inset 0 0 200px 80px rgba(150, 0, 0, 0.55);
}
```

- [ ] **Step 7: Verify no dangling `#dread-pulse` references**

Run: `grep -rn "dread-pulse" game/ index.html`
Expected: only comment mentions remain (e.g. `game/config.ts` and `game/systems/integrity.ts` docstrings referring to the near-death alarm); **no `el("dread-pulse")`, no `#dread-pulse` element, no CSS rule.** (Those doc comments are about the heartbeat alarm in general and are harmless; leave them.)

- [ ] **Step 8: Typecheck, lint, test**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all PASS (304 tests unchanged; no unused-var errors; `reducedMotion` and the new `draw()` locals are all used).

- [ ] **Step 9: Build**

Run: `bun run build`
Expected: clean.

- [ ] **Step 10: Runtime smoke check (required — GLSL is only validated at runtime)**

Run: `bun run dev`, open the page. Expected: the game renders with **no GL compile/link error** in the browser console at startup (a GLSL typo in `blood.frag` throws from `program()` in `init` here — this is the only place shader validity is checked). Take damage and confirm red appears at the edges. (Full feel-tuning is the playtest below.)

- [ ] **Step 11: Commit**

```bash
git add game/config.ts game/game.ts index.html game/style.css
git commit -m "feat(fx): drive blood vignette from HP; fold #dread-pulse into the shader

draw() feeds Renderer.setBlood the cameraTarget HP grade (via integrityGrade,
bloodOnset/Gamma/Max in CONFIG.horror) + the heartbeat throb, freezing churn
for prefers-reduced-motion. Removes the DOM #dread-pulse (element/CSS/write) —
its throb is now the shader's u_pulse, so near-death shows one red edge, not
two. Render-only; single-player byte-for-byte, net untouched.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

## Playtest (after Task 2 — mandatory, not a code step)

Run `bun run dev`; verify by feel; tune `CONFIG.horror.blood*` and the `blood.frag` constants in-game:

- HP dropping is **clearly readable** — blood grows from the edges as you take damage (from `bloodOnset`).
- Blood looks **organic and churns** (not a clean ring); undulation isn't nauseating. With OS "reduce motion" on, churn/breathe freeze but the creep still reads.
- Full HP → no blood, clean screen; recovery (medkit / dawn revive) recedes the blood.
- **Near-death enemy visibility (hard gate):** surrounded at low HP, the drained world + the single red blood layer must NOT crush peripheral vision — you can still see approaching zombies. If not, dial back `bloodMax` / `desatDim` / the shader's `u_pulse` push.
- **Day vs night:** blood reads in both (dark red on near-black night edges; red over lit day ground).
- **Perf (incl. integrated GPU / laptop):** 60fps holds at the worst case (packed night horde while near death). Cost only appears below `bloodOnset` (pass skipped above).
- **Co-op:** a downed spectator's blood tracks the watched teammate's HP; the throb tracks the spectator's own heartbeat.

Not done until played and felt.
