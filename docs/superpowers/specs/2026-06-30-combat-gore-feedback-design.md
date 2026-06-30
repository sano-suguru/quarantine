# Combat Gore Feedback — Design

**Date:** 2026-06-30
**Status:** Approved (design); implementation pending
**Spec ① of the "diegetic feedback" initiative** (show, don't tell). Later specs: ② HUD de-tell, ③ player vitality (Integrity), ④ darkness & visibility.

## Problem

QUARANTINE is a horror game; its design principle is **feel-first** — fear and game-feel are the product. Two combat readouts currently *tell* the player state in text/UI instead of letting them *feel* it:

1. **Floating damage numbers** (`fxDamageText` → `state.texts` → drawn at `game.ts:611-615`). Pure ARPG/looter combat overlay; it reads as accounting and fights the dread.
2. **Per-zombie HP bars** (`game.ts:524-530`). Same category — a combat-UI overlay that also leaks the position of enemies that should be lurking in the dark.

Both convert "how hurt is this thing / how hard did I hit" — information the game can *show* through gore — into floating text.

## Goal

Replace both with **damage-proportional gore**: the harder the hit (and the closer it is to finishing the target), the more blood, the larger the pool, and — above a threshold — flying flesh chunks (gibs). Read enemy woundedness from how wrecked the body *looks*, not a bar.

This rides the **existing FX mechanism** (`fxImpact` / `fxKill` / blood decals) — no new bespoke code path (CLAUDE.md: extend the mechanism, zero special-case debt). All tuning lives in `CONFIG.fx.gore`.

## Non-goals (explicit scope fence)

- **Hitstop / knockback / screen-shake are unchanged.** This spec is *visual gore only*. Per-hit micro-hitstop on rapid fire would make the sim feel sluggish; out of scope.
- **Eyes (`R.add`) and the glow halo (`R.glow`) are untouched.** Those are Spec ④'s territory (darkness & visibility). The wound tint must not double-edit them.
- No change to AI, sim, or zombie movement. Wound visuals are draw-only.
- **`fxKill` stays keyed on enemy type (today's `big` boolean) — not intensity.** Threading the killing-hit intensity into `fxKill` would require changing all 4 `fxKill` callers + the `killZombie` signature, and — because the client only learns of a kill by a zombie's id vanishing (it has no killing-damage) — would make kill bursts asymmetric in co-op. Keeping `fxKill` type-based keeps kill bursts symmetric and churn-free. The finisher *feel* is carried by the near-lethal impact spray (§A/§B) plus the existing death burst.
- **No per-zombie multi-hit aggregation.** A point-blank shotgun lands several pellets on one body in one frame; each pellet fires its own `fxImpact`. That stacking is intentional — point-blank shotgun *should* be gorier — and bounded by the particle cap. We do not coalesce hits per zombie.

## Design

### A. Intensity — a single shared pure function

A 0..1 `intensity` drives every gore channel. It is computed by **one exported pure function** in `fx.ts` (mirrors `flashlightIntensity` in `flashlight.ts`), shared by all call sites — never copy-pasted.

```ts
// fx.ts (pure, unit-tested)
export function goreIntensity(
  dmgDealt: number,   // damage applied by this hit
  hpAfter: number,    // target hp AFTER the hit (<= 0 if killed)
  maxHp: number,
  cfg: GoreConfig,
): number {
  const absScale = clamp(dmgDealt / cfg.dmgRef, 0, 1);          // weapon weight (base)
  const fracAfter = Math.max(0, hpAfter) / maxHp;
  const finisher =
    hpAfter <= 0 ? 1
    : fracAfter <= cfg.lowHpBand ? 1 - fracAfter / cfg.lowHpBand
    : 0;                                                         // ramps up only near death
  return clamp(absScale + cfg.finisherBonus * finisher, 0, 1);
}
```

**Why this shape (not `max(absScale, frac)`):** a simple max lets the fraction-of-HP dominate, so a *light tap on a low-HP trash mob* would over-gore. Instead the **base is absolute damage (weapon weight)** and the **fraction contributes only as a finisher/near-lethal bonus**. Verified against real HP (runner 50 / walker 85 / brute 260) and real damage (13–95):

| Case | intensity | Intent |
|---|---|---|
| pistol → walker, light hit (full HP) | 0.27 | small spray ✓ |
| pistol → walker, killing blow | 0.87 | trash kill still pops ✓ |
| SCAR → brute, heavy hit | 1.0 | weapon weight = big gore immediately ✓ |
| runner, weak hit (full HP) | 0.14 | almost just sparks ✓ |

No degenerate case. Initial coefficients (playtest-tunable): `dmgRef = 90`, `lowHpBand = 0.33`, `finisherBonus = 0.6`.

### B. `fxImpact` scales with intensity (optional param)

`fxImpact` gains an **optional** `intensity` param, defaulting to 0:
`fxImpact(state, x, y, dir, color, intensity = 0)`.

Making it optional is deliberate: `fxImpact` has **7 call sites** (`bullets.ts:27` wall, `bullets.ts:45` zombie, `player.ts:236` melee, `ai.ts:150` barricade scrape, `deployables.ts:63` RTB power-down, `client.ts:240` re-derived zombie, `client.ts:259` re-derived RTB). Only the two zombie-damage sites (`bullets.ts:45`, `player.ts:236`) and the client zombie re-derive (`client.ts:240`) have a meaningful intensity. The non-combat sites (wall/barricade/RTB) simply omit the arg → they compile unchanged and render exactly as today (the `intensity = 0` floor). This keeps the signature change a single self-contained step that doesn't break the other callers.

- Blood speck count, blood-pool radius, and spark count are `lerp(min, max, intensity)`.
- Above `cfg.gibThreshold`, emit a few `"shard"` gibs (count scales with intensity), biased along `dir` so they spray in the hit direction.
- **Floor = no regression:** at `intensity = 0`, output must not drop below today's fixed burst (6 sparks + 3 specks).

`fxKill` is **unchanged** (still `big: boolean`, keyed on enemy type) — see Non-goals for why.

### C. Remove the damage-number system

Delete: `state.texts`, the `DamageText` type (`types.ts`), `fxDamageText` (`fx.ts`), the text-decay loop in `sysFx`, the draw loop (`game.ts:611-615`), and `texts: []` in `state.ts`.

**Keep `R.number`** — it is still used for the co-op player-id label (`game.ts:723`).

Call-site edits: `fxDamageText` is called from exactly **two** sites — `bullets.ts:46` and `player.ts:237`. Both drop the `fxDamageText(...)` call and pass `goreIntensity(...)` into `fxImpact`. The hit is applied before the FX call, so `dmgDealt`, `hpAfter` (= `z.hp` post-subtraction), and `maxHp` are all in hand. `killZombie(state, idx)` is **unchanged** — since `fxKill` stays type-based, no killing-hit intensity needs to thread through it.

### D. Zombie HP bar → wound visual

- Remove the HP-bar draw (`game.ts:524-530`).
- Add a wound tint driven by `frac = z.hp / z.maxHp`: blend the body color toward a blood color (`woundTint`) as `frac → 0`, plus a **conservative** darken (`woundDarken ≈ 0.18`). A near-dead zombie visibly looks wrecked.
- **Blood-blend is the primary channel; darken is deliberately small.** Strong darkening would sink a near-dead zombie into black even *inside* the flashlight cone, killing finisher visibility and fighting Spec ④. The body is non-additive, so the tint already darkens to black *outside* the cone via the shader's final lighting multiply (`instance.frag`, last line: `frag.rgb *= mix(u_emissive, 1.0, lightAt(v_world))`) — no extra work, no leak.
- The hit-flash (`z.flash`) is a transient brighten that composes on top; leave it.
- Draw-only. Identical on host, client, and single-player (`hp`/`maxHp` are synced — see E).

### E. Co-op — re-derive intensity on the client (no new field)

The client never runs `update()`; it re-derives combat FX from the prev→next snapshot diff (`client.ts:222-265`). Everything intensity needs is **already synced**:

- `flash` is synced and the client already fires `fxImpact` on its rising edge (`client.ts:238`) — the **hit edge**.
- `hp` / `maxHp` are synced per zombie (`snapshot.ts` 89-90/198-199/355-356) — the **magnitude**.

So at the flash edge the client computes `hpDelta = prev.hp - next.hp` and calls the same `goreIntensity(hpDelta, next.hp, next.maxHp, cfg)`. (`prev`/`next` in `effects()` are decoded raw snapshots, not the interpolated values — so `hpDelta` is the true inter-snapshot hp drop.) **No `gore` byte is added to the snapshot** — that would be redundant data derivable from already-synced fields (CLAUDE.md: zero special-case debt).

This re-derivation is exact only for **non-lethal** impacts. Three accepted cosmetic asymmetries, all visual-only and `clamp`-bounded:

1. **u16 hp quantization** — ±1 rounding on `hp` shifts intensity by `<0.012` against `dmgRef=90`; imperceptible.
2. **Multi-hit coalescing** — two hits between snapshots show one flash edge but a doubled `hpDelta`, so the client's single re-derived burst is slightly larger. `clamp(absScale,1)` caps it.
3. **Killing-frame finisher spray is host-only.** On the frame a zombie dies it is gone from `next`, so the client's impact loop never sees it — the client shows only the **type-based `fxKill` burst** (symmetric with the host, since `fxKill` is type-keyed). The host *additionally* shows the finisher impact spray from `goreIntensity(...,hpAfter≤0)`. The dominant kill visual (the death burst) matches; the extra finisher flourish on the exact kill frame is a host-only nicety.

**Documented fallback:** if playtest reveals objectionable host/client asymmetry on impacts, bundle a 1-byte `gore` next to `flash` in `SnapZombie` (host writes `goreIntensity`, client reads it). We defer it because the re-derive path is smaller and the drift is imperceptible.

**Single-player is byte-for-byte unchanged** — it passes `goreIntensity` directly into `fxImpact`, never touching snapshot code.

### F. Performance — gibs must not starve essential FX

`spawn()` early-returns silently when `particles.length >= CONFIG.fx.maxParticles` (`fx.ts:21`) — **no priority, no FIFO eviction**. Many simultaneous hits could pin the buffer and silently drop the *next* frame's muzzle flash — a feel-first violation (the gunshot's most important cue). Gibs are the only *new, optional* particle source, so the guard lives entirely in the gib-spawn path and leaves `spawn()` untouched. It is **stateless** (no separate live-gib counter to keep in sync with expiry):

- Compute `fill = particles.length / maxParticles` at gib-spawn time.
- **Hard cap:** if `fill >= cfg.gibFillCap` (e.g. `0.85`), emit no gibs this hit — reserving headroom so muzzle/spark/blood always have room.
- **Throttle:** otherwise scale gib count by `(1 - fill)` so gibs self-thin as the buffer fills.

This is the minimal guard; if playtest still shows muzzle-flash dropouts, escalate to a priority/eviction policy in `spawn()` (a larger change, deferred until proven necessary).

### CONFIG additions (`config.ts`, `fx.gore`)

`dmgRef`, `lowHpBand`, `finisherBonus`, `specks: [min,max]`, `poolScale`, `sparks: [min,max]`, `gibThreshold`, `gibCount: [min,max]`, `gibFillCap`, `woundTint`, `woundDarken`. All tuning happens here, not in systems (including the `gibFillCap` ratio — no hard-coded fill math in `fx.ts`).

## Testing

Per CLAUDE.md, only pure/deterministic code is unit-tested:

- `goreIntensity()` — co-located `fx.test.ts` (or `gore.test.ts`). Cover the four cases above + boundaries (`hpAfter <= 0`, `fracAfter` at `lowHpBand`, clamp saturation).
- **Equivalence test:** the host path (input `dmg`) and the client path (input `hpDelta`) call the *same* function, so one test asserting representative `(dmgDealt, hpAfter, maxHp)` triples land in the expected range covers both. Add a case at the u16-rounded `hpDelta` to confirm it stays in the same band after `clamp`.

The FX *look* (particle counts, gib spray, wound tint) is **not** unit-tested — it is validated by playtest.

## Feel-first acceptance (playtest, not just compile/test)

Run `bun run dev` and confirm by feel:

1. Heavy weapons visibly gorier than light ones; finishing a near-dead zombie pops it satisfyingly.
2. A light tap on a full-HP mob is *not* over-gored (no accidental gib spray).
3. Wounded zombies read as wrecked without a bar; finisher targets stay visible inside the cone (not blacked out).
4. **Muzzle flash never disappears** under sustained fire into a crowd (the perf guard works) — this is a pass/fail criterion, not a nicety.
5. No floating numbers, no HP bars anywhere.
6. (Co-op) host and client gore look acceptably similar; no jarring asymmetry. Validate wound visibility jointly when Spec ④ lands.

Not done until felt.

## Implementation order

Each step is sized to compile + pass tests on its own (the `intensity = 0` default is what lets the signature change land without touching the 5 non-combat callers).

1. `goreIntensity()` pure fn + tests (TDD). `fxKill` untouched throughout.
2. `fx.gore` CONFIG block.
3. Add the optional `intensity = 0` param to `fxImpact` and implement intensity scaling + the stateless gib fill-cap/throttle. The other 5 `fxImpact` callers compile unchanged (arg omitted). tsc stays green.
4. Combat call sites pass intensity: `bullets.ts:45` and `player.ts:236` compute `goreIntensity(...)` and pass it; drop their `fxDamageText(...)` calls. (Step 5 must land in the same change so the `fxDamageText` symbol isn't left dangling.)
5. Remove the damage-number system (C): delete `state.texts`, `DamageText`, `fxDamageText`, the `sysFx` text-decay loop, the `game.ts:611-615` draw loop, and `texts: []` in `state.ts`. Keep `R.number`.
6. Client re-derive: at `client.ts:240`, compute `hpDelta`/`frac` and pass `goreIntensity(...)`.
7. Remove the zombie HP bar (`game.ts:524-530`) + add the wound tint (D).
8. Playtest single-player against the §"Feel-first acceptance" checklist; then co-op (validate impact symmetry + defer wound-visibility judgement to the joint Spec ④ playtest).
