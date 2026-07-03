# Action Feel — Review-Fix Design

**Goal:** Fix the three findings from the PR #42 (`feat/action-feel`) review at their root cause — not with band-aids (threshold nudges, phase-special-cases) — plus a documentation-accuracy correction. All fixes ride existing mechanisms (the assist gauge, the heal timer, the geometry helper module).

**Context:** PR #42 spread an "action feel" vocabulary across seven timed actions. A code review + an independent rubber-duck pass cleared the high-risk areas (snapshot binary offsets/bitmasks, golden-hash length, gap/reconnect resilience, host/client role-exclusivity, division safety) and surfaced three low-severity findings plus one wording imprecision. This spec covers only those.

**Design principles (from CLAUDE.md):** feel-first (playtest-verified), data-driven with zero special-case debt, single-player sim logic byte-unchanged when touching co-op paths. Only pure/deterministic helpers get Vitest tests; motion/particle *feel* is validated by playtest.

## Global constraints

- **No band-aids.** Each fix re-anchors a client-side re-derivation to the *same authoritative signal the host uses*, or expresses the guard's real intent — never a magic-number tweak or a phase-transition special-case.
- **Single-player logic unchanged.** Fixes 1 and 3 touch only the co-op client's `effects()` re-derivation (never run in single-player). Fix 2 changes only where a cosmetic burst/spark is *positioned*, not gameplay.
- **Feel gates on playtest.** Fixes 1 and 3 gate on `typecheck` + `lint` + a stated 2-tab co-op playtest. Fix 2's new pure helper gets a Vitest test; its call-site substitutions gate on `typecheck` + existing tests.
- **No new sync / no wire change.** All three fixes use already-synced fields (`assistT`, `healT`, `hp`). `PROTOCOL_VERSION` is **not** bumped and the snapshot golden-hash test is **not** touched.
- **Gap / reconnect behavior unchanged in kind.** `Client.effects()` runs only when `this.prev` exists and `resetNet()` nulls `prev` on reconnect, so a reconnect never replays stale diffs. Under a large tick gap the edges (Fixes 1 & 3) can collapse multiple transitions into one diff — the same property every existing `effects()` re-derivation has; these fixes neither add nor worsen it, and any miss is a cosmetic burst/mote omission, never a desync.

## File structure

**Modified:**
- `game/net/client.ts` — re-anchor the revive-burst edge (Fix 1) and the mate-heal-mote edge (Fix 3) in `Client.effects()`.
- `game/engine/geometry.ts` — add the pure `segMid` helper (Fix 2).
- `game/engine/geometry.test.ts` — unit-test `segMid` (Fix 2).
- `game/systems/player.ts` — use `segMid` in the repair paths; this also removes the in-function midpoint duplication the review flagged (Fix 2).
- (evaluated, converted only if clearly clearer) `game/game.ts`, and the client re-derivation midpoint — see Fix 2 scope.
- PR #42 body — wording correction (Fix 4, no code).

---

## Fix 1: Re-anchor the revive burst to the assist mechanism

**Finding:** On a co-op **client**, `Client.effects()` fires a big green revive burst on *any* downed→alive transition (`p.hp <= 0 && pl.hp > 0`). The **host** fires this burst only from `sysAssist` on a completed peer-revive; the dawn batch-respawn (`revivePlayer` called from the dawn path in `game.ts`) fires nothing. So at each dawn a client shows a burst for every teammate who fell overnight while the host shows none — a host/client visual discrepancy.

**Root cause:** the client re-derivation is anchored to a *proxy* (a raw hp crossing) that matches two distinct events — an in-field peer-revive and a dawn batch-respawn. The proxy over-triggers because it does not carry the distinction the host makes.

**Fix:** anchor the client edge to the same signal `sysAssist` uses — the assist gauge. Change the condition in `Client.effects()` (the edge currently reading `if (p && p.hp <= 0 && pl.hp > 0)`) to also require the player was actively being tended in the previous snapshot:

```ts
if (p && p.hp <= 0 && p.assistT > 0 && pl.hp > 0) {
  fxActionBurst(st, pl.x, pl.y, [0.4, 1, 0.6], true);
}
```

**Why this is correct (verified against the code):**
- `revivePlayer` sets `p.assistT = 0` and raises `p.hp` on completion (`game/engine/players.ts`).
- An untended downed player has `assistT` forced to 0 each tick (`game/systems/assist.ts`: `if (p.hp <= 0 && !tended.has(p) && p.assistT > 0) p.assistT = 0`).
- Dawn respawn is safe: `update()` runs `sysAssist → … → sysSiege`, and on the `"dawn"` frame the same tick calls `openShop() → revivePlayer` (`game.ts`), so the snapshot taken at tick end always shows dawn respawns with `assistT == 0`. A mid-revive player is tended for reviveTime (2.5s ≈ 150 sim ticks) at ~2-tick snapshot spacing, so the pre-completion snapshot reliably captures `assistT > 0 && hp <= 0`.
- `assistT` is already synced (`SnapPlayer.assistT`, `f32` — not quantized), so no wire change and the `> 0` threshold is exact.

**Not chosen (band-aid):** having the client detect "is this the dawn transition?" and skip — couples the client to phase-transition timing and re-introduces a special-case.

**Accepted residual (cosmetic):** in the narrow case where a tender interrupts (assist.ts zeroes `assistT`) and then re-completes the revive within a single snapshot interval, the pre-completion snapshot can show `assistT == 0` and the burst is dropped. This only *omits* a burst (never fires a wrong one) and causes no desync. Note it with a code comment at the edge so a future reader isn't surprised.

**Test/gate:** feel path → `typecheck` + `lint` + 2-tab co-op playtest: (a) down a player, revive by standing on them → one green burst on getting up; (b) let a player stay down until dawn → **no** burst at the dawn respawn (matches host).

---

## Fix 2: Consolidate barricade-segment midpoint into a `segMid` helper

**Finding:** In the repair path (`game/systems/player.ts`), the barricade segment midpoint is computed twice within one function — once as `mx2/my2` (sparks/dust) and again as `mx/my` (completion burst). More broadly the same `(x1+x2)/2, (y1+y2)/2` pattern is written independently in ≥4 places (`player.ts` nearest-target search and repair path, `client.ts` repair re-derivation, `game.ts` nearest-barricade distance).

**Root cause:** a recurring geometric operation has no shared helper, so it drifts into ad-hoc inline copies (the in-function duplication is one symptom).

**Fix:** add a pure helper to `game/engine/geometry.ts`, matching the module's existing return convention (`{ x, y }`, like `closestPointOnSegment`):

```ts
/** Midpoint of a segment (or of a barricade/wall's two endpoints). */
export function segMid(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { x: number; y: number } {
  return { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}
```

**Call-site conversion (judgment, not mechanical):** convert only where it reads at least as clearly as the inline form.
- **Convert:** `player.ts` nearest-barricade-target midpoint; `player.ts` repair path (this is where the review's in-function duplication is resolved — one `segMid` call feeds both the sparks/dust and the completion burst); `client.ts` repair-complete re-derivation.
- **Evaluate case-by-case:** `game.ts` nearest-barricade distance (`(x1+x2)/2` inline inside a `Math.hypot`) and `drawSeg` (a generic *segment* midpoint, not a barricade). Convert only if it stays clear; otherwise leave inline and note why. No forced full-sweep.

**Test/gate:** `segMid` gets a Vitest test in `geometry.test.ts` (interior even/odd endpoints, negative coords, degenerate point-segment) asserting `toEqual({ x, y })` in the module's style. Call-site substitutions are behavior-preserving → gate on `typecheck` + existing tests.

**Scope note:** the review finding was only the in-function duplication; extracting the helper and converting the other sites is a deliberate, bounded widening (approved) to remove the latent drift, not unrelated refactoring.

---

## Fix 3: Express the mate-heal-mote guard's real intent

**Finding:** On a co-op **client**, the mate-heal mote edge (`pl.hp > p.hp + 1 && p.hp > 0 && pl.hp < pl.maxHp + 1 && pl.healT <= 0.05`) also fires once at a **self-heal completion** snapshot: at that tick `healT` has crossed to ≤0.05 while the hp rise from the just-finished self-heal still lands in the same diff. Result: on self-heal completion the client shows the completion burst *and* one stray mate-heal mote (both green, same spot — nearly invisible, but a spurious extra particle).

**Root cause:** the guard only checks the *current* tick's `healT` (`pl.healT <= 0.05`), so it fails to exclude an interval where self-healing was active at the *start* of the diff. The intent is "hp rose from an external source over an interval during which this player was not self-healing at all."

**Fix:** require self-heal inactive at both ends of the interval — add the previous snapshot's `healT`:

```ts
if (p && pl.hp > p.hp + 1 && p.hp > 0 && pl.hp < pl.maxHp + 1
    && p.healT <= 0.05 && pl.healT <= 0.05) {
  fxMote(st, pl.x, pl.y, [0.3, 1, 0.45]);
}
```

**Why this is correct:** a self-heal that completes this interval had `p.healT > 0.05` (still healing) in the previous snapshot, so it is now excluded. A genuine mate-heal (teammate applies a medkit) raises the target's hp in one step while that target's `healT` is 0 at both ends → still detected. This matches where the host emits the mote (`interact()`, at the healed target's position).

**No competing hp-raising path exists (verified):** the only sources that raise a *live* player's current hp are self-heal (excluded by the `healT` guards), mate-heal (the intended trigger), and revive (excluded by `p.hp > 0`). `game/data/pickups.ts` has no hp pickup, and the only upgrade touching health raises `maxHp` (`p.maxHp += 20`), not current hp. So no pickup/upgrade/perk can false-trigger the mote.

**Accepted residual (cosmetic).** Self-heal is 25 hp/s, so at normal ~30 Hz snapshot spacing the per-interval hp rise is <1 and the `pl.hp > p.hp + 1` guard already blocks a self-heal mote regardless of this fix. A double-fire (completion burst + stray mote) is therefore only reachable when a dt spike (backgrounded host, dt cap 0.1s) makes a single interval accrue >1 hp *and* the `healT` phase lands so neither guard end is >0.05. This fix closes the common case; the narrow remaining alignment is cosmetic (a green mote coincident with a green burst) and shares the same 0.05 phase assumption already present in the existing self-heal completion-burst edge — out of scope to re-engineer here.

**Not chosen (band-aid):** widening the `0.05` epsilon — it does not express intent and would drift with quantization assumptions.

**Test/gate:** feel path → `typecheck` + `lint` + 2-tab co-op playtest: (a) heal a downed-hp teammate with a medkit → mote on them; (b) self-heal to completion → completion burst only, no extra mote.

---

## Fix 4: PR-body wording accuracy (no code)

**Finding (from rubber-duck):** the PR body's invariant "単発プレイはシム的にバイト不変" is imprecise. The new FX (`fxMote`/`fxDust`/`fxActionBurst`/`fxImpact`) are called inside the sim update path (`sysPlayerOne`/`interact`) and consume `rand()` = the global unseeded `Math.random()`, which gameplay also draws from. So single-player's *random-number stream* does shift; only the *logic/control-flow* is unchanged.

**Impact:** none — the project has no seeded RNG, replay, or lockstep (CLAUDE.md: "no RNG seeding needed"), and no test depends on RNG ordering (tested code is pure and order-independent).

**Fix:** amend the PR body's invariant line to distinguish the two senses, e.g.: "単発プレイの**シムのロジック経路は不変**。FX をシム経路で `Math.random()` 経由に呼ぶため**グローバル乱数列は実際にはずれる**が、決定論契約が無いため無害。" No code change; not gated.

---

## Out of scope

- Any change to the snapshot wire format, `PROTOCOL_VERSION`, or the golden-hash test.
- A mechanical full-sweep replacing every `(x1+x2)/2` in the codebase (only barricade/segment midpoints where it reads clearly).
- Predicting a co-op client's own `healT` to make its self-heal payoff immediate (an accepted limitation in the original PR).
- New floating text or any non-diegetic payoff (the diegetic-feedback initiative removed those).
