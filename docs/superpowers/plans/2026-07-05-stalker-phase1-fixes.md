# The Stalker — Phase 1 Playtest Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Three fixes from the Stalker Phase 1 playtest, on the `feat/stalker` branch before its final review/PR:
1. A warded stalker **slowly moonwalking backward looks surreal** → make it **vanish into the dark** and re-emerge from elsewhere.
2. **Aim-assist snaps to zombies behind walls**, so shots hit the wall — stressful → aim-assist must **skip zombies with no line of sight**.
3. **Bullets pass through the stalker with no reaction** (it's unkillable by design, but bullets not even *connecting* reads as a bug) → bullets **hit and make it flinch** (impact + recoil) while staying **unkillable**; light remains the real ward.

**Architecture:** Host-side sim / render on the existing Stalker subsystem + `assistAim` + `sysBullets`, plus a **snapshot tweak**: the vanish fade is driven by `vis`, which the Task-5 block did NOT sync (`applySnapshot` hardcodes `vis:1`), so co-op clients would see a *pop*, not a fade. Fix 1 therefore **adds `vis` to the (still-unmerged, this-branch) `SnapStalker` block** and relocates via a `present=false` tick to avoid a lerp slide. `PROTOCOL_VERSION` is already 15 on this branch (unreleased), so no *additional* bump is needed — but the `snapshot.test.ts` golden must be re-updated for the widened block.

**Tech Stack:** TypeScript (strict), Bun, Vitest, Biome.

## Global Constraints
- Stalker stays **unkillable** — bullets never damage/kill it; they only make it react.
- **Light is the primary ward.** Bullets flinch it but do not banish it (only the light-ward / vanish does).
- Reuse existing helpers: `hasLineOfSight` (`game/systems/perception.ts`, pure), the stalker's stagger/`vis`, `fxImpact` (`game/systems/fx.ts`).
- Stalker sim/feel is **not unit-tested** (playtested); pure additions may be tested. Suite green each task; commit per task.
- No *additional* `PROTOCOL_VERSION` bump (already 15 on this unmerged branch), but Fix 1 **widens the `SnapStalker` block with `vis`** → the `snapshot.test.ts` golden IS updated (present-stalker `len` +1) and a `vis` round-trip assertion added. Aim-assist/bullet fixes are non-wire.
- Design source: `docs/superpowers/specs/2026-07-05-stalker-core-design.md`; base impl: `docs/superpowers/plans/2026-07-05-stalker-phase1.md`.

---

### Task 1: Warded stalker vanishes into the dark (a little moonwalk, then gone)

**Files:** `game/systems/stalker.ts`, `game/config.ts`, `game/net/snapshot.ts` (sync `vis`), `game/net/snapshot.test.ts` (golden re-update + assert vis round-trips).

Currently the `stagger` case backs the stalker off at `staggerSpeed` (slow, visible, surreal — but a *short* recede is fine) and `vis` always fades IN (`stalker.ts:232`). Change warding to a **short-recede → fade-out → relocate**. **Do NOT remove `staggerSpeed`** — the `lull` case also uses it (`stalker.ts:109-110`); keep it (a new `lullDriftSpeed` is optional, not required).

- [ ] **Step 1: Fade `vis` out while staggered; in otherwise.** Replace the unconditional `s.vis = Math.min(1, s.vis + dt*2)` (`~stalker.ts:232`) with: if `s.state === "stagger"` → `s.vis = Math.max(0, s.vis - dt * CFG.wardFadeOut)` (fast, e.g. `wardFadeOut: 5`); else fade in as before. (A fading stalker reads as "melting into the dark.")
- [ ] **Step 2: Stagger case = a LITTLE moonwalk, then vanish, then relocate.** (Playtest refinement: the problem wasn't the backward step — it was backing away *continuously/forever*. A **short** recede that then melts into the dark is the desired beat.) In the `stagger` case: keep `staggerT -= dt` and the lit-refresh; **keep a brief backward recede at `staggerSpeed`** (the "little moonwalk"), which stays short because `vis` is fading out fast (Step 1) — it recedes a step or two and is gone. When `s.vis <= 0` (fully vanished): **relocate** to a fresh far dark spot — same placement as `spawnStalker` (`spawnDist` from the target, at an angle away from its aim; factor a shared `placeStalker(state, s)` helper so spawn and relocate stay consistent — note `spawnStalker` currently targets `nearestPlayer(state,0,0)`, keep that or switch both to loudest/local, but keep them the SAME) — set `s.state = "lull"`, leave `s.vis` at 0 so it fades back in as it re-approaches. **Co-op clean re-appear (review):** the relocate jumps x/y ~`spawnDist` px; to stop the client's `lerpSnapshots` from *sliding* the stalker across the map, make the relocation frame emit **`present=false`** in the snapshot (e.g. relocate while `vis===0` and gate `captureSnapshot`'s `present` on `vis>epsilon` OR add a 1-tick hidden flag), so the client sees present=false→true and snaps to the new spot. Tune `wardFadeOut` so the recede is visible-but-short (~0.3–0.5 s before gone). Net beat: **flick light → it recoils a step, melts into the dark, and re-emerges stalking from a new direction.**
- [ ] **Step 3: Sync `vis` so clients see the fade (not a pop).** `vis` is currently host-sim-only — `applySnapshot` hardcodes `vis:1`, so co-op clients would see the stalker pop out, not melt. Add `vis` to the `SnapStalker` block: a `u8` (quantize `vis*255`) in `encode`/`decode` (right after `state`), emit it in `captureSnapshot`, and in `applySnapshot` use the decoded `vis` (remove the `vis:1` hardcode); `lerpSnapshots` interpolate `vis` when present in both. Then **re-update the `snapshot.test.ts` golden** (`len` +1 for a present stalker; the null-stalker case is unchanged since the block is presence-gated) and extend the present-stalker round-trip assertion to check `vis`. `PROTOCOL_VERSION` is already 15 on this (unmerged) branch — no additional bump, but confirm the golden reflects exactly the +1 `vis` byte.
- [ ] **Step 4: Config.** Add `wardFadeOut: 5` (fade-out rate) + any relocate tuning to `CONFIG.stalker`. Keep `staggerSpeed` (lull depends on it).
- [ ] **Step 5: Verify.** `bun run typecheck && bun run lint && bun run test && bun run build` green (incl. updated golden + vis round-trip). Single-player unaffected functionally.
- [ ] **Step 6: Commit.**
```bash
git add game/systems/stalker.ts game/config.ts game/net/snapshot.ts game/net/snapshot.test.ts
git commit -m "fix(stalker): warded stalker melts into the dark + relocates; sync vis for clients"
```

---

### Task 2: Aim-assist skips zombies with no line of sight

**Files:** `game/net/localInput.ts`.

`assistAim` (`localInput.ts:~40`) picks the nearest zombie within flashlight range — but does not check walls, so it locks onto through-wall zombies and your bullets hit the wall.

- [ ] **Step 1: LOS gate.** In the `assistAim` candidate loop, skip a zombie when a wall blocks the shot: `if (!hasLineOfSight(px, py, z.x, z.y, state.walls)) continue;` (import `hasLineOfSight` from `../systems/perception` — it's a pure function; net importing a pure systems helper is fine, the forbidden direction is systems→net). Place it after the range check (cheap-first). This keeps aim-assist on targets you can actually hit.
- [ ] **Step 2: Verify.** `bun run typecheck && bun run lint && bun run test && bun run build` green. (If Biome/arch flags the `systems` import from `net`, relocate `hasLineOfSight`+`heard` to `game/engine/geometry.ts` or a small `engine/los.ts` and update `perception.ts`'s re-export — note the choice.)
- [ ] **Step 3: Commit.**
```bash
git add game/net/localInput.ts
git commit -m "fix(aim-assist): skip zombies with no line of sight (stop wall-suck)"
```

---

### Task 3: Bullets hit the stalker (flinch), still unkillable

**Files:** `game/systems/bullets.ts`, `game/systems/stalker.ts` (a `flinchStalker` helper), `game/config.ts`.

`sysBullets` only tests `state.zombies` (spatial hash), so bullets sail through the stalker with no feedback. Add a stalker hit-test that makes it **react** without damage.

- [ ] **Step 1: `flinchStalker` helper.** In `game/systems/stalker.ts`, export `flinchStalker(state, bx, by, dirX, dirY)`: if `state.stalker` present & `vis > ~0.1`, apply a small knockback along the bullet direction (`CFG.bulletKnockback`) + a **brief `vis` dip** for the recoil flicker (e.g. `s.vis = Math.max(0.2, s.vis - CFG.bulletFlinch)` — reuse `vis`, now synced in Task 1, so clients see the flinch too; do NOT add a new `flinchT` field → avoids a type/snapshot change), and `fxImpact` at the hit point (cold spark). **No hp, no death, no full stagger/banish** — light stays the real ward. (A single bullet only flinches; it must NOT trigger the Task-1 vanish. Keep it a pure flinch.)
- [ ] **Step 2: Bullet vs stalker test.** In `sysBullets`, for each live bullet (after the wall-stop check, alongside the zombie query), test the bullet segment/point against the stalker: if `state.stalker` present and the bullet is within `stalker radius (~contactDist/…)` of `state.stalker`, call `flinchStalker(...)`, `fxImpact`, and **consume the bullet** (same swap-pop/return as a zombie hit). Single entity → a plain distance check (no spatial hash). Skip when the stalker is fully faded (`vis <= ~0`) so you can't hit a vanished one.
- [ ] **Step 3: Config.** `CONFIG.stalker.bulletKnockback` (small), flinch duration.
- [ ] **Step 4: Verify.** `bun run typecheck && bun run lint && bun run test && bun run build` green. Confirm the stalker still cannot be killed (no hp path) and single-player/co-op crowd bullet behavior is unchanged (the stalker check is additive).
- [ ] **Step 5: Commit.**
```bash
git add game/systems/bullets.ts game/systems/stalker.ts game/config.ts
git commit -m "fix(stalker): bullets connect + flinch it (impact/knockback), still unkillable"
```

---

### Task 4: Re-playtest (human)

- [ ] **Step 1: Playtest (`bun run dev`).** Confirm:
  1. Flicking the light at the stalker makes it **melt into the dark and re-emerge from a new direction** — no surreal backward moonwalk.
  2. Aim-assist no longer **sucks onto zombies behind walls**; shots go to hittable targets.
  3. Bullets **visibly hit the stalker** (spark + flinch/recoil) and it **still can't be killed** — light is still how you ward it.
  4. Nothing else regressed (crowd combat, existing stalker feel from the prior playtest).
- [ ] **Step 2: Tune** `CONFIG.stalker` (`wardFadeOut`, `bulletKnockback`/`bulletFlinch`, etc.) as needed; also make the **`wardConeGrace` call** now (from the prior review: is the ward hair-trigger?). If implementing the 0.15 s grace, add a host-only `wardGraceT: number` to the `Stalker` interface (`types.ts`) — ignore it in `applySnapshot` (host-sim-only, like the other non-synced fields) — and accumulate it in the `aggro` case before flipping to `stagger`. Otherwise remove the dead `wardConeGrace` config key.
- [ ] **Step 3: Commit final tuning** if changed.

---

## Self-Review
**Coverage:** vanish-into-dark = *short recede → vis fade-out → relocate* (Task 1) ✓; aim-assist LOS gate (Task 2) ✓; bullets flinch the unkillable stalker via a vis-dip (Task 3) ✓; re-playtest + wardConeGrace decision (Task 4) ✓. Stalker stays unkillable (Task 3 has no hp/death path).

**Post-review corrections (rubber-duck):** (1) `vis` is host-sim-only (client hardcodes `vis:1`) — so the fade would *pop* on clients; Fix 1 now **syncs `vis`** in the block + updates the golden; (2) relocate now emits `present=false` for the jump so the client `lerpSnapshots` snaps instead of sliding 900px; (3) `staggerSpeed` is **kept** (the `lull` case depends on it); (4) the bullet flinch reuses a **`vis` dip** (no new `flinchT` type/snapshot field); (5) if `wardConeGrace` is implemented, `wardGraceT` is added to the `Stalker` type as host-only.

**Placeholder scan:** CONFIG values are playtest starting points. **Type/name consistency:** `flinchStalker`, `placeStalker`, `CFG.wardFadeOut`/`bulletKnockback`/`bulletFlinch`, `hasLineOfSight`, `fxImpact`, synced `vis` used consistently; `hasLineOfSight` net→pure-systems import has precedent (`client.ts` imports systems).
