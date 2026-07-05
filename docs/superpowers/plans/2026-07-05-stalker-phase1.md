# The Stalker — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A single, unkillable, noise-driven pursuer that hunts the player at night — advancing while it's in the dark, staggering when the flashlight touches it, drawn by noise, warded by a flick of light. Contact is a major scare; it retreats at dawn. The felt core of QUARANTINE's differentiator.

**Architecture:** An **independent host-side subsystem** — `state.stalker: Stalker | null` with its own `sysStalker(state, dt)` step (NOT in `state.zombies`, NOT in `sysAI`), so the crowd's de-overlap / bullet collision / kill-rederivation never touch it. It reuses the flashlight cone math and the merged `Player.noise` (Foundation 2b). A dedicated telegraph FX/audio layer sells the approach. A small dedicated snapshot block syncs it to co-op clients (host-authoritative).

**Tech Stack:** TypeScript (strict), Bun, Vite, Vitest, Biome, WebGL2.

## Global Constraints

- **Independent subsystem, not spliced into `sysAI`.** The Stalker is a single `state.stalker` slot with its own `sysStalker` step, deliberately excluded from `state.zombies` (so pass-2 de-overlap, bullet collision, and snapshot kill-rederivation cannot touch it). Host-authoritative; systems stay net-agnostic.
- **Unkillable in Phase 1** — only warded (light) and evaded (quiet/LOS). No bullet damage. Contact = a big scripted scare + withdraw, not chip damage.
- **Warding = cooldown stagger, not continuous drain.** A brief cone touch staggers/recoils it for a fixed lingering window; no need to hold the beam. Small CONFIG battery cost per ward, if any.
- **Noise attraction reads the merged `Player.noise`** (Foundation 2b, host-only per-player loudness from fire/run/rummage) — the Stalker biases toward the loudest/nearest living player. (The spec's "state.noise sources" became `Player.noise` in 2b; use that.)
- **No arcade text.** The grab/scare is diegetic only: view collapse + camera lurch + audio stinger + drag. No floating labels (consistent with the diegetic-feedback initiative).
- **Telegraph is a NEW dedicated module**, not overloaded onto the ambient dread. Phase-1 telegraph = the **real, localizable** footfall + cone flicker + heartbeat (the fair "heard before seen" cue). **Fake cues (false silhouettes) are Phase 1.5** — not in this plan.
- **Single-player must stay unbroken; co-op is host-authoritative** and gets a dedicated snapshot block (Task 5) — excluded from the id-disappearance = kill path; exit via an explicit withdraw event.
- **Sprite:** `game/assets/sprites/stalker.png` (128²) is already placed; add `"stalker"` to `REQUIRED_SPRITES`.
- Tuning in `CONFIG.stalker`. Stalker sim/feel is **not unit-tested** (playtested); pure helpers (if any) are tested. Commit per task; suite green before each commit.
- **Design source:** `docs/superpowers/specs/2026-07-05-stalker-core-design.md` (Phase 1 + "How it's built"). This plan implements Phase 1 core; **Phase 1.5** (fake cues, audio ducking polish, map geometry) and **Phase 2** (menace) are out.

## Deferred / autonomous defaults (validate at playtest)
- **First-arrival:** spawns once per night, at night start, far from players in an unlit spot. (Menace-driven escalation = Phase 2.)
- **Approach:** advances toward the loudest/nearest living player, routing around walls by sampling the existing `state.flow` field (reuse Foundation 2a) when available, else direct; it only *advances* while outside every living player's flashlight cone. Full "route to the least-watched opening" is **Phase 1.5**.
- **Co-op targeting:** loudest living player (by `Player.noise`), tie-break nearest; ignores downed/absent players.

## File Structure
- `game/types.ts` — `Stalker` interface; `State.stalker: Stalker | null`.
- `game/config.ts` — `CONFIG.stalker` (speeds, ranges, stagger window, contact damage, telegraph thresholds, spawn).
- `game/engine/spriteAssets.ts` — `REQUIRED_SPRITES += "stalker"`.
- `game/state.ts` — `stalker: null` in `newState()`.
- `game/systems/stalker.ts` (NEW) — `sysStalker(state, dt)`: spawn, state machine, motion, ward, contact, dawn-retreat. Plus `spawnStalker`/`despawnStalker` helpers.
- `game/game.ts` — call `sysStalker` in `update()`; draw the stalker in `draw()`; grab-scare presentation; telegraph hooks.
- `game/systems/stalkerFx.ts` (NEW) — telegraph: footfall audio (localizable), cone flicker signal, heartbeat; proximity×unlit driven.
- `game/net/snapshot.ts` — dedicated stalker block in capture/apply/encode/decode/lerp; withdraw event.
- `game/net/client.ts` — apply stalker block; play approach/withdraw cues; exclude from kill-rederive.

---

### Task 1: Types, CONFIG, sprite registration, empty slot (no behavior)

**Files:** `game/types.ts`, `game/config.ts`, `game/engine/spriteAssets.ts`, `game/state.ts`.

**Interfaces:**
- Produces: `interface Stalker { x:number; y:number; face:number; state:"lull"|"aggro"|"stagger"|"retreat"; staggerT:number; contactCd:number; vis:number }`; `State.stalker: Stalker | null`; `CONFIG.stalker`.

- [ ] **Step 1: `Stalker` type + state field.** In `game/types.ts` add the `Stalker` interface (above `State`) and `stalker: Stalker | null;` to `State`.
- [ ] **Step 2: CONFIG.** In `game/config.ts` add:
```ts
stalker: {
  spawnDist: 900,        // spawns this far from the target, in the dark
  advanceSpeed: 95,      // px/s while aggro in the dark
  staggerSpeed: 40,      // px/s backing off while staggered
  staggerWindow: 1.1,    // s the stagger lingers after the beam leaves
  wardConeGrace: 0.15,   // s of cone-touch needed to trigger a stagger
  contactDist: 34,
  contactDamage: 34,
  contactCd: 1.5,        // s before it can grab again
  retreatSpeed: 220,     // px/s leaving at dawn / after a grab
  noiseBias: 1.0,        // how strongly it steers toward the loudest player
  telegraphNear: 460,    // proximity where telegraph starts
},
```
- [ ] **Step 3: Sprite registration.** In `game/engine/spriteAssets.ts` add `"stalker"` to `REQUIRED_SPRITES`. (The 128² `stalker.png` is already in `game/assets/sprites/`.)
- [ ] **Step 4: Init slot.** In `game/state.ts` `newState()` add `stalker: null,`.
- [ ] **Step 5: Verify.** `bun run typecheck && bun run lint && bun run test` → green (nothing spawns/draws the stalker yet → no behavior change; the sprite loads via glob and the load gate now requires it, which is satisfied). `bun run build` too (sprite atlas).
- [ ] **Step 6: Commit.**
```bash
git add game/types.ts game/config.ts game/engine/spriteAssets.ts game/state.ts game/assets/sprites/stalker.png
git commit -m "feat(stalker): types, CONFIG, sprite registration, empty state slot"
```

---

### Task 2: `sysStalker` — spawn + motion state machine + contact + draw (single-player visible)

The core loop, host-side, visible in single-player. No telegraph/ward-polish/snapshot yet (Tasks 3–5).

**Files:** create `game/systems/stalker.ts`; modify `game/game.ts` (call in `update()`, draw in `draw()`).

**Interfaces:**
- Produces: `sysStalker(state: State, dt: number): void`; `spawnStalker(state)`; `despawnStalker(state)`.

- [ ] **Step 1: `sysStalker`.** Create `game/systems/stalker.ts` — `sysStalker(state, dt)` (per-frame update, assumes a stalker exists), plus `spawnStalker(state)` / `despawnStalker(state)` helpers:
  - **Target:** loudest living player by `Player.noise` (tie-break nearest); if none alive, drift/idle.
  - **Lit-test (CRITICAL — gate on light actually being ON):** the existing cone checks (`ai.ts` lurking, `game.ts` zombieVoices) use only `dot > coneCos` because they're dread/voice-only. The stalker's ward MUST also require the light to be on: a player wards the stalker only if **`flashlightIntensity(pl) > 0`** (pure, tested — `game/systems/flashlight.ts`; already accounts for `lightOn`/battery/flicker) AND `dot(dirToStalker, aimDir) > coneCos` AND `dist < cone range`. OR across all living players. (A dark/dead-battery player must NOT ward — else you'd be safe in the dark, breaking the core.)
  - **State machine:**
    - `lull`→`aggro` when the target is loud/near enough (`Player.noise` / distance) — else drift slowly.
    - `aggro`: if **lit** → `stagger` (`staggerT = staggerWindow`). Else advance at `advanceSpeed` toward the target — route around walls by `sampleFlow(state.flow, ...)` **only when `state.flow` is non-null AND the sample is non-zero** (two-stage fallback: null flow OR (0,0) sample → head straight), then add a small **bias away from the target's aim** (`CONFIG.stalker.noiseBias`/an approach-angle offset) so it tends to come from where the player isn't looking (the "not the watched opening" intent, cheaply — full least-watched-opening routing is Phase 1.5).
    - `stagger`: `staggerT -= dt`; back off at `staggerSpeed`; still-lit refreshes `staggerT` (lingering ward = a flick suffices). `staggerT<=0` → `aggro`.
    - `retreat`: move away at `retreatSpeed`; `despawnStalker` when off-arena / far.
  - **Contact (parity with the crowd hurt path — separate the two suppressors):** if `dist(stalker,target) < contactDist` and `stalker.contactCd<=0` and `target.iframe<=0`: deal `contactDamage` (`target.hp -= …`), then set **BOTH** `stalker.contactCd` (stalker re-grab suppression) **and** `target.iframe = CONFIG.feel.hurtIframe`-ish + `target.hitFlash` + `fxHurt(...)` (victim multi-hit suppression — mirror `ai.ts:347-363` so the crowd doesn't double-hit the same frame and the stalker doesn't grant accidental invuln). Knock the stalker back and set `state:"retreat"` briefly. **Local-only feedback** (`state.flashT`/`cam.shake`/`Audio.hurt`) is gated `target.id === state.localId` — the grab *presentation* proper is Task 3. Guard the whole contact on `target.iframe<=0` so it interleaves correctly with crowd contact.
  - Keep `stalker.face` toward the target for draw.
- [ ] **Step 2: Wire spawn/despawn to the siege event; step in `update()`.** In `game/game.ts` `update()`, `sysSiege` already returns `"night"`/`"dawn"` on the transition frame (captured as `ev`). Drive the stalker from that (once-per-night, robust — NOT a `stalker===null && phase==="night"` check, which would re-spawn every frame after a mid-night despawn): on `ev === "night"` → `spawnStalker(state)`; on `ev === "dawn"` → set the stalker to `retreat` (or `despawnStalker`). Call `if (state.stalker) sysStalker(state, sdt)` right after `sysAI(state, sdt)` (player + crowd + `state.flow` resolved; before camera). Host-only automatically (only host runs `update()`). `spawnStalker` places it at `spawnDist` from the target, at an angle away from the target's aim, in the dark, `state:"lull"`.
- [ ] **Step 3: Draw.** In `game/game.ts` `draw()`, if `state.stalker`, draw its sprite via `R.spriteLayer("stalker")` / `R.spriteQuad` (mirror how zombies are drawn — size, `face + SPRITE_FACE_OFFSET`, tint white; a faint cold glow when unlit so it reads as a silhouette in gloom, per the gloom model). Draw at a size a bit larger than a brute.
- [ ] **Step 4: Verify.** `bun run typecheck && bun run lint && bun run test && bun run build` → green. (Single-player: the stalker now spawns at night, advances in dark, staggers when lit, grabs on contact, retreats at dawn — logic testable by playtest in Task 6; here just confirm it compiles/builds and single-player still runs.)
- [ ] **Step 5: Commit.**
```bash
git add game/systems/stalker.ts game/game.ts
git commit -m "feat(stalker): sysStalker spawn + motion state machine + contact + draw"
```

---

### Task 3: Ward polish + telegraph FX + grab presentation (the felt layer)

**Files:** create `game/systems/stalkerFx.ts`; modify `game/game.ts` (telegraph per-frame + grab scare), `game/config.ts` (telegraph tuning), `game/engine/audio.ts` (a stalker footfall + stinger if needed).

- [ ] **Step 1: Telegraph module.** `game/systems/stalkerFx.ts`: given the stalker + local player, compute `dread = nearness × unlit` and drive, throttled:
  - a **localizable footfall** (procedural audio, panned by the stalker's direction/distance) — the fair "heard before seen" cue;
  - a **cone flicker** signal (a value `game.ts` applies to the flashlight cone alpha/intensity when the stalker is close & unlit);
  - a **heartbeat** rising with dread.
  This is **render/audio only** (like `darts`, NOT in `state.particles`) → single-player-safe; on clients it's driven from the synced stalker (Task 5).
- [ ] **Step 2: Grab presentation (LOCAL player only).** In `game/game.ts`, when the stalker grabs a player, trigger a diegetic scare **only for the grabbed local player** (`target.id === state.localId`) — else in co-op every client's screen would collapse. The scare: hard screen flash → near-black collapse, a big camera lurch/shake, an audio stinger, a brief drag of the camera toward the stalker. **No text.** Reuse `state.flashT`/`state.cam.shake`. (In co-op the client re-derives its own grab scare from the synced stalker + its own HP drop — Task 5.)
- [ ] **Step 3: Config + verify.** Add telegraph/scare tuning to `CONFIG.stalker`. `bun run typecheck && bun run lint && bun run test && bun run build` → green.
- [ ] **Step 4: Commit.**
```bash
git add game/systems/stalkerFx.ts game/game.ts game/config.ts game/engine/audio.ts
git commit -m "feat(stalker): telegraph (footfall/flicker/heartbeat) + grab scare"
```

---

### Task 4: Aim-assist exclusion + battery ward cost (small integration)

**Files:** `game/systems/stalker.ts` / `game/net/localInput.ts` or wherever aim-assist targets are chosen; `game/config.ts`.

- [ ] **Step 1: Aim-assist exclusion.** Confirm the `aimAssist` target selection (from `settings.ts`, applied in `localInput.ts`) only considers `state.zombies` — since the stalker is a separate slot, it is **already excluded** by construction. Verify this and add a one-line comment/test note; no code needed unless aim-assist somehow reaches the stalker.
- [ ] **Step 2: Ward battery cost (optional, tiny).** If desired per the spec, a small `CONFIG.stalker` battery nick per ward-stagger trigger (so warding isn't entirely free) — keep tiny; the ward is a flick, not a hold. Skip if it complicates; note the decision.
- [ ] **Step 3: Verify + commit.**
```bash
bun run typecheck && bun run lint && bun run test
git add -A && git commit -m "feat(stalker): confirm aim-assist exclusion + optional ward battery nick"
```

---

### Task 5: Co-op snapshot block + client cues (host-authoritative sync)

**Files:** `game/net/snapshot.ts` (capture/apply/encode/decode/lerp + `SnapStalker`), `game/net/snapshot.test.ts` (golden + round-trip), `game/net/net.ts` (`PROTOCOL_VERSION` bump), `game/net/client.ts` (apply + cues), `game/net/events.ts` (a withdraw/despawn event if needed).

- [ ] **Step 1: Snapshot block.** Add a small `SnapStalker { present:boolean; x:number; y:number; face:number; state:number }` to `Snapshot`. In `captureSnapshot`, emit from `state.stalker` (present=false when null). In binary `encode`/`decode`, append a **fixed-size** block (1 presence byte; when present: int16 x/y + a byte face-quantized + a byte state) — mirror the layout in encode/decode and document it. The Writer/Reader framing appends safely (it's full-only, sequential-offset). In `applySnapshot`, set/clear `state.stalker` on the client; in `lerpSnapshots`, interpolate x/y/face when present in both frames (else snap).

- [ ] **Step 1b: Bump `PROTOCOL_VERSION` + update the golden layout test.** The wire layout is now different, so: (a) bump `PROTOCOL_VERSION` in `game/net/net.ts` (14 → 15) — this is the forcing function that prevents host/client silent desync across versions; (b) `game/net/snapshot.test.ts` pins an inline FNV/`len` golden of an encoded `newState()` snapshot (~L100-134) — it WILL drift once encode always writes the presence byte; regenerate the golden (`--update` or hand-update the `len=`/`fnv=`) and **eyeball the diff to confirm it changed by exactly the new block's bytes** (a `newState()` has `stalker:null` → +1 presence byte); (c) add a round-trip assertion: a snapshot with a present stalker encodes→decodes to the same x/y/face/state.
- [ ] **Step 2: Exclude from kill-rederive; withdraw cue.** Ensure the client's zombie kill-rederivation (`client.ts:245`, vanished id → kill fx) **never** sees the stalker (it's a separate block, so it already won't — verify). When the stalker goes `present:true → false`, the client plays a **withdraw** cue (not a kill burst).
- [ ] **Step 3: Client telegraph.** Drive `stalkerFx` on the client from the synced `state.stalker` (footfall/flicker/heartbeat re-derived from the block + local player), so co-op clients feel the approach too.
- [ ] **Step 4: Verify.** `bun run typecheck && bun run lint && bun run test && bun run build` → green. Confirm single-player is unaffected (the block is inert when `state.stalker` is null). Check `snapshot.test.ts` round-trip still passes; add a stalker round-trip assertion if the test file supports it.
- [ ] **Step 5: Commit.**
```bash
git add game/net/snapshot.ts game/net/snapshot.test.ts game/net/net.ts game/net/client.ts game/net/events.ts
git commit -m "feat(stalker): co-op snapshot block (+PROTOCOL_VERSION bump) + client cues"
```

---

### Task 6: Tuning + playtest feel-gate (human)

- [ ] **Step 1: Playtest (human, `bun run dev`).** Confirm the felt core:
  1. At night the stalker **advances from the dark** and you must **flick your light** at it to stagger it — and the stagger **lingers** so a flick suffices (not a hold).
  2. **Noise draws it** — firing/running/rummaging pulls it toward you; going quiet lets you slip.
  3. **Crowd-or-Stalker tension** — dealing with the horde means taking your light off the stalker.
  4. **Telegraph is fair** — you **hear it (localizable footfall) / see the flicker** before it reaches you.
  5. **The grab is a scare** — screen collapse + lurch + stinger, no text; then it withdraws.
  6. It **retreats at dawn**; single-player + existing feel intact; suite green.
- [ ] **Step 2: Tune `CONFIG.stalker`** (hot-reload) until it reads as *tense but fair*. Land values.
- [ ] **Step 3: Commit final tuning.**
```bash
git add game/config.ts
git commit -m "feat(stalker): Phase 1 tuning + feel-gate sign-off"
```

---

## Self-Review

**Spec coverage (Phase 1 core):** independent `state.stalker` slot + `sysStalker`, out of `state.zombies` (Tasks 1–2) ✓; night-only single instance, advance-in-dark / stagger-when-lit with lingering ward (Task 2) ✓; noise attraction via `Player.noise` (Task 2) ✓; unkillable, contact = scare + withdraw (Tasks 2–3) ✓; retreat at dawn (Task 2) ✓; real telegraph (footfall/flicker/heartbeat) + grab presentation, no text (Task 3) ✓; aim-assist exclusion (Task 4) ✓; co-op snapshot block excluded from kill-rederive + withdraw event (Task 5) ✓; sprite + REQUIRED_SPRITES (Task 1) ✓; tuning + playtest (Task 6) ✓. **Deferred:** fake perception cues, audio-ducking polish, map loop-geometry (Phase 1.5); menace escalation (Phase 2) — all explicitly out.

**Post-review corrections applied (rubber-duck):** (1) **lit-test gated on `flashlightIntensity(pl) > 0`** — copying the existing dread-only cone math (no light/battery gate) would let a dark player ward the stalker, breaking the core; (2) **contact separates the two suppressors** — `stalker.contactCd` (re-grab) AND `target.iframe`+hitFlash+fxHurt (victim multi-hit), mirroring `ai.ts:347-363`, with local-only flashT/shake/Audio; (3) **spawn/despawn driven by the `sysSiege` "night"/"dawn" event** in `update()` (once per night, robust vs. mid-night re-spawn); (4) **`state.flow` two-stage fallback** (null or (0,0) → head straight) + a small aim-opposite approach bias; (5) **`PROTOCOL_VERSION` bump + golden layout test update + round-trip** in Task 5; (6) grab presentation is local-only.

**Known Phase-1 constraint (flagged, not blocking):** the stalker rides the shared player-directed `state.flow` for wall routing, which pulls toward the same openings the crowd uses; the aim-opposite bias mitigates but full "least-watched opening" routing is Phase 1.5. Watch feel-gate #3 (crowd-or-Stalker tension) for this.

**Placeholder scan:** CONFIG values are starting points flagged for playtest tuning; all else concrete. Draw/telegraph reference existing patterns (`spriteQuad`, `darts`, `state.flashT`/`cam.shake`, `flashlightIntensity`) by name for the implementer to mirror.

**Type/name consistency:** `Stalker`, `state.stalker`, `sysStalker`, `spawnStalker`/`despawnStalker`, `CONFIG.stalker`, `SnapStalker`, `stalkerFx`, `REQUIRED_SPRITES` used consistently. Noise read via `Player.noise` (the 2b field), not a `state.noise` scalar.
