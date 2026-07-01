# Integrity Blood Vignette (Shader) — Design

**Date:** 2026-07-01
**Status:** Approved (design); implementation pending
**Follow-up to Spec ③** (integrity de-tell). Playtest of Spec ③ revealed the HP readout is too subtle; this spec revises the *representation* while keeping Spec ③'s principle intact. Series: ① combat gore (#30), ② HUD de-tell (#31), ③ integrity de-tell (#32, this branch), ④ darkness & visibility (future).

## Principle (unchanged from the series)

Keep **control prompts**; push **state / fear / causality narration** off the HUD into experiential channels (color, sound, camera, light). No numbers, no meters — the player *feels* their vitality.

## Problem (why revise Spec ③)

Spec ③ removed the HP bar/number and moved the "how hurt am I" readout to a continuous world **desaturation + dimming** (a CSS `filter` on `#game`). Playtest verdict: **desaturation alone is too subtle** — global saturation/brightness changes are weak *change-detectors*, so the player can't tell HP is dropping until near death. That reopens the fairness concern Spec ③ set out to solve (you should feel how close to death you are).

Games that hide the HP bar solve this with **saturated, growing, pulsing/organic red at the screen edges** (Call of Duty's pulsing damage vignette; Bioshock's blood-on-the-lens; Left 4 Dead's near-death desaturation). The common thread: the red is *high-saturation, grows in area, and moves*. A faint static red edge — or global desaturation — is not enough.

## Goal

Add a **screen-space blood vignette**, rendered in the WebGL fragment shader as a final full-screen pass, driven by the camera-followed player's HP: as HP drops, organic arterial-red blood creeps in from the screen edges, growing in coverage and opacity and slowly churning (procedural noise) — a readable, visceral "you're bleeding / how hurt am I" cue. Desaturation stays as a supporting "drained" base layer; the near-death heartbeat throb is **folded into this one blood layer** (its `#dread-pulse` DOM twin removed) so near-death shows a single red edge, not two stacked ones (see D). The heartbeat *audio* is unchanged.

**Why the shader (not a DOM overlay):** best perf (a fragment shader over the screen is GPU-cheap vs a full-screen CSS/SVG filter) and best feel (it renders *into the scene*, integrated with the flashlight lighting, not a "pasted-on" DOM layer). It uses genuine **procedural noise** (fbm / domain warp) rather than stacking CSS gradients to fake organic shapes — honoring the project principle "add the real procedural shape, don't fake by stacking primitives." It also lays the groundwork for Spec ④ (darkness/thermography), another screen-space pass.

**"Renderer untouched" is not violated in spirit.** Spec ③ kept the renderer untouched as a *scope/risk* choice for a small HUD change; it was never required for the hard constraint. The hard constraint is **single-player byte-for-byte at the simulation level** — and a *render-only* effect that reads `state` read-only and draws extra pixels never touches `update`/`state`, so the sim stays byte-identical. This is already an established pattern here: dust motes, darting shadows, and flashlight flicker are all render-only FX re-derived from `state` in `draw()`, single-player-safe. The blood pass joins that family.

## Non-goals (scope fence)

- **The sim, `state`, snapshots, and `game/net/` are untouched.** The blood pass is render-only, driven from a read-only `Renderer.setBlood(intensity, time)` call. Single-player stays byte-for-byte; co-op needs no new sync (each machine re-derives blood from its own view, like the other render-side FX).
- **The instanced sprite pipeline is untouched** — no change to `FLOATS`, the instance layout, the vertex/instance attributes, the existing background/normal/additive passes, or `setLightParams`/`addLight`. The blood is a *new, separate* full-screen pass.
- **Desaturation (`#game` CSS filter from Spec ③) stays** as the drained base layer (its code is unchanged; only its CONFIG values may be retuned in playtest). It is no longer the sole HP readout, so its subtlety is acceptable.
- **The heartbeat *audio* stays** (Spec ③, unchanged). But the *visual* `#dread-pulse` DOM throb is **folded into the blood shader** (see D) and the `#dread-pulse` element/CSS/opacity-write are removed — so near-death shows **one** red edge layer (creep + heartbeat throb), not two overlapping ones. This is a deliberate change from Spec ③'s "keep `#dread-pulse`," made to protect peripheral enemy visibility when surrounded at low HP.
- **No change to AI, spawns, HP values, the day/night clock, or the flashlight lighting math.** The blood pass reads the existing `u_half`/clip coords; it does not alter `lightAt`.

## Design

### A. New final full-screen pass in the renderer

`game/engine/renderer.ts`, in `flush(camX, camY)`, **after** the additive layer draw and **before** unbinding the VAO (~line 446): if blood intensity > 0, draw one full-screen pass. The pass must, in order: `gl.useProgram(bloodProg)`, `gl.bindVertexArray(gridVao)` (the existing full-screen triangle VAO for `[-1,-1, 3,-1, -1,3]`), upload the uniforms, `gl.blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` (alpha-over, on top of everything), `gl.drawArrays(TRIANGLES, 0, 3)`. **Skip the whole block when intensity is 0** (calm zone → zero cost).

**GL state hygiene:** the additive layer leaves `blendFunc(SRC_ALPHA, ONE)`. After the blood pass, **reset `blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)`** so `flush` always ends in the default blend state regardless of whether the blood pass ran — this removes the current fragile implicit dependency (the next frame's grid pass sets no `blendFunc` and only works because its frag outputs `alpha = 1`). Depth test / face culling are unused, so no other state to restore.

New shaders (imported `?raw` like the others):
- `game/engine/shaders/blood.vert` — same as `grid.vert`: **`layout(location=0) in vec2 a_p;`** (required so the existing grid VAO's attribute-0 binding is reused as-is), pass clip coords through as varying `v_clip`, emit `gl_Position`.
- `game/engine/shaders/blood.frag` — the procedural blood vignette (below). **Must declare `precision highp float;`** (not the `mediump` that `grid.frag` uses) — see B for why.

New in `renderer.ts`:
- Compile `bloodProg = program(bloodVert, bloodFrag)` in `init()`; cache its uniform locations (`u_blood`, `u_pulse`, `u_time`, `u_half`).
- Module-scope state `let bloodIntensity = 0; let bloodPulse = 0; let bloodTime = 0;` and a setter mirroring `setLightParams`:
  ```ts
  function setBlood(intensity: number, pulse: number, time: number): void {
    bloodIntensity = intensity;
    bloodPulse = pulse; // heartbeat throb, folded in from the old #dread-pulse (see D)
    bloodTime = time;
  }
  ```
  Exposed on the `Renderer` export alongside `setLightParams`/`setFlashlight`.
- In `flush`, the blood pass uploads `u_blood = bloodIntensity`, `u_pulse = bloodPulse`, `u_time = bloodTime`, `u_half = [viewHalfX, viewHalfY]` (already computed for the other passes; used for aspect-correct noise, below).

### B. `blood.frag` — procedural organic blood (pseudocode)

```glsl
precision highp float;          // REQUIRED — see precision note below
in vec2 v_clip;                 // NDC, ~[-1,1] over the visible screen
uniform float u_blood;          // 0 (full HP) .. 1 (death) — the HP creep
uniform float u_pulse;          // 0..1 heartbeat throb (folded-in #dread-pulse), 0 above lowHp
uniform float u_time;           // churn/breathe clock (see reduced-motion note)
uniform vec2  u_half;           // world half-extent → aspect = u_half.x / u_half.y
out vec4 outColor;

// value-noise fbm (3 octaves) + one domain-warp step for organic, non-radial edges
float fbm(vec2 p){ /* ... */ }

void main(){
  float aspect = u_half.x / max(u_half.y, 1e-3);
  vec2 nc = vec2(v_clip.x * aspect, v_clip.y);      // aspect-corrected so blobs aren't stretched
  float edge = max(abs(v_clip.x), abs(v_clip.y));   // 0 center → 1 screen edge (rectangular hug)

  // organic, churning boundary: warp the edge inward by noise that drifts with time
  float n = fbm(nc * 2.5 + vec2(0.0, u_time * 0.15));
  float warpedEdge = edge + (n - 0.5) * 0.35;

  // creep: as u_blood rises the blood reaches further in (threshold recedes toward center).
  // the heartbeat throb (u_pulse) briefly pushes it further in too — one red layer, two sources.
  float drive = clamp(u_blood + u_pulse * 0.35, 0.0, 1.0);
  float threshold = mix(1.05, 0.35, drive);
  float shape = smoothstep(threshold, threshold + 0.35, warpedEdge);

  // breathing (undulation): gentle opacity swing, only meaningful while hurt
  float breathe = 1.0 + 0.14 * sin(u_time * 3.14159);

  vec3  bloodCol = mix(vec3(0.55,0.0,0.0), vec3(0.75,0.06,0.06), n); // arterial, varied
  float a = clamp(shape * drive * breathe, 0.0, 0.85);
  outColor = vec4(bloodCol, a);
}
```

**Precision (`highp`) is required.** `u_time` grows unbounded (`state.time` accumulates from 0). At `mediump` (what `grid.frag` uses) the `sin` phase and the noise drift offset lose resolution within minutes and the churn/breathe visibly steps or freezes. WebGL2 guarantees `highp` in fragment shaders, and `highp` f32 keeps sub-millisecond resolution for hours of play — so **do not** wrap `u_time` (wrapping the noise-drift coordinate would introduce a visible discontinuity at the wrap point); just use `highp`.

The exact fbm octaves (**3**, fixed — no `u_blood`-dependent branching, which would cause GPU divergence), warp amount (`0.35`), noise frequency (`2.5`), drift speed (`0.15`), breathe amount/rate, the `u_pulse` push (`0.35`), threshold range, and colors are **feel constants tuned in playtest**. The HP-facing knobs (onset, curve, max opacity) are exposed in CONFIG (below); shader-internal noise constants live in the shader with a comment.

**The blood reads by *area growth + motion*, not hue alone** (Spec ③'s desaturation and this layer must not rely solely on red being distinguishable — a red-deficient player still perceives the growing, moving coverage). This is the design reason blood beats a faint static red tint.

### C. HP wiring (`game/game.ts` `draw()`) + CONFIG

In `draw()`, before `Renderer.flush(...)` (where lights are already set up), compute the blood grade from the camera-followed player and the heartbeat throb, and push both to the renderer — reusing the existing pure `integrityGrade`:

```ts
const cb = cameraTarget(state);
const bloodG = integrityGrade(
  Math.max(0, cb.hp) / cb.maxHp,
  CONFIG.horror.bloodOnset,
  CONFIG.horror.bloodGamma,
);
// heartbeat throb, folded in from the old #dread-pulse: same formula that drove its opacity,
// from the local player's beatStrength/lastBeatT (set in audioAmbience). Local-player, not
// cameraTarget — a downed spectator hears/feels their own death heartbeat (Spec ③'s split).
const low = localPlayer(state).hp / localPlayer(state).maxHp < CONFIG.horror.lowHp;
const pulse = low ? beatStrength * Math.exp(-(state.time - lastBeatT) * 7) : 0;
// reduced-motion: freeze churn/breathe (shaders ignore CSS media queries) — pass a constant clock
const t = reducedMotion ? 0 : state.time;
Renderer.setBlood(bloodG * CONFIG.horror.bloodMax, pulse, t);
```

`reducedMotion` is a module-scope boolean set once from `matchMedia("(prefers-reduced-motion: reduce)").matches` (read at init in `main.ts`/`game.ts`); when true the blood still creeps + throbs by HP/heartbeat (opacity), but the noise churn and breathing are static.

`CONFIG.horror` additions:
```ts
bloodOnset: 0.85, // hp fraction at/above which no blood shows (starts early so damage reads)
bloodGamma: 0.6,  // <1 front-loads: mid-HP bleeding reads before the deep band
bloodMax: 1.0,    // scales the grade into u_blood (playtest headroom; >1 also deepens the creep
                  // reach via the threshold mix — not just opacity — so tune with that in mind)
```

`beatStrength`/`lastBeatT` are the existing module-scope vars (set in `audioAmbience`); this reuses them read-only. HP-facing logic (onset/curve/throb) stays in `game.ts`/CONFIG (data-driven); the shader only renders the uniforms. `integrityGrade` is reused as-is — no new pure function, no new unit test.

**Removal (folding in `#dread-pulse`):** delete the `#dread-pulse` opacity write in `updateHUD`, the `#dread-pulse` element in `index.html`, and its CSS rule in `style.css` (grep `dread-pulse` for the current locations). Keep the `low` boolean and `beatStrength`/`lastBeatT` bookkeeping — they now feed `pulse` above. The heartbeat *audio* is untouched.

### D. Relationship to existing layers

- **Desaturation base layer** (`#game` CSS filter, Spec ③): kept, code unchanged. It's the "drained" base under the blood. If blood + desat reads as too much near death, retune `CONFIG.horror.desat*` (esp. `desatDim`) down in playtest.
- **Heartbeat throb — folded into the blood shader** (the `u_pulse` term, C above). The DOM `#dread-pulse` element/CSS/opacity-write are **removed**; near-death now shows a single red edge layer that both creeps (HP) and throbs (heartbeat), instead of two overlapping red vignettes. This is the deliberate resolution of the "3 red/dark layers crush peripheral visibility when surrounded at low HP" risk — decided at design time rather than deferred, because two independent red edge layers are redundant by construction. The heartbeat *audio* is unchanged.
- **Layer order near death:** desaturation (drained base, via CSS filter on `#game`) → blood shader (creep + throb, in-canvas, on top of entities) → HUD/`#flash`/crosshair (DOM, above the canvas). The instant damage `#flash` still reads over the blood.

## Single-player / co-op invariance

`Renderer.setBlood` is called from `draw()` with `cameraTarget(state).hp` (== `localPlayer` while alive / single-player) and `state.time` — both read-only. The blood pass draws pixels only; it never touches `update`, `state`, `sysFx`, `sysAI`, or snapshots. So **single-player stays byte-for-byte** and **no net code is touched**. In co-op each machine re-derives blood locally from its own camera view (a downed spectator bleeds by the teammate they watch), matching the established render-only FX pattern (darts/dust/flicker) — no snapshot field, no sync.

## Testing

- **Unit tests:** none new — the only pure logic (`integrityGrade`) is already tested (Spec ③). Shader output and feel are playtested, per the project's "renderer/feel is not unit-tested" scope.
- **Gates:** `bun run typecheck && bun run lint && bun run test` (304 pass, unchanged) → `bun run build`.
- **Startup smoke check (required):** `?raw` imports the shaders as *strings* — the build does **not** compile GLSL, so a build pass proves nothing about shader validity. `program()` throws on compile/link failure only at runtime (`init`). So: launch `bun run dev` and **confirm the game renders with no GL compile/link error thrown at startup** (a GLSL typo surfaces here, not in `build`). This is the minimum shader smoke test.
- **Feel verification (mandatory, `bun run dev`):** not done until played and felt.
  - HP dropping is now **clearly readable** — blood grows from the edges as you take damage (from `bloodOnset`).
  - The blood looks **organic and churns** (not a clean ring); undulation isn't nauseating. With OS "reduce motion" on, the churn/breathe freeze but the creep still reads.
  - Full HP → no blood, clean screen; recovery (medkit / dawn revive) recedes the blood.
  - **Near-death enemy visibility (hard gate):** when surrounded at low HP, the drained (desaturated) world + the single red blood layer (creep + throb) must **not** crush peripheral vision — you must still be able to see approaching zombies. If it does, dial back `bloodMax` / `desatDim` / the throb push. (This is the risk the `#dread-pulse` fold-in was meant to reduce; verify it worked.)
  - **Day vs night:** blood must read in **both** — on the near-black night edges (dark red on dark) and in the bright day (red over lit ground). Take damage in each.
  - **Perf (incl. weak GPU):** 60fps holds with the extra pass at its worst case — a packed night horde while near death — on an **integrated GPU / laptop**, not just a discrete card. The pass is skipped entirely above `bloodOnset`, so cost only appears when hurt; confirm no dip then.
  - **Co-op:** a downed spectator's blood tracks the watched teammate's HP (the throb tracks the spectator's own heartbeat).

## Out of scope (future, Spec ④)

Darkness/visibility tuning and thermography — which can reuse this final full-screen pass as their foundation. Not touched here.
