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

Add a **screen-space blood vignette**, rendered in the WebGL fragment shader as a final full-screen pass, driven by the camera-followed player's HP: as HP drops, organic arterial-red blood creeps in from the screen edges, growing in coverage and opacity and slowly churning (procedural noise) — a readable, visceral "you're bleeding / how hurt am I" cue. Desaturation stays as a supporting "drained" base layer; the heartbeat + `#dread-pulse` stay the near-death alarm.

**Why the shader (not a DOM overlay):** best perf (a fragment shader over the screen is GPU-cheap vs a full-screen CSS/SVG filter) and best feel (it renders *into the scene*, integrated with the flashlight lighting, not a "pasted-on" DOM layer). It uses genuine **procedural noise** (fbm / domain warp) rather than stacking CSS gradients to fake organic shapes — honoring the project principle "add the real procedural shape, don't fake by stacking primitives." It also lays the groundwork for Spec ④ (darkness/thermography), another screen-space pass.

**"Renderer untouched" is not violated in spirit.** Spec ③ kept the renderer untouched as a *scope/risk* choice for a small HUD change; it was never required for the hard constraint. The hard constraint is **single-player byte-for-byte at the simulation level** — and a *render-only* effect that reads `state` read-only and draws extra pixels never touches `update`/`state`, so the sim stays byte-identical. This is already an established pattern here: dust motes, darting shadows, and flashlight flicker are all render-only FX re-derived from `state` in `draw()`, single-player-safe. The blood pass joins that family.

## Non-goals (scope fence)

- **The sim, `state`, snapshots, and `game/net/` are untouched.** The blood pass is render-only, driven from a read-only `Renderer.setBlood(intensity, time)` call. Single-player stays byte-for-byte; co-op needs no new sync (each machine re-derives blood from its own view, like the other render-side FX).
- **The instanced sprite pipeline is untouched** — no change to `FLOATS`, the instance layout, the vertex/instance attributes, the existing background/normal/additive passes, or `setLightParams`/`addLight`. The blood is a *new, separate* full-screen pass.
- **Desaturation (`#game` CSS filter from Spec ③) stays** as the drained base layer (its code is unchanged; only its CONFIG values may be retuned in playtest). It is no longer the sole HP readout, so its subtlety is acceptable.
- **The heartbeat + `#dread-pulse` near-death alarm stays** (mechanism unchanged). See "Open question" below re: whether to later fold its throb into the shader.
- **No change to AI, spawns, HP values, the day/night clock, or the flashlight lighting math.** The blood pass reads the existing `u_half`/clip coords; it does not alter `lightAt`.

## Design

### A. New final full-screen pass in the renderer

`game/engine/renderer.ts`, in `flush(camX, camY)`, **after** the additive layer draw and **before** unbinding the VAO (~line 446): if blood intensity > 0, draw one full-screen pass with the new `bloodProg`, reusing the existing full-screen triangle buffer (`[-1,-1, 3,-1, -1,3]`) with `blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA)` (alpha-over, on top of everything). Skip the draw entirely when intensity is 0 (calm zone → zero cost).

New shaders (imported `?raw` like the others):
- `game/engine/shaders/blood.vert` — identical role to `grid.vert`: pass clip coords through as a varying (`v_clip`), emit `gl_Position`.
- `game/engine/shaders/blood.frag` — the procedural blood vignette (below).

New in `renderer.ts`:
- Compile `bloodProg = program(bloodVert, bloodFrag)` in `init()`; cache its uniform locations (`u_blood`, `u_time`, `u_half`).
- Module-scope state `let bloodIntensity = 0; let bloodTime = 0;` and a setter mirroring `setLightParams`:
  ```ts
  function setBlood(intensity: number, time: number): void {
    bloodIntensity = intensity;
    bloodTime = time;
  }
  ```
  Exposed on the `Renderer` export alongside `setLightParams`/`setFlashlight`.
- In `flush`, the blood pass uploads `u_blood = bloodIntensity`, `u_time = bloodTime`, `u_half = [viewHalfX, viewHalfY]` (already computed for the other passes; used only for aspect-correct noise, below).

### B. `blood.frag` — procedural organic blood (pseudocode)

```glsl
in vec2 v_clip;                 // NDC, ~[-1,1] over the visible screen
uniform float u_blood;          // 0 (full HP) .. 1 (death)
uniform float u_time;           // state.time, for churn + breathing
uniform vec2  u_half;           // world half-extent → aspect = u_half.x / u_half.y
out vec4 outColor;

// value-noise fbm (small; 3-4 octaves) + one domain-warp step for organic, non-radial edges
float fbm(vec2 p){ /* ... */ }

void main(){
  float aspect = u_half.x / max(u_half.y, 1e-3);
  vec2 nc = vec2(v_clip.x * aspect, v_clip.y);      // aspect-corrected so blobs aren't stretched
  float edge = max(abs(v_clip.x), abs(v_clip.y));   // 0 center → 1 screen edge (rectangular hug)

  // organic, churning boundary: warp the edge inward by noise that drifts with time
  float n = fbm(nc * 2.5 + vec2(0.0, u_time * 0.15));
  float warpedEdge = edge + (n - 0.5) * 0.35;

  // creep: as u_blood rises the blood reaches further in (threshold recedes toward center)
  float threshold = mix(1.05, 0.35, u_blood);
  float shape = smoothstep(threshold, threshold + 0.35, warpedEdge);

  // breathing (undulation): gentle opacity swing, only meaningful while hurt
  float breathe = 1.0 + 0.14 * sin(u_time * 3.14159) ;

  vec3  bloodCol = mix(vec3(0.55,0.0,0.0), vec3(0.75,0.06,0.06), n); // arterial, varied
  float a = clamp(shape * u_blood * breathe, 0.0, 0.85);
  outColor = vec4(bloodCol, a);
}
```

The exact fbm octaves, warp amount (`0.35`), noise frequency (`2.5`), drift speed (`0.15`), breathe amount/rate, threshold range, and colors are **feel constants tuned in playtest**. The HP-facing knobs (onset, curve, max opacity, breathe rate) are exposed in CONFIG (below); shader-internal noise constants may live in the shader with a comment.

### C. HP wiring (`game/game.ts` `draw()`) + CONFIG

In `draw()`, before `Renderer.flush(...)` (where lights are already set up), compute the blood grade from the camera-followed player and push it to the renderer — reusing the existing pure `integrityGrade`:

```ts
const cb = cameraTarget(state);
const bloodG = integrityGrade(
  Math.max(0, cb.hp) / cb.maxHp,
  CONFIG.horror.bloodOnset,
  CONFIG.horror.bloodGamma,
);
Renderer.setBlood(bloodG * CONFIG.horror.bloodMax, state.time);
```

`CONFIG.horror` additions:
```ts
bloodOnset: 0.85, // hp fraction at/above which no blood shows (starts early so damage reads)
bloodGamma: 0.6,  // <1 front-loads: mid-HP bleeding reads before the deep band
bloodMax: 1.0,    // scales the final intensity fed to the shader (headroom for playtest)
```
(`bloodMax` scales the 0..1 grade into the `u_blood` uniform; the shader's own `a` clamp caps final opacity. Breathe rate lives as a shader constant unless playtest wants it in CONFIG.)

HP-facing logic (onset/curve) stays in `game.ts`/CONFIG (data-driven); the shader only renders `u_blood`. `integrityGrade` is reused as-is — no new pure function, no new unit test.

### D. Relationship to existing layers

- **Desaturation base layer** (`#game` CSS filter): kept. If blood + desat reads as too much, retune `CONFIG.horror.desat*` down in playtest.
- **`#dread-pulse` heartbeat throb** (DOM, `< lowHp`): kept, layered above the blood. Both are red near death; if the overlap reads as excessive, the throb can later be folded into the shader as a heartbeat term on `u_blood`. **Open decision, deferred to playtest** (start with both; cut/merge if noisy).

## Single-player / co-op invariance

`Renderer.setBlood` is called from `draw()` with `cameraTarget(state).hp` (== `localPlayer` while alive / single-player) and `state.time` — both read-only. The blood pass draws pixels only; it never touches `update`, `state`, `sysFx`, `sysAI`, or snapshots. So **single-player stays byte-for-byte** and **no net code is touched**. In co-op each machine re-derives blood locally from its own camera view (a downed spectator bleeds by the teammate they watch), matching the established render-only FX pattern (darts/dust/flicker) — no snapshot field, no sync.

## Testing

- **Unit tests:** none new — the only pure logic (`integrityGrade`) is already tested (Spec ③). Shader output and feel are playtested, per the project's "renderer/feel is not unit-tested" scope.
- **Gates:** `bun run typecheck && bun run lint && bun run test` (304 pass, unchanged) → `bun run build` (shaders compile via `?raw`; confirm the new program links at runtime with no GL errors).
- **Feel verification (mandatory, `bun run dev`):** not done until played and felt.
  - HP dropping is now **clearly readable** — blood grows from the edges as you take damage (from `bloodOnset`).
  - The blood looks **organic and churns** (not a clean ring); undulation isn't nauseating.
  - Full HP → no blood, clean screen; recovery (medkit / dawn revive) recedes the blood.
  - Near-death: blood + `#dread-pulse` + desaturation don't over-saturate to the point of hurting readability (decide the `#dread-pulse` fold-in question here).
  - **Perf:** 60fps holds with the extra pass, including a packed night horde.
  - **Co-op:** a downed spectator's blood tracks the watched teammate's HP.

## Out of scope (future, Spec ④)

Darkness/visibility tuning and thermography — which can reuse this final full-screen pass as their foundation. Not touched here.
