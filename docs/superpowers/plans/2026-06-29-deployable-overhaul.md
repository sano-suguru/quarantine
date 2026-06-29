# Deployable Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hunter Drone a strong, ammo-budget-limited spike and Auto-Sentry a buffed permanent backbone, both scaling with the night so they stay relevant, and give deployables aimed searchlights with viewport-culled lighting.

**Architecture:** Pure helpers (damage scale, reserve/retire, light selection) are unit-tested; they wire into the existing `sysDeployables` tick, the snapshot, the draw pass, and the lighting shaders. No new system; capability blocks (`weapon.ammoBudget`, per-light cone) extend existing data-driven seams. Host-authoritative sim stays host-only; clients render synced display fields.

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess), Bun, Vite, Vitest, WebGL2 (GLSL via `?raw`), Biome.

## Global Constraints

- **Feel-first (CLAUDE.md):** movement/firing/lighting feel is **not done until playtested**. Only pure/deterministic code is unit-tested (per existing scope: `waveDef`, `scaledDmg`, math/geometry). Render/shader/feel tasks gate on `typecheck` + `build` + a manual playtest checklist, NOT fake unit tests.
- **Single-player must stay byte-identical** when touching co-op/snapshot code; systems never import net code.
- **Data-driven, zero special-case debt:** new behavior rides data tables (`src/data/`) + `CONFIG`; extend mechanisms, don't branch.
- **Wire-format change is breaking:** any snapshot byte-layout change requires `PROTOCOL_VERSION` bump + golden-test regeneration.
- **Removal convention:** arrays use swap-and-pop (order not preserved).
- Quality gate before each commit: `bun run typecheck` and `bun run lint` pass; `bun run test` passes for tasks with tests.

---

## File Structure

- `src/config.ts` — **Modify**: add `CONFIG.deployables` block (scaling + light tuning).
- `src/types.ts` — **Modify**: `DeployableDef.weapon.ammoBudget?`, `Deployable.reserveLeft?`/`ammoFrac?`, snapshot deployable struct `ammoFrac`.
- `src/data/deployables.ts` — **Modify**: drone/sentry weapon stats + drone `ammoBudget`; new pure helpers live in `src/systems/deployables.ts` (below).
- `src/systems/deployables.ts` — **Modify**: pure helpers (`deployDmgScale`, `reloadRefill`, `deployRetired`); wire scaling + reserve/retire into `tickWeapon`/`sysDeployables`; compute `ammoFrac`; removal-fx branch.
- `src/systems/deployables.test.ts` — **Create**: tests for the pure helpers.
- `src/net/net.ts` — **Modify**: `PROTOCOL_VERSION` 8→9.
- `src/net/snapshot.ts` — **Modify**: deployable struct + capture + apply + encode + decode for `ammoFrac`.
- `src/net/snapshot.test.ts` — **Modify**: regenerate the two goldens.
- `src/engine/lights.ts` — **Create**: pure `selectLights` (viewport cull + priority + budget) + `LightCandidate` type.
- `src/engine/lights.test.ts` — **Create**: tests for `selectLights`.
- `src/engine/renderer.ts` — **Modify**: `MAX_LIGHTS` 4→8; per-light cone arrays; extend `addLight`.
- `src/engine/shaders/instance.frag`, `src/engine/shaders/grid.frag` — **Modify**: `MAX_LIGHTS`; per-light cone uniform.
- `src/game.ts` — **Modify**: drone ammo-ring render; build light candidates + `selectLights` + `addLight`; removal fx.
- `src/net/client.ts` — **Modify**: re-derive RTB-vs-destroyed fx from snapshot diffs (co-op).

---

## Task 1: Night-curve damage scaling

**Files:**
- Modify: `src/config.ts` (add `CONFIG.deployables`)
- Modify: `src/systems/deployables.ts` (add `deployDmgScale`; apply at fire site)
- Test: `src/systems/deployables.test.ts` (create)

**Interfaces:**
- Produces: `deployDmgScale(phase: SiegePhase, day: number, perNight: number): number`
- Consumes: `CONFIG.deployables.dmgScalePerNight`

- [ ] **Step 1: Add CONFIG block.** In `src/config.ts`, add a top-level `deployables` block (place it after the `arsenal` block):

```ts
  deployables: {
    dmgScalePerNight: 0.1, // deployable dmg *(1 + day*this) at night — matches enemy hpScale
    lightIntensity: 0.45, // deployable searchlight brightness (player flashlight is ~1)
    lightRangeMul: 0.6, // deployable cone range as a fraction of the player flashlight range
    lightHalfAngle: 0.5, // deployable cone half-angle (rad); narrower than the player cone
  },
```

- [ ] **Step 2: Write the failing test.** Create `src/systems/deployables.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deployDmgScale } from "./deployables";

describe("deployDmgScale", () => {
  it("scales with the night number at night (matches enemy hpScale)", () => {
    expect(deployDmgScale("night", 1, 0.1)).toBeCloseTo(1.1);
    expect(deployDmgScale("night", 5, 0.1)).toBeCloseTo(1.5);
    expect(deployDmgScale("night", 10, 0.1)).toBeCloseTo(2.0);
  });
  it("does NOT scale during the day (roamers are base HP)", () => {
    expect(deployDmgScale("day", 1, 0.1)).toBe(1);
    expect(deployDmgScale("day", 10, 0.1)).toBe(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `bun run test -- src/systems/deployables.test.ts`
Expected: FAIL — `deployDmgScale` is not exported.

- [ ] **Step 4: Implement the helper.** In `src/systems/deployables.ts`, add near the top (after imports), exported:

```ts
/** Deployable damage multiplier. At night it tracks the enemy `hpScale` (= 1 + day*perNight) so a
 *  deployable's shots-to-kill ratio is preserved all run; during the day, roamers are base HP
 *  (hpScale 1) AND `state.day` already holds the upcoming night's number, so we return 1. */
export function deployDmgScale(phase: SiegePhase, day: number, perNight: number): number {
  return phase === "night" ? 1 + day * perNight : 1;
}
```

Ensure `SiegePhase` is imported: add it to the existing `import type { ... } from "../types";` line.

- [ ] **Step 5: Apply at the fire site.** In `tickWeapon` (`src/systems/deployables.ts`), the bullet is created with `dmg: w.dmg,` at **`deployables.ts:159`** (verified; `Bullet.dmg` is the field, `types.ts:188`). Compute the scaled damage just before the `state.bullets.push({...})` and use it for that field:

```ts
    const dmg = w.dmg * deployDmgScale(state.phase, state.day, CONFIG.deployables.dmgScalePerNight);
```

Replace `dmg: w.dmg,` with `dmg,` in the push. `CONFIG` is already imported. (No double-scaling: `sysBullets` applies `b.dmg` raw — `bullets.ts:41` `z.hp -= b.dmg` — with no extra multiplier.)

- [ ] **Step 6: Run tests + typecheck.**

Run: `bun run test -- src/systems/deployables.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit.**

```bash
git add src/config.ts src/systems/deployables.ts src/systems/deployables.test.ts
git commit -m "feat(deployables): night-curve damage scaling (phase-gated)"
```

---

## Task 2: Retune drone/sentry stats + `ammoBudget` field

**Files:**
- Modify: `src/types.ts:301-308` (`DeployableDef.weapon`)
- Modify: `src/data/deployables.ts:46-55` (drone), `:34` (sentry)

**Interfaces:**
- Produces: `DeployableDef.weapon.ammoBudget?: number`
- Consumes: nothing (data only)

- [ ] **Step 1: Add the type field.** In `src/types.ts`, in the `weapon?: { ... }` block of `DeployableDef`, add:

```ts
    /** total rounds the unit will ever fire before retiring (RTB). Omitted = infinite (self-
     *  recharging magazine, e.g. the sentry). Reloads draw from this reserve. */
    ammoBudget?: number;
```

- [ ] **Step 2: Retune the drone + sentry data.** In `src/data/deployables.ts`:

Drone — replace its `weapon:` line with (active ~130 DPS night-1 base; sustained ~100; ammo budget 90):

```ts
    weapon: { range: 320, dmg: 26, bulletSpeed: 800, interval: 0.2, magSize: 24, reloadTime: 1.3, ammoBudget: 90 },
```

Sentry — replace its `weapon:` line (active ~55 DPS, sustained ~42; ~2× current; permanent, no budget):

```ts
    weapon: { range: 380, dmg: 22, bulletSpeed: 900, interval: 0.4, magSize: 18, reloadTime: 2.5 },
```

(Costs/caps unchanged: drone `cost 150`, `cap 2`; sentry as-is.)

- [ ] **Step 3: Typecheck + lint.**

Run: `bun run typecheck && bun run lint`
Expected: PASS (Biome may reflow the weapon object across lines — accept its formatting).

- [ ] **Step 4: Commit.**

```bash
git add src/types.ts src/data/deployables.ts
git commit -m "feat(deployables): retune drone(strong)+sentry(2x) stats, add ammoBudget field"
```

---

## Task 3: Finite ammo reserve + retirement

**Files:**
- Modify: `src/types.ts` (`Deployable` host-only `reserveLeft?`, synced `ammoFrac?`)
- Modify: `src/systems/deployables.ts` (`reloadRefill`, `deployRetired`; init in `placeDeployable`; wire `tickWeapon` reload + `sysDeployables` removal + `ammoFrac` compute)
- Test: `src/systems/deployables.test.ts`

**Interfaces:**
- Consumes: `DeployableDef.weapon.ammoBudget` (Task 2)
- Produces: `reloadRefill(reserveLeft: number, magSize: number): number`; `deployRetired(hasBudget: boolean, reserveLeft: number, ammoLeft: number): boolean`; `Deployable.reserveLeft`, `Deployable.ammoFrac`

- [ ] **Step 1: Add instance fields.** In `src/types.ts`, in the `Deployable` interface: under the host-only sim section add `reserveLeft?: number; /** host-only: rounds left before RTB (ammoBudget types) */`, and in the synced display section add `ammoFrac?: number; /** synced 0..1: remaining ammo for the ring (1 if infinite-reserve) */`.

- [ ] **Step 2: Write the failing tests.** Append to `src/systems/deployables.test.ts`:

```ts
import { deployRetired, reloadRefill } from "./deployables";

describe("reloadRefill", () => {
  it("refills a full magazine when the reserve covers it", () => {
    expect(reloadRefill(90, 24)).toBe(24);
  });
  it("refills only the remaining reserve on the last (partial) magazine", () => {
    expect(reloadRefill(10, 24)).toBe(10);
  });
  it("refills nothing when the reserve is empty", () => {
    expect(reloadRefill(0, 24)).toBe(0);
    expect(reloadRefill(-5, 24)).toBe(0);
  });
});

describe("deployRetired", () => {
  it("retires a budgeted unit only when reserve AND magazine are empty", () => {
    expect(deployRetired(true, 0, 0)).toBe(true);
    expect(deployRetired(true, 0, 3)).toBe(false); // still has rounds in the mag
    expect(deployRetired(true, 5, 0)).toBe(false); // still has reserve to reload
  });
  it("never retires an infinite-reserve unit (the sentry)", () => {
    expect(deployRetired(false, 0, 0)).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails.**

Run: `bun run test -- src/systems/deployables.test.ts`
Expected: FAIL — `reloadRefill`/`deployRetired` not exported.

- [ ] **Step 4: Implement the helpers.** In `src/systems/deployables.ts`, add exported:

```ts
/** Rounds to load into the magazine on reload, drawn from the finite reserve (clamped ≥ 0). */
export function reloadRefill(reserveLeft: number, magSize: number): number {
  return Math.min(magSize, Math.max(0, reserveLeft));
}

/** A budgeted unit retires (RTB) once it can neither fire nor reload: reserve and magazine empty.
 *  Infinite-reserve units (no ammoBudget) never retire this way. */
export function deployRetired(hasBudget: boolean, reserveLeft: number, ammoLeft: number): boolean {
  return hasBudget && reserveLeft <= 0 && ammoLeft <= 0;
}
```

- [ ] **Step 5: Initialise the reserve at placement.** In `placeDeployable` (`src/systems/deployables.ts:~145`), in the `if (def.weapon) { ... }` block, after setting `ammoLeft`, add:

```ts
    if (def.weapon.ammoBudget !== undefined) d.reserveLeft = def.weapon.ammoBudget;
```

- [ ] **Step 6: Draw reloads from the reserve.** In `tickWeapon`, the reload-complete branch does `d.ammoLeft = w.magSize;` at **`deployables.ts:137`** (verified). Replace that single assignment with reserve-aware refill:

```ts
      if (w.ammoBudget !== undefined) {
        const refill = reloadRefill(d.reserveLeft ?? 0, w.magSize ?? 0);
        d.ammoLeft = refill;
        d.reserveLeft = (d.reserveLeft ?? 0) - refill;
      } else {
        d.ammoLeft = w.magSize;
      }
```

- [ ] **Step 7: Compute `ammoFrac` + unified removal.** In `sysDeployables` (`deployables.ts:15-35`), `def` is already declared at `:19`; the destructible block at `:24-27` is `if (def.destructible) { tickDamage(...); if ((d.hp ?? 0) <= 0) dead.push(i); }` and the actual swap-pop is a **separate loop** (`:29-34`). Replace the `:24-27` block with a per-frame `ammoFrac` publish + a unified removal check (fx is added in Task 5 at this same site):

```ts
    if (def.destructible) tickDamage(state, d, def, dt);
    // remaining-ammo fraction for the client ring (reserve + current mag over full load; 1 if infinite)
    const w = def.weapon;
    d.ammoFrac =
      w?.ammoBudget !== undefined
        ? clamp(((d.reserveLeft ?? 0) + (d.ammoLeft ?? 0)) / (w.ammoBudget + (w.magSize ?? 0)), 0, 1)
        : 1;
    // removal: destroyed (hp<=0) OR retired (ammo budget spent)
    const destroyed = !!def.destructible && (d.hp ?? 0) <= 0;
    const retired = deployRetired(w?.ammoBudget !== undefined, d.reserveLeft ?? 0, d.ammoLeft ?? 0);
    if (destroyed || retired) dead.push(i);
```

`clamp` is already imported (`deployables.ts:2`). The swap-pop loop (`:29-34`) is unchanged.

- [ ] **Step 8: Run tests + typecheck.**

Run: `bun run test -- src/systems/deployables.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/types.ts src/systems/deployables.ts src/systems/deployables.test.ts
git commit -m "feat(deployables): finite ammo reserve + RTB-on-empty for the drone"
```

---

## Task 4: Snapshot `ammoFrac` + PROTOCOL_VERSION bump

**Files:**
- Modify: `src/net/net.ts:19` (`PROTOCOL_VERSION`)
- Modify: `src/net/snapshot.ts` (struct `:126-133`, capture `:208-215`, apply `:395-412`, encode `:599-609`, decode loop)
- Test: `src/net/snapshot.test.ts` (add an `ammoFrac` round-trip assertion to the deployable round-trip test, ~`:160-200`; the byte-layout golden `:118` is **unaffected** — it encodes zero deployables)

**Interfaces:**
- Consumes: `Deployable.ammoFrac` (Task 3)
- Produces: snapshot deployable field `ammoFrac` over the wire

- [ ] **Step 1: Bump the protocol version.** In `src/net/net.ts`, change `export const PROTOCOL_VERSION = 8;` → `9`.

- [ ] **Step 2: Add the struct field.** In `src/net/snapshot.ts`, the `deployables: { ... }[]` snapshot type (`:126-133`): add `ammoFrac: number;` next to `hpFrac`/`reloading`.

- [ ] **Step 3: Capture it.** In `captureSnapshot` (`:208-215`), in the `deployables: state.deployables.map((d) => ({ ... }))`, add `ammoFrac: d.ammoFrac ?? 1,`.

- [ ] **Step 4: Apply it.** In `applySnapshot` (`:395-412`), set it on both the existing-object branch (`ex.ammoFrac = sd.ammoFrac;`) and the new-object literal (`ammoFrac: sd.ammoFrac,`).

- [ ] **Step 5: Encode it.** In `encode` (`:600-609`), after the status byte `w.u8((d.reloading ? 1 : 0) | (hp7 << 1));` add:

```ts
    w.u8(Math.round(Math.max(0, Math.min(1, d.ammoFrac)) * 255));
```

- [ ] **Step 6: Decode it.** In the deployable **decode loop** at **`snapshot.ts:748-766`** (mirrors the encode; reads `id/defId/x/y/aim/status`), after reading the status byte (the `hp7`/reload unpack), read and attach:

```ts
    const ammoFrac = r.u8() / 255;
```

and include `ammoFrac` in the pushed deployable object (alongside `hpFrac`, `reloading`).

- [ ] **Step 7: Add an `ammoFrac` round-trip assertion (the real regression guard).** The byte-layout golden (`snapshot.test.ts:98-120`) encodes **zero deployables** (`newState()` + 2 players, no deployable pushed — see its comment), so adding a per-deployable byte does **not** change `len=281`/fnv; it stays PASS. `PROTOCOL_VERSION` is not on the wire either, so it won't move the golden. The bump (Step 1) is therefore a **deliberate compatibility measure**, not a test-forced one (old↔new clients desync once a deployable is placed). To actually guard `ammoFrac`, extend the existing "round-trips placed deployables" test (~`:160-200`): push a **drone** with an `ammoFrac`, and assert it survives the round-trip:

```ts
    s.deployables.push({
      id: 79, defId: "drone", x: 0, y: 0, aim: 0, hpFrac: 1, reloading: false, ammoFrac: 0.5,
    });
    // ...after decode:
    const drone = back.deployables.find((d) => d.id === 79);
    expect(drone?.ammoFrac ?? 0).toBeCloseTo(0.5, 2); // 1-byte quantized
```

(The existing sentry/ammostation literals push **state `Deployable`** objects, where `ammoFrac?` is optional — they need no change; `captureSnapshot` defaults missing values to `1`.)

- [ ] **Step 8: Run snapshot tests + full check.**

Run: `bun run test -- src/net/snapshot.test.ts && bun run test && bun run typecheck`
Expected: PASS (byte-layout golden unchanged at `len=281`; new `ammoFrac` assertion passes).

- [ ] **Step 9: Commit.**

```bash
git add src/net/net.ts src/net/snapshot.ts src/net/snapshot.test.ts
git commit -m "feat(net): sync deployable ammoFrac; bump PROTOCOL_VERSION 8->9"
```

---

## Task 5: Drone ammo ring + RTB-vs-destroyed fx

**Files:**
- Modify: `src/game.ts` (drone draw block `:722-744`; removal fx)
- Modify: `src/systems/deployables.ts` (spawn distinct fx on removal in `sysDeployables`)
- Modify: `src/net/client.ts` (co-op: re-derive RTB vs destroyed from snapshot diffs)

**Interfaces:**
- Consumes: `Deployable.ammoFrac` (Task 3), the swap-pop removal (Task 3)
- Produces: visual only

> Feel task — no unit test (per Global Constraints). Gate = `typecheck` + `build` + playtest.

- [ ] **Step 1: Render the ammo ring.** In `src/game.ts`'s drone visual block (`:722-744`), replace the under-body scanner glow line with a remaining-ammo ring driven by `d.ammoFrac` (blinks when low). Keep the body-bob `by`:

```ts
      const af = d.ammoFrac ?? 1;
      const lowBlink = af < 0.2 ? 0.4 + 0.6 * Math.abs(Math.sin(state.time * 8)) : 1;
      R.glow(d.x, by, 18, r, g, b, (d.reloading ? 0.2 : 0.4) * lowBlink); // dimmed scanner
      R.ring(d.x, by, 13 * af + 3, r, g, b, 0.5 * lowBlink); // shrinks as ammo depletes
```

- [ ] **Step 2: Spawn distinct removal fx (host/single-player).** First add the import to `deployables.ts` (it is NOT currently imported — verified `:1-6`; other systems import `./fx`, so this is consistent):

```ts
import { fxImpact, fxKill } from "./fx";
```

Then, at the unified removal site written in Task 3 Step 7, branch the fx by cause. Use the **verified signatures**: `fxKill(state, x, y, color: RGB, glow: RGB, big: boolean)` (`fx.ts:105`) and `fxImpact(state, x, y, dir: number, color: RGB)` (`fx.ts:83`). `def` and `def.color` are in scope (`def` at `deployables.ts:19`; `color: [number,number,number]` matches `RGB`). Replace the `if (destroyed || retired) dead.push(i);` line with:

```ts
    if (destroyed || retired) {
      dead.push(i);
      if (destroyed) fxKill(state, d.x, d.y, def.color, def.color, true); // loud destruction burst
      else fxImpact(state, d.x, d.y, 0, def.color); // soft power-down on RTB
    }
```

(There is no `r,g,b` in scope — use `def.color` directly. The two cues are intentionally distinct; exact fx choice is tunable in playtest.)

- [ ] **Step 3: Co-op client re-derivation.** In `src/net/client.ts`, where the client diffs successive snapshots to re-derive fx (the existing hit/kill/hurt re-derivation), add deployable-removal handling: for each deployable id present last snapshot but absent now, pick the cue from its last-known fracs — `ammoFrac <= 0.02` → power-down cue; else (HP death) → destruction cue. Mirror the existing fx calls the client already uses for kills.

- [ ] **Step 4: Typecheck + build.**

Run: `bun run typecheck && bun run build`
Expected: PASS.

- [ ] **Step 5: Playtest checklist (single-player).** `bun run dev`, buy + deploy a drone at night:
  - Ring visibly shrinks as it fires; blinks when nearly empty.
  - On empty it RTBs with the soft power-down cue (NOT the destruction burst).
  - Kill a drone with zombies → loud destruction burst (distinct from RTB).

- [ ] **Step 6: Commit.**

```bash
git add src/game.ts src/systems/deployables.ts src/net/client.ts
git commit -m "feat(deployables): ammo ring + distinct RTB/destroyed fx"
```

---

## Task 6: Lighting model — MAX_LIGHTS 8 + per-light cone

**Files:**
- Modify: `src/engine/shaders/instance.frag:3,5-9,19-31`; `src/engine/shaders/grid.frag:3,5-9,20-30`
- Modify: `src/engine/renderer.ts:39-44` (arrays), `:167-197` (`setLightParams`/`addLight`), the uniform upload in `flush`

**Interfaces:**
- Produces: `addLight(x, y, ax, ay, intens, cosHalf?, range?)` (extended, backward-compatible defaults)
- Consumes: nothing new

> Engine task — no unit test. Gate = `typecheck` + `build` + playtest (players still lit exactly as before).

- [ ] **Step 1: Shader uniforms + per-light cone.** In BOTH `instance.frag` and `grid.frag`: change `#define MAX_LIGHTS 4` → `8`. Add a per-light cone uniform next to the existing light arrays:

```glsl
uniform vec2 u_lightCone[MAX_LIGHTS]; // per-light: x = cos(halfAngle), y = range
```

Inside the lighting loop, replace the shared `u_cone.x` (cos half-angle) and `u_cone.y` (range) usages with the per-light values; keep `u_cone.z` (ambient floor) shared:

```glsl
    float ca = dot(dir, u_lightAim[i]);
    float e = smoothstep(u_lightCone[i].x, mix(u_lightCone[i].x, 1.0, 0.35), ca);
    float reach = smoothstep(u_lightCone[i].y, u_lightCone[i].y * 0.25, dist);
```

(Apply the identical edit in both fragment shaders.)

- [ ] **Step 2: Renderer arrays + cap.** In `src/engine/renderer.ts`, change `const MAX_LIGHTS = 4;` → `8`. Add per-light cone storage next to `lightInt`:

```ts
const lightCone = new Float32Array(MAX_LIGHTS * 2); // [cosHalf, range] per light
```

- [ ] **Step 3: Extend `addLight` (backward compatible).** Change the signature + body so existing player calls (which pass 5 args) keep the shared flashlight cone:

```ts
function addLight(x: number, y: number, ax: number, ay: number, intens: number, cosHalf = coneCos, range = coneRange): void {
  if (lightCount >= MAX_LIGHTS) return;
  lightPos[lightCount * 2] = x;
  lightPos[lightCount * 2 + 1] = y;
  lightAim[lightCount * 2] = ax;
  lightAim[lightCount * 2 + 1] = ay;
  lightInt[lightCount] = intens;
  lightCone[lightCount * 2] = cosHalf;
  lightCone[lightCount * 2 + 1] = range;
  lightCount++;
}
```

- [ ] **Step 4: Upload the new uniform.** Get the uniform locations (next to the existing `u_lightPos`/`u_lightInt` lookups for both programs) and upload `lightCone` each frame where `lightPos`/`lightAim`/`lightInt` are uploaded (in `flush` for the instance program and in the grid draw for the grid program), e.g. `gl.uniform2fv(u_lightCone, lightCone);` (and `g_lightCone`).

- [ ] **Step 5: Typecheck + build.**

Run: `bun run typecheck && bun run build`
Expected: PASS (GLSL compiles).

- [ ] **Step 6: Playtest — no regression.** `bun run dev`: the player flashlight looks **identical** to before (same angle/range/brightness). Nothing else changes yet.

- [ ] **Step 7: Commit.**

```bash
git add src/engine/renderer.ts src/engine/shaders/instance.frag src/engine/shaders/grid.frag
git commit -m "feat(engine): MAX_LIGHTS 8 + per-light cone params (players unchanged)"
```

---

## Task 7: Deployable searchlights + viewport culling

**Files:**
- Create: `src/engine/lights.ts` (`LightCandidate`, `selectLights`)
- Create: `src/engine/lights.test.ts`
- Modify: `src/game.ts` (build candidates + `selectLights` + `addLight`)

**Interfaces:**
- Consumes: renderer `addLight(...,cosHalf,range)` (Task 6); `viewHalfX/Y` semantics (camera ± half = world view rect); `CONFIG.deployables` light tuning (Task 1)
- Produces: `LightCandidate` type; `selectLights(cands, camX, camY, halfX, halfY, max): LightCandidate[]`

- [ ] **Step 1: Write the failing tests.** Create `src/engine/lights.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type LightCandidate, selectLights } from "./lights";

const L = (over: Partial<LightCandidate>): LightCandidate => ({
  x: 0, y: 0, ax: 1, ay: 0, intens: 1, range: 100, cosHalf: 0.5, priority: 0, ...over,
});

describe("selectLights", () => {
  it("drops a light fully off-screen (cone can't reach the view)", () => {
    const off = L({ x: 5000, y: 0, range: 100 });
    expect(selectLights([off], 0, 0, 400, 300, 8)).toHaveLength(0);
  });
  it("keeps an off-screen origin whose range reaches into the view", () => {
    const near = L({ x: 460, y: 0, range: 100 }); // origin 60 past the right edge (400), range 100
    expect(selectLights([near], 0, 0, 400, 300, 8)).toHaveLength(1);
  });
  it("prioritizes players, then nearest-to-camera, within the budget", () => {
    const player = L({ x: 0, y: 0, priority: 1 });
    const far = L({ x: 200, y: 0, priority: 0 });
    const near = L({ x: 50, y: 0, priority: 0 });
    const kept = selectLights([far, near, player], 0, 0, 400, 300, 2);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBe(player); // player first
    expect(kept[1]).toBe(near); // then nearest of the rest
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

Run: `bun run test -- src/engine/lights.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `selectLights`.** Create `src/engine/lights.ts`:

```ts
/** A light the renderer could draw this frame. `priority` higher = kept first (players high). */
export interface LightCandidate {
  x: number;
  y: number;
  ax: number;
  ay: number;
  intens: number;
  range: number;
  cosHalf: number;
  priority: number;
}

/** circle (center, r) vs axis-aligned rect [cx±hx, cy±hy] (+ small margin) intersection. */
function reachesView(
  lx: number, ly: number, r: number,
  camX: number, camY: number, hx: number, hy: number,
): boolean {
  const margin = 24; // hysteresis so cones don't pop right at the screen edge
  const dx = Math.max(Math.abs(lx - camX) - (hx + margin), 0);
  const dy = Math.max(Math.abs(ly - camY) - (hy + margin), 0);
  return dx * dx + dy * dy <= r * r;
}

/** Two-stage light selection: (1) drop lights whose lit region can't reach the view; (2) if still
 *  over `max`, keep by priority then nearest-to-camera. Cost is thus bounded by `max` regardless of
 *  world light count. Returns the kept lights (input order is not preserved). */
export function selectLights(
  cands: LightCandidate[], camX: number, camY: number, hx: number, hy: number, max: number,
): LightCandidate[] {
  const visible = cands.filter((c) => reachesView(c.x, c.y, c.range, camX, camY, hx, hy));
  if (visible.length <= max) return visible;
  const d2 = (c: LightCandidate) => (c.x - camX) ** 2 + (c.y - camY) ** 2;
  visible.sort((a, b) => b.priority - a.priority || d2(a) - d2(b));
  return visible.slice(0, max);
}
```

- [ ] **Step 4: Run test to verify it passes.**

Run: `bun run test -- src/engine/lights.test.ts`
Expected: PASS.

- [ ] **Step 5a: Expose the light cap.** The renderer's view half-extents getter **already exists**: `worldToScreenHalf(): { x: number; y: number }` (`renderer.ts:432`, exported on the `Renderer` object `:453`) — reuse it, do NOT add a `viewHalf()`. Add one small getter to the `Renderer` export object: `maxLights: () => MAX_LIGHTS,`.

- [ ] **Step 5b: Wire into the draw pass.** In `src/game.ts` (`const R = Renderer`, `:377`; `camX`/`camY` computed at `:385-386`), replace the player-only light loop (`:399-411`) with a candidate build → `selectLights` → `addLight`. Build players (priority 1, shared flashlight cone) and weapon-bearing deployables (priority 0, dim/narrow cone):

```ts
  R.beginLights();
  const flc = CONFIG.flashlight;
  const dcfg = CONFIG.deployables;
  const { x: hx, y: hy } = R.worldToScreenHalf();
  const cands: LightCandidate[] = [];
  for (const pl of state.players) {
    if (pl.hp <= 0 || pl.absent) continue;
    const intensity = flashlightIntensity(
      pl.battery / flc.batteryMax, pl.lightOn, flc.lowThreshold,
      flc.flickerDepth, flc.baseFlickerDepth, flickerNoise(state.time, pl.id),
    );
    cands.push({ x: pl.x, y: pl.y, ax: Math.cos(pl.aim), ay: Math.sin(pl.aim), intens: intensity, range: flc.range, cosHalf: Math.cos(flc.halfAngle), priority: 1 });
  }
  for (const d of state.deployables) {
    if (!DEPLOYABLE_TYPES[d.defId]?.weapon) continue;
    cands.push({ x: d.x, y: d.y, ax: Math.cos(d.aim), ay: Math.sin(d.aim), intens: dcfg.lightIntensity * (d.reloading ? 0.6 : 1), range: flc.range * dcfg.lightRangeMul, cosHalf: Math.cos(dcfg.lightHalfAngle), priority: 0 });
  }
  for (const c of selectLights(cands, camX, camY, hx, hy, R.maxLights())) {
    R.addLight(c.x, c.y, c.ax, c.ay, c.intens, c.cosHalf, c.range);
  }
```

`flashlightIntensity` (imported `:25`), `flickerNoise` (local `:52`), and `DEPLOYABLE_TYPES` (imported `:10`) are all available. Add `import { selectLights, type LightCandidate } from "./engine/lights";` to `game.ts`.

- [ ] **Step 6: Tests + typecheck + build.**

Run: `bun run test && bun run typecheck && bun run build`
Expected: PASS.

- [ ] **Step 7: Playtest — lights appear & cull.** `bun run dev`: deploy sentries/drones at night → each casts a dim aimed cone tracking its target/travel; place many and pan the camera → off-screen ones don't light and frame time stays flat.

- [ ] **Step 8: Commit.**

```bash
git add src/engine/lights.ts src/engine/lights.test.ts src/engine/renderer.ts src/game.ts
git commit -m "feat(deployables): aimed searchlights with viewport-culled lighting"
```

---

## Task 8: Dread + perf tuning pass (playtest)

**Files:**
- Modify: `src/config.ts` (`CONFIG.deployables` light values), `src/data/deployables.ts` (stat numbers) — values only, as playtest dictates.

> Pure feel/perf task. No code structure change; only tuning constants. Gate = playtest sign-off.

- [ ] **Step 1: Dread check.** At night with full deployables on-screen, confirm the dark still dominates. If deployable cones flood the scene, lower `lightIntensity`, `lightRangeMul`, and/or `lightHalfAngle`. Record the chosen values.

- [ ] **Step 2: Perf check.** With `MAX_LIGHTS` cones on-screen (grid + instances) at target resolution, confirm no frame-time regression; verify panning past many off-screen deployables does not scale cost (viewport cull working). If the on-screen worst case regresses, lower `MAX_LIGHTS` and/or cap deployable cones below the player budget (e.g. reserve 4 slots for players, 4 for deployables).

- [ ] **Step 3: Balance check.** Drone reads as a strong spike that out-DPSes a player weapon for its budget; sentry stays a meaningful wall of fire at nights ~1 / ~8 / ~15 (relevance holds). Tune drone `dmg`/`ammoBudget`/`cost` and sentry `dmg`/`interval` as needed. Watch the lingering edge case (idle drones camping across nights).

- [ ] **Step 4: Commit the tuned values.**

```bash
git add src/config.ts src/data/deployables.ts
git commit -m "tune(deployables): dread/perf/balance playtest pass"
```

---

## Self-Review (completed)

- **Spec coverage:** §A → Task 1; §B drone stats/ammo → Tasks 2–3, ring/fx → Task 5; §C sentry → Task 2; §D reserve+sync → Tasks 3–4; §E lights → Tasks 6–7; perf/dread/balance playtest (§6/§7) → Tasks 5/7/8. Scope decision (§8a, integrated) honored — one plan, Tasks 1–4 (balance) before 6–7 (lights) so balance is independently testable first.
- **Placeholder scan:** pure-logic steps carry full code + tests; render/shader/feel steps name exact files/lines and show the key code, with playtest gates per Global Constraints (feel is not unit-tested by project rule).
- **Type consistency:** `deployDmgScale`/`reloadRefill`/`deployRetired` signatures match across Tasks 1/3 and their tests; `ammoBudget` (Task 2) consumed in Tasks 3–4; `ammoFrac` flows Deployable→capture→encode→decode→apply→draw (Tasks 3–5); `LightCandidate`/`selectLights` match between `lights.ts`, its test, and `game.ts` (Tasks 7); `addLight` extended signature (Task 6) used by Task 7.

## Review hardening (rubber-duck pass)

An independent code-level review verified every concrete snippet against the real source and caught (now fixed):
- **Task 5 fx wouldn't compile:** `fxImpact`/`fxKill` were not imported into `deployables.ts`; signatures were wrong (`fxKill` needs `color, glow, big`); `[r,g,b]` was undefined in scope. Fixed: import added, verified signatures, `def.color` used, fx folded into the unified-removal site whose real loop structure (collect `:24-27` / swap-pop `:29-34`) is now respected.
- **Task 4 golden premise was wrong:** the byte-layout golden encodes **zero deployables**, so `ammoFrac` doesn't move `len=281`/fnv and `PROTOCOL_VERSION` isn't on the wire. The bump is a deliberate compatibility step; the real regression guard is a new `ammoFrac` round-trip assertion.
- **Line-number drift corrected:** reload `:137`, bullet `dmg` `:159`, decode loop `:748-766`, `placeDeployable` `:145-149`; the "deployable pin" is an order-pin, not a byte golden.
- **Renderer duplication:** reuse the existing `worldToScreenHalf()` instead of adding `viewHalf()`; export object is `Renderer` (aliased `R` in `game.ts`).
- **Confirmed sound:** no double-scaling (`sysBullets` applies `b.dmg` raw); the client fx re-derivation pattern (`client.ts` `prev`/`effects`) genuinely exists for Task 5 Step 3.
