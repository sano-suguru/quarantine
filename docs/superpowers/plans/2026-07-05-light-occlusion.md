# Light / Vision Occlusion by Walls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Walls block the flashlight/light so points behind a wall (relative to a light) fall to a separate, darker `shadowFloor` instead of the open-night ambient — fixing the "aim-through-buildings" stress and adding corner-dread.

**Architecture:** Pure render. Extend `lightAt(w)` in both fragment shaders (`grid.frag`, `instance.frag`) with a per-light ray-vs-wall occlusion test. Walls are static, uploaded once as a uniform array. A point lit by at least one unoccluded light keeps ambient; a point occluded from every light drops to `shadowFloor`. No sim/AI/synced state → single-player byte-for-byte safe, co-op unaffected.

**Tech Stack:** WebGL2 / GLSL ES 3.00, TypeScript, Vite (`?raw` shader imports), Bun, Vitest, Biome.

## Global Constraints

- **Pure render only.** No changes to `state`, sim, AI, snapshots, or economy. Walls come from the existing static `state.walls` (`state.ts:44`).
- **Two shaders stay in lockstep.** `lightAt` is duplicated in `grid.frag` and `instance.frag`; the occlusion additions must be identical in both.
- **Design source:** `docs/superpowers/specs/2026-07-05-light-occlusion-design.md`. Reconcile any ambiguity there.
- **Occluders = solid walls only** (`state.walls`). Barricades / boarded openings do NOT occlude (firing-slit). Openings are already absent from `state.walls`, so they leak light for free.
- **Numerical hygiene (non-negotiable):** intersection param `t ∈ (ε, 1−ε)` to avoid caster-edge acne; occlusion cross-products in **light-relative coords** with **`highp`** to avoid mediump shimmer.
- **Verification model:** shaders are not unit-tested (CLAUDE.md: renderer/feel validated by playtest). Each task ends with `bun run typecheck`, `bun run lint`, `bun run build`, and where noted a **playtest feel-gate**. The pure segment-intersection math is already covered by `geometry.test.ts` (the GLSL mirrors it).
- **Tuning in `CONFIG`**, never in systems/shaders as literals.
- Commit after each task. Branch already in use: `docs/stalker-foundations-specs` (or a fresh feature branch off it).

## File Structure

- `game/config.ts` — new tuning: `flashlight.shadowFloor`, `flashlight.occludeFloor` (fallback toggle).
- `game/engine/renderer.ts` — new uniforms `u_wall[]`, `u_wallCount`, `u_shadowFloor` (both programs) + `g_occludeFloor` (grid); `setWalls(walls)` (upload once, at startup); a `MAX_WALLS` constant. **Per-frame shadow-floor uniforms are set in `flush()`** (where `u_ambient`/`g_ambient` are actually set — `setLightParams` only mutates JS vars), **phase-blended** (night→dark, day→ambient) so daytime shadows don't go black.
- `game/engine/shaders/instance.frag` — occlusion helpers + occlusion inside `lightAt`; **personal pool stays unoccluded**.
- `game/engine/shaders/grid.frag` — identical occlusion helpers + `lightAt`, with the wall loop guarded by `u_occludeFloor` (a real loop-skip fallback, not just value-neutralizing).
- `game/game.ts` — call `R.setWalls(state.walls)` once after `newState()` / renderer init.

---

### Task 1: Config values + wall-uniform plumbing (no visual change yet)

Scaffold the uniforms and the one-time wall upload. Shaders declare the uniforms but don't use them, so the game looks identical — this task is a safe, reviewable base.

**Files:**
- Modify: `game/config.ts` (flashlight block)
- Modify: `game/engine/renderer.ts` (uniform locations for both programs, `setWalls`, `MAX_WALLS`, `setLightParams`)
- Modify: `game/engine/shaders/instance.frag` (declare uniforms only)
- Modify: `game/engine/shaders/grid.frag` (declare uniforms only)
- Modify: `game/game.ts` (call `setWalls` once)

**Interfaces:**
- Produces: `R.setWalls(walls: {x1:number,y1:number,x2:number,y2:number}[]): void`; GLSL uniforms `uniform vec4 u_wall[MAX_WALLS]`, `uniform int u_wallCount`, `uniform float u_shadowFloor` in both programs; `CONFIG.flashlight.shadowFloor:number`, `CONFIG.flashlight.occludeFloor:boolean`.

- [ ] **Step 1: Add config values.** In `game/config.ts`, inside the `flashlight` object, add:

```ts
shadowFloor: 0.02, // brightness of a wall-shadowed point (darker than nightAmbient so shadows truly hide)
occludeFloor: true, // occlude the floor (grid.frag) too; set false as a low-end perf fallback
```

- [ ] **Step 2: Declare the uniforms in both shaders (unused for now).** In `game/engine/shaders/instance.frag` and `game/engine/shaders/grid.frag`, next to the existing `uniform vec2 u_lightCone[MAX_LIGHTS];` line, add:

```glsl
#define MAX_WALLS 32
uniform vec4 u_wall[MAX_WALLS]; // static wall segments (x1,y1,x2,y2), world space
uniform int u_wallCount;
uniform float u_shadowFloor;    // floor brightness where occluded from every light (phase-blended, set CPU-side)
```

Additionally, in **`grid.frag` only**, add `uniform int u_occludeFloor;` (the runtime perf fallback — wired in Task 4). (An unused uniform in `instance.frag` would just be optimized away, so keep it grid-only.)

- [ ] **Step 3: Add uniform locations + MAX_WALLS in renderer.** In `game/engine/renderer.ts`, mirror exactly how `u_lightCone` is handled — declare module-level location vars for **both** programs (instance `u_*` and grid `g_*`): `u_wall`, `u_wallCount`, `u_shadowFloor`, `g_wall`, `g_wallCount`, `g_shadowFloor`, and `g_occludeFloor` (grid only). Add `const MAX_WALLS = 32;` near `MAX_LIGHTS`. In the two `getUniformLocation` blocks (instance ~L145-156, grid ~L174-183) add the corresponding `gl.getUniformLocation(prog, "u_wall")` etc. Add a module-level `const wallData = new Float32Array(MAX_WALLS * 4);` and `let wallCount = 0;`.

- [ ] **Step 4a: Implement `setWalls` (upload once).** In `renderer.ts`. This runs at startup only, so its `useProgram` switches don't touch the per-frame draw path:

```ts
/** upload the static wall segments once; occlusion reads them every frame (walls never change in a run) */
export function setWalls(walls: { x1: number; y1: number; x2: number; y2: number }[]): void {
  wallCount = Math.min(walls.length, MAX_WALLS);
  for (let i = 0; i < wallCount; i++) {
    const w = walls[i] as (typeof walls)[number];
    wallData[i * 4] = w.x1;
    wallData[i * 4 + 1] = w.y1;
    wallData[i * 4 + 2] = w.x2;
    wallData[i * 4 + 3] = w.y2;
  }
  gl.useProgram(instProg);
  gl.uniform4fv(u_wall, wallData);
  gl.uniform1i(u_wallCount, wallCount);
  gl.useProgram(gridProg);
  gl.uniform4fv(g_wall, wallData);
  gl.uniform1i(g_wallCount, wallCount);
}
```

Export `setWalls` from the module's public surface (same place `setLightParams`/`addLight` are exported).

- [ ] **Step 4b: Set `u_shadowFloor`/`g_shadowFloor` per frame — in `flush()`, NOT `setLightParams`.** *(Review correction: `setLightParams` only assigns JS module vars; the actual `gl.uniform1f(g_ambient/u_ambient, coneAmbient)` calls live in `flush()` — `renderer.ts:567` (grid block) and `renderer.ts:582` (instance block), which already `useProgram` each program. Set the shadow-floor uniforms there, relative to `u_ambient`, adding NO new `useProgram`.)*

The shadow floor must be **phase-blended**, not a fixed constant, or daytime wall-shadows go pure black (`coneAmbient` is ~0.55 by day, 0.1 by night, but a fixed `shadowFloor=0.02` would blacken day shadows — violating "gloom, not a void"). Compute it CPU-side where `coneAmbient` is known (top of `flush()`):

```ts
// night → shadowFloor (dark, truly hides); day → coneAmbient (no harsh daylight shadows)
const na = CONFIG.siege.nightAmbient; // confirm exact CONFIG paths for night/day ambient
const da = CONFIG.siege.dayAmbient;
const tPhase = Math.min(1, Math.max(0, (coneAmbient - na) / Math.max(1e-3, da - na)));
const shadowFloorNow = CONFIG.flashlight.shadowFloor + (coneAmbient - CONFIG.flashlight.shadowFloor) * tPhase;
```

Then in the grid block (next to `gl.uniform1f(g_ambient, coneAmbient)`):

```ts
gl.uniform1f(g_shadowFloor, shadowFloorNow);
gl.uniform1i(g_occludeFloor, CONFIG.flashlight.occludeFloor ? 1 : 0);
```

and in the instance block (next to `gl.uniform1f(u_ambient, coneAmbient)`):

```ts
gl.uniform1f(u_shadowFloor, shadowFloorNow);
```

*(Entities always occlude; only the floor has the `occludeFloor` toggle.)*

- [ ] **Step 5: Call `setWalls` after `state` is built.** In `game/game.ts`, once the renderer is initialized and `state` exists, call `R.setWalls(state.walls)`. Place it where `state` is (re)built — e.g. right after `newState()` / in `startGame` — so a **co-op client** (which builds its own `state` from the same static `map.ts`) also uploads its walls. Walls are identical every run (`map.ts` is fully static, no POI randomization), so re-calling on new-run/reconnect is harmless.

- [ ] **Step 6: Verify build + no visual change.**

Run: `bun run typecheck && bun run lint && bun run build`
Expected: all pass.
Then `bun run dev`, play a few seconds day+night. Expected: **identical** to before (uniforms declared but unused). Confirm no console GL errors.
*(Caveat: because the new uniforms are unused in this task, the compiler may optimize them out and `getUniformLocation` returns null — `gl.uniform*(null, …)` is a silent no-op, so this task can't actually verify the wiring works. That's fine: Task 2 is where the uniforms first take effect and get truly exercised. Task 1's only guarantee is "nothing broke.")*

- [ ] **Step 7: Commit.**

```bash
git add game/config.ts game/engine/renderer.ts game/engine/shaders/instance.frag game/engine/shaders/grid.frag game/game.ts
git commit -m "feat(occlusion): wall-uniform plumbing + shadowFloor config (no-op)"
```

---

### Task 2: Occlusion in `instance.frag` (entities/props go dark behind walls)

Add the GLSL occlusion helpers and wire them into `lightAt` for entities. This is where enemies/props behind a wall stop being visible.

**Files:**
- Modify: `game/engine/shaders/instance.frag` (helpers + `lightAt`)

**Interfaces:**
- Consumes: `u_wall`, `u_wallCount`, `u_shadowFloor`, existing `u_lightPos/u_lightCone/...`.
- Produces: GLSL `bool segCross(...)`, `float distToSeg(...)`, and an occlusion-aware `lightAt` (same signature `float lightAt(vec2 w)`).

- [ ] **Step 1: Add the two helper functions** above `lightAt` in `game/engine/shaders/instance.frag`:

```glsl
// distance from point p to segment a-b (world space; length-based, precision-robust)
float distToSeg(vec2 p, vec2 a, vec2 b){
  vec2 ab = b - a;
  vec2 ap = p - a;
  float t = clamp(dot(ap, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(ap - ab * t);
}

// does segment A(0,0)->B cross wall segment C->D, strictly interior to A->B?
// all args are LIGHT-RELATIVE (light at origin) and highp, to avoid mediump cancellation.
bool segCross(highp vec2 B, highp vec2 C, highp vec2 D){
  highp vec2 s = D - C;
  highp float rxs = B.x * s.y - B.y * s.x;      // B is the ray A->B with A=origin
  if(abs(rxs) < 1e-6) return false;             // parallel/collinear → ignore
  highp vec2 ac = C;                            // C - A, A = origin
  highp float t = (ac.x * s.y - ac.y * s.x) / rxs;   // param along A->B
  highp float u = (ac.x * B.y - ac.y * B.x) / rxs;   // param along C->D
  const float E = 0.01;                         // endpoint guard: no caster-edge acne
  return t > E && t < 1.0 - E && u >= 0.0 && u <= 1.0;
}
```

- [ ] **Step 2: Replace `lightAt`** in `instance.frag` with the occlusion-aware version:

```glsl
float lightAt(vec2 w){
  float best = 0.0;
  bool anyLOS = false;
  for(int i = 0; i < MAX_LIGHTS; i++){
    if(i >= u_lightCount) break;
    highp vec2 Lp = u_lightPos[i];
    highp vec2 d = w - Lp;
    float dist = length(d);
    float range = u_lightCone[i].y;

    // personal "feet" pool is NOT occluded (omni bubble; keeps the player's feet visible
    // even hugging a wall — occluding it makes the feet flicker to black). Count it first.
    float pool = smoothstep(u_personal.x, u_personal.x * 0.3, dist) * u_personal.y;
    best = max(best, pool);

    // occlusion: any wall between this light and w? gates the CONE only.
    bool blocked = false;
    for(int k = 0; k < MAX_WALLS; k++){
      if(k >= u_wallCount) break;
      vec4 seg = u_wall[k];
      if(distToSeg(Lp, seg.xy, seg.zw) > range) continue;         // early reject: wall beyond this light's reach
      if(segCross(d, seg.xy - Lp, seg.zw - Lp)){ blocked = true; break; }
    }
    if(blocked) continue;   // cone blocked here; pool already counted above
    anyLOS = true;

    vec2 dir = dist > 1e-3 ? d / dist : u_lightAim[i];
    float ca = dot(dir, u_lightAim[i]);
    float e = smoothstep(u_lightCone[i].x, mix(u_lightCone[i].x, 1.0, 0.35), ca);
    float reach = smoothstep(range, range * 0.25, dist);
    float cone = e * reach * u_lightInt[i];
    best = max(best, cone);
  }
  float floorLevel = anyLOS ? u_ambient : u_shadowFloor;   // any unblocked cone → gloom; behind every cone → dark
  return clamp(floorLevel + best, 0.0, 1.0);
}
```

- [ ] **Step 3: Build.**

Run: `bun run typecheck && bun run lint && bun run build`
Expected: pass (shader compiles; if GL logs a compile error at runtime, fix the GLSL before proceeding).

- [ ] **Step 4: Playtest feel-gate (entities).**

Run: `bun run dev`. At night, stand so a building is between you and a zombie.
Expected:
- the zombie **darkens to near-black behind the wall** (shadowFloor) and is revealed only with line of sight;
- **no black outline hugging wall edges** (ε guard working);
- **no shimmer/flicker** on shadow boundaries (highp working);
- **stand hugging a wall — your feet bubble stays lit, no flicker** (pool-not-occluded fix working);
- **additive/glow check:** muzzle flash, bullet tracers, and zombie eyes (`instance.frag:132` additive/`u_emissive` path) behind a wall dim slightly but don't vanish or bleed weirdly through the wall;
- the floor is unchanged for now (grid not yet occluded — a lit floor patch behind the wall is expected until Task 3).

- [ ] **Step 5: Commit.**

```bash
git add game/engine/shaders/instance.frag
git commit -m "feat(occlusion): walls occlude entity lighting (instance.frag)"
```

---

### Task 3: Occlusion in `grid.frag` (floor goes dark behind walls)

Mirror the identical helpers + `lightAt` change into the floor shader so a lit floor patch no longer shows behind a building.

**Files:**
- Modify: `game/engine/shaders/grid.frag`

**Interfaces:**
- Consumes: same uniforms (already declared in Task 1).
- Produces: identical `segCross`/`distToSeg`/occluding `lightAt` in `grid.frag`.

- [ ] **Step 1: Add the identical `distToSeg` and `segCross` helpers** above `lightAt` in `game/engine/shaders/grid.frag` (copy verbatim from Task 2 Step 1 — the two shaders must stay in lockstep).

- [ ] **Step 2: Replace `grid.frag`'s `lightAt`** with the identical occlusion-aware body from Task 2 Step 2 (same code; `grid.frag`'s `lightAt` has the same signature and uniforms).

- [ ] **Step 3: Build.**

Run: `bun run typecheck && bun run lint && bun run build`
Expected: pass.

- [ ] **Step 4: Playtest feel-gate (floor + consistency).**

Run: `bun run dev`. At night, sweep the flashlight past a building.
Expected: the **floor behind the building is dark** (no lit patch bleeding through), consistent with the darkened entities from Task 2; the **open night away from walls is still readable gloom** (ambient unchanged); the lit cone's crisp boundary is intact.

- [ ] **Step 5: Commit.**

```bash
git add game/engine/shaders/grid.frag
git commit -m "feat(occlusion): walls occlude floor lighting (grid.frag)"
```

---

### Task 4: Floor-occlusion fallback that actually skips the loop, + perf pass

The `g_occludeFloor` uniform is already set per frame (Task 1 Step 4b). Make it a **real** perf fallback: when disabled, `grid.frag` **skips the entire wall loop** (not just neutralizes the shadow value — the review showed neutralizing the value leaves the loop running, so it saves nothing). Because `u_occludeFloor` is a uniform, the branch is **coherent across all fragments** → GPU-cheap, no divergence.

**Files:**
- Modify: `game/engine/shaders/grid.frag` (guard the wall loop with `u_occludeFloor`)

**Interfaces:**
- Consumes: `g_occludeFloor` uniform (set in `flush()` from `CONFIG.flashlight.occludeFloor`, Task 1 Step 4b).
- Produces: floor occlusion that is genuinely free when disabled.

- [ ] **Step 1: Guard the wall loop in `grid.frag`'s `lightAt`.** Wrap the occlusion inner loop so it only runs when enabled — when off, `blocked` stays false, `anyLOS` becomes true everywhere, floor = ambient, and the loop cost disappears:

```glsl
    bool blocked = false;
    if(u_occludeFloor == 1){
      for(int k = 0; k < MAX_WALLS; k++){
        if(k >= u_wallCount) break;
        vec4 seg = u_wall[k];
        if(distToSeg(Lp, seg.xy, seg.zw) > range) continue;
        if(segCross(d, seg.xy - Lp, seg.zw - Lp)){ blocked = true; break; }
      }
    }
    if(blocked) continue;
```

*(instance.frag is unchanged — entities always occlude; only the full-screen floor pass, the dominant cost, is switchable.)*

- [ ] **Step 2: Build.**

Run: `bun run typecheck && bun run lint && bun run build`
Expected: pass.

- [ ] **Step 3: Perf playtest at the night cap.**

Run: `bun run dev`, reach a late night with the horde near `nightCapMax` (90). Open devtools Performance / FPS meter. Move so several lights (flashlight + any deployable searchlights) and many walls are on screen.
Expected: frame time holds (target 60 fps on desktop; note mobile separately). If it drops, flip `CONFIG.flashlight.occludeFloor = false` and re-measure to confirm the floor pass is the cost; record the finding in the spec's Open questions.

- [ ] **Step 4: Commit.**

```bash
git add game/engine/shaders/grid.frag
git commit -m "feat(occlusion): floor-occlusion loop-skip fallback + perf pass"
```

---

### Task 5: Tuning + full feel-gate sign-off

Dial `shadowFloor`/`nightAmbient` and run the spec's validation checklist. No new code unless a gate fails.

**Files:**
- Modify: `game/config.ts` (final `shadowFloor`, and `nightAmbient` only if the two-floor split needs rebalancing)

**Interfaces:** none new.

- [ ] **Step 1: Tune `shadowFloor`.** In `bun run dev`, adjust `CONFIG.flashlight.shadowFloor` (hot-reloads) until a zombie behind a wall reads as **hidden** (you don't feel tempted to shoot it) while the **open night stays readable gloom**. If open gloom now feels off, adjust `nightAmbient` independently (that's the whole point of splitting the floors). Land final values.

- [ ] **Step 2: Run the spec's feel-gate checklist** (from `2026-07-05-light-occlusion-design.md` §Validation):
  1. Aim-through-buildings stress gone (you stop shooting enemies you can't see)?
  2. Dark hiding spots at corners while open night stays readable?
  3. No caster-edge acne / no double-dark boundary / no shimmer?
  4. Deployable searchlights cast shadows too?
  5. Boarded-opening leak reads as intended (firing slit), not wrong?
  6. Perf holds at 90 cap?
  7. **Feet bubble** never flickers when hugging a wall (pool unoccluded)?
  8. **Daytime**: building shadows are *soft/absent*, not pure black (phase-blended shadowFloor working)?
  9. **Glow/tracer/eyes** behind walls dim but don't vanish or bleed (additive path)?

  Any "no" → fix (retune `shadowFloor`/phase blend, adjust ε, revisit floor toggle) before sign-off.

- [ ] **Step 3: Commit final tuning.**

```bash
git add game/config.ts
git commit -m "feat(occlusion): final shadowFloor/ambient tuning + feel-gate sign-off"
```

---

## Self-Review

**Spec coverage:** two-floor split (Tasks 1,2,3,5 — `shadowFloor` uniform + `anyLOS` logic) ✓; occlusion in both shaders (Tasks 2,3) ✓; walls-only occluders, openings leak free (Global Constraints + no barricade handling) ✓; static one-time upload (Task 1 `setWalls`) ✓; numerical hygiene ε + light-relative highp (Task 2 helpers) ✓; early range-reject (Task 2 `distToSeg` guard) ✓; count all lights incl. deployables (loop over `MAX_LIGHTS`, perf gate Task 4) ✓; floor-occlusion fallback (Task 4) ✓; pure-render/co-op safety (Global Constraints; no state/snapshot touched) ✓; validation checklist (Task 5) ✓. Soft shadows / barricade-occlusion / LOS-AI are correctly **out of scope** (deferred in spec).

**Placeholder scan:** no TBD/TODO; all shader and TS code is concrete. Renderer insertion points reference the existing `u_lightCone` pattern by name rather than fragile line numbers (the engineer mirrors a known-good example) — acceptable given the file's uniform-handling is uniform.

**Type/name consistency:** `setWalls`, `u_wall`/`g_wall`, `u_wallCount`/`g_wallCount`, `u_shadowFloor`/`g_shadowFloor`, `g_occludeFloor`, `segCross`, `distToSeg`, `MAX_WALLS`, `CONFIG.flashlight.shadowFloor`/`occludeFloor` used consistently across tasks. `segCross` signature `(highp vec2 B, highp vec2 C, highp vec2 D)` matches its call `segCross(d, seg.xy - Lp, seg.zw - Lp)`.

**Post-review corrections applied (rubber-duck):** (1) shadow-floor uniforms set in `flush()` not `setLightParams` (the latter only mutates JS vars); (2) `shadowFloor` phase-blended CPU-side so daytime shadows don't go black; (3) personal pool computed *before* the occlusion `continue` so feet don't flicker at walls; (4) `occludeFloor:false` now skips the whole grid wall loop (coherent uniform branch), a real perf fallback; (5) feel-gates added for feet-flicker, daytime shadows, and the additive glow/tracer path. GLSL crossing math, `highp` locals, uniform budget, and one-time static `setWalls` were verified sound and unchanged.
