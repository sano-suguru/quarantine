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

### B. `fxImpact` / `fxKill` scale with intensity

`fxImpact` gains an `intensity` param: `fxImpact(state, x, y, dir, color, intensity)`.

- Blood speck count, blood-pool radius, and spark count are `lerp(min, max, intensity)`.
- Above `cfg.gibThreshold`, emit a few `"shard"` gibs (count scales with intensity), biased along `dir` so they spray in the hit direction.
- **Floor = no regression:** at `intensity = 0`, output must not drop below today's fixed burst (6 sparks + 3 specks).
- `fxKill`'s `big` boolean is replaced by an intensity-derived continuous value so the death burst is continuous with the impact burst rather than a hard two-state.

### C. Remove the damage-number system

Delete: `state.texts`, the `DamageText` type (`types.ts`), `fxDamageText` (`fx.ts`), the text-decay loop in `sysFx`, the draw loop (`game.ts:611-615`), and `texts: []` in `state.ts`.

**Keep `R.number`** — it is still used for the co-op player-id label (`game.ts:723`).

Call-site edits: `bullets.ts:45-46` and `player.ts:236-237` drop the `fxDamageText(...)` call and pass `goreIntensity(...)` into `fxImpact`. The hit is applied before the FX call, so `dmgDealt`, `hpAfter` (= `z.hp` post-subtraction), and `maxHp` are all in hand.

### D. Zombie HP bar → wound visual

- Remove the HP-bar draw (`game.ts:524-530`).
- Add a wound tint driven by `frac = z.hp / z.maxHp`: blend the body color toward a blood color (`woundTint`) as `frac → 0`, plus a **conservative** darken (`woundDarken ≈ 0.18`). A near-dead zombie visibly looks wrecked.
- **Blood-blend is the primary channel; darken is deliberately small.** Strong darkening would sink a near-dead zombie into black even *inside* the flashlight cone, killing finisher visibility and fighting Spec ④. The body is non-additive, so the tint already darkens to black *outside* the cone via the shader (`instance.frag:160`) — no extra work, no leak.
- The hit-flash (`z.flash`) is a transient brighten that composes on top; leave it.
- Draw-only. Identical on host, client, and single-player (`hp`/`maxHp` are synced — see E).

### E. Co-op — re-derive intensity on the client (no new field)

The client never runs `update()`; it re-derives combat FX from the prev→next snapshot diff (`client.ts:222-265`). Everything intensity needs is **already synced**:

- `flash` is synced and the client already fires `fxImpact` on its rising edge (`client.ts:238`) — the **hit edge**.
- `hp` / `maxHp` are synced per zombie (`snapshot.ts` 89-90/198-199/355-356) — the **magnitude**.

So at the flash edge the client computes `hpDelta = prev.hp - next.hp` and calls the same `goreIntensity(hpDelta, next.hp, next.maxHp, cfg)`. **No `gore` byte is added to the snapshot** — that would be redundant data derivable from already-synced fields (CLAUDE.md: zero special-case debt).

**Known cosmetic imprecision (accepted):** u16 hp quantization and multi-hit coalescing (two hits between snapshots → one flash edge but a doubled `hpDelta`) can make the client's gore burst slightly larger than the host's. This is visual-only, `clamp`-bounded, and imperceptible in combat (a few extra blood specks).

**Documented fallback:** if playtest reveals objectionable host/client gore asymmetry, bundle a 1-byte `gore` next to `flash` in `SnapZombie` (host writes `goreIntensity`, client reads it). This is the duck-recommended approach; we defer it because the re-derive path is smaller and the drift is imperceptible.

**Single-player is byte-for-byte unchanged** — it passes `goreIntensity` directly into `fxImpact`, never touching snapshot code.

### F. Performance — gibs must not starve essential FX

`spawn()` early-returns silently when `particles.length >= CONFIG.fx.maxParticles` (`fx.ts:21`) — **no priority, no FIFO eviction**. Many simultaneous hits could pin the buffer and silently drop the *next* frame's muzzle flash — a feel-first violation (the gunshot's most important cue). Two guards, both in the gore layer (the `spawn()` mechanism is unchanged):

1. **Gib sub-budget:** gibs draw from a dedicated ceiling (`gibBudget ≈ 240`, ~10% of `maxParticles`). Skip gib spawns past it; sparks/muzzle/blood are unaffected.
2. **Fill-ratio throttle:** scale gib count by `(1 - particles.length / maxParticles)` so gibs self-thin as the buffer fills.

### CONFIG additions (`config.ts`, `fx.gore`)

`dmgRef`, `lowHpBand`, `finisherBonus`, `specks: [min,max]`, `poolScale`, `sparks: [min,max]`, `gibThreshold`, `gibCount: [min,max]`, `gibBudget`, `woundTint`, `woundDarken`. All tuning happens here, not in systems.

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

1. `goreIntensity()` pure fn + tests (TDD).
2. `fx.gore` CONFIG block.
3. `fxImpact`/`fxKill` intensity scaling + gib sub-budget/throttle.
4. Host call sites (`bullets.ts`, `player.ts`): pass intensity, drop `fxDamageText`.
5. Remove damage-number system (C).
6. Client re-derive (`client.ts:240`).
7. Remove HP bar + add wound tint (D).
8. Playtest (single-player), then co-op.
