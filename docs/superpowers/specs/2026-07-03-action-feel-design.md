# Action Feel — Design

**Date:** 2026-07-03
**Status:** Approved (direction & scope); revised after independent spec review; pending user review
**Part of the "diegetic feedback" initiative** (show, don't tell) — sibling to the combat-gore, HUD-de-tell, and integrity specs.

## Problem

QUARANTINE's design principle is **feel-first**: game-feel is the product. Several timed/rooted/held player actions currently *report themselves with a progress bar (or nothing)* instead of letting the player *feel their character doing the thing*. The player's own words: 回復は「待ちのバーがでるだけで回復している感がない」.

Weapon-switch is the counter-example that proves the fix: it feels right **because the weapon rig visibly re-readies** (dip → raise, `drawWeaponRig`). The actions below lack that — the feedback lives on a bar or on the target, never on the acting character.

Audit of every timed/rooted/held action (excluding the already-good weapon-switch, pickup auto-collect):

| Action | Trigger | Current feedback | Missing |
|---|---|---|---|
| **回復 (heal self, H)** | `player.ts:85` `healT` | static green glow + progress bar | motion, living aura, prop, payoff |
| **物漁り (search, stand still)** | `player.ts:321` cache `searchT` | progress bar **on the crate** | player rummage motion, crate reaction, ongoing dust, loot payoff |
| **リロード (reload)** | `player.ts:140` `reloadT` | progress bar under player | reload gesture on the rig, eject, ready-clack |
| **バリケード修理 (repair, E)** | `player.ts:342` `repairCd` | **nothing** but one `Audio.repair()` | all three: swing motion, spark/dust, "repaired" payoff |
| **設置物の配置 (deploy, Q)** | `game.ts:1123` `applyPlace()` | instant pop-in + generic UI sound | place motion, landing burst |
| **蘇生 (revive downed mate)** | `assist.ts:37` `assistT` on target, `CONFIG.assist.reviveTime` | progress bar **on the downed body** | reviver motion/aura, completion burst |
| **仲間へ回復 (heal mate, E)** | `player.ts:336` `repairCd` | nothing visible | give-gesture, receiver glow, +HP pop |

## Goal

Make each of the seven actions **felt on the acting character and the world**, not merely reported by a bar. Bars stay (they carry precise info); they stop being the *only* feedback.

**Non-negotiable:** ride existing mechanisms — the weapon-rig pose animation (`drawWeaponRig`), the FX particle system (`fx.ts`), and procedural sprite transforms in `drawPlayer`. One shared "action feel" vocabulary, applied per action — **no bespoke per-action draw branch, no special-case debt** (CLAUDE.md). All tuning in `CONFIG`.

## Non-goals (scope fence)

- **Flashlight battery** is out — it's a passive drain, a different category (shader tremor already covers it).
- **Weapon-switch is not reworked.** Optionally a cheap completion "ready" flash may be added for consistency; anything more is out of scope (it already feels right).
- **No new skeletal art.** The player is a fixed textured sprite; all "motion" is procedural transforms + overlay props (composed viz parts) + particles.
- **No sim/AI/economy changes.** `searching`'s existing night-noise → AI-surge behaviour (`ai.ts:121`) is untouched; this spec only adds draw + FX + minimal synced draw-state.
- **No change to what the actions *do*** (heal amount, search time, repair cost, revive time, deploy placement rules) — cosmetic/feel only.
- **No floating text labels** (`+HP` / `LOOTED` / etc.). The diegetic-feedback initiative *deliberately removed* floating damage numbers (they "read as accounting and fight the dread" — see `2026-06-30-combat-gore-feedback-design.md`), and no floating-text mechanism exists in the code anymore. Reintroducing one for payoffs would contradict that initiative. Payoffs are **diegetic only** (flash, particle burst, color, audio).

## Design

### A. The shared "action feel" vocabulary

Every in-scope action expresses itself through up to four channels. Not every action uses all four; each is a small, reusable helper, never a per-action code path.

1. **Character motion** (`drawPlayer`, game.ts) — an action-driven offset added alongside the existing `recoilX/recoilY`: a small **lean** toward the action's focus (crate / wall / mate / aim) plus a **periodic bob/jitter** (sin of `state.time`, phase-scaled). Amplitude and frequency per action from `CONFIG`.
2. **Overlay prop** — a composed viz-part prop posed by action phase: medkit/cross (heal), tool (repair). Reuses the exact rect/circle/tri/hex/ring **part-dispatch** weapons already use — **not stacked primitives faking a shape** ([[extend-mechanism-over-fake-with-primitives]]). *Pose coords are separate from the weapon rig's:* `drawWeaponRig` poses parts along the aim-forward axis, so a prop sharing that axis would overlap the gun. Extract the part-dispatch into a shared helper and give props their own **off-hand pose origin** (lateral offset), invoked as a second call — dispatch shared, pose independent.
3. **Ongoing particles** (`fx.ts`) — a throttled emitter while the action runs: green motes rising (heal), dust/debris off the crate (search), sparks/dust off the wall (repair), a tending aura mote for revive/mate-heal. Bounded by the existing particle cap.
4. **Completion payoff** (`fx.ts` + audio) — a **diegetic** burst (flash / particle spray / color pulse) + an audio accent on the transition edge. **No floating text** (see Non-goals): woundedness/heal/loot read from the visual event, not a label.

### B. Where the channels are driven from — one derived action channel

Draw and FX need, per player, *what action is active and its 0..1 phase*. The single draw driver is **one pure function**:

```ts
// deriveActionChannel(player, state) → { kind: ActionKind, phase: number }   (pure, unit-tested)
```

It **normalizes existing state into a kind+phase**, so the call site in `drawPlayer`/FX has no per-action branch — this is the "one vocabulary" guarantee. Sources, ordered by what already exists vs. what must be added:

**Derivable from already-synced state (no new fields):**
- **reload** → `reloadT / wd.reload`; **heal** → `1 - healT/dur`; **switch** → `1 - switchT/drawTime` (these three already drive the bar/rig).
- **revive (reviver)** → derived on the client from the *downed target's* synced `assistT` + proximity (the nearest standing teammate is the reviver); phase = `assistT / reviveTime`.
- **place** → *not a rooted action at all* — see §D; it's a draw-only spawn-in on the new deployable id, no per-player channel.

**Requires a minimal new synced per-player signal (the genuinely non-derivable cases):**
- **search** — `searchT` lives on the *cache*, so which player is rummaging isn't recoverable client-side (co-op: several could stand near one crate). Generalize the existing `p.searching` flag to day+night and **sync it** (1 bit).
- **repair / mate-heal** — these are **discrete held-E taps every `repairCd` (0.35 s)**, not continuous actions. A per-tick "acting now" flag is ~1 sim-tick (~16 ms) and would fall between snapshots (~20–30 Hz) → motion and payoff vanish on remote players. **Fix: convert the discrete tap into a decaying swing-ramp** — on each fire the host sets a per-player `swingT = CONFIG.actionFeel.swingDecay` (~0.3 s) that decays to 0; `deriveActionChannel` reads it as phase. This single transform solves three things at once: (a) a single tap still shows one full swing, (b) held-E re-ignites before decay so the motion reads continuous, (c) a ~0.3 s signal survives the snapshot rate. `swingT` (+ a 1-bit kind: repair vs mate-heal) is the only real new synced state.

So the new wire cost is: `searching` (1 bit) + `swingT` (u8) + swing-kind (1 bit) per player — ~2 bytes × ≤4 players. Systems only *write* these (net-agnostic); `deriveActionChannel` is the only *reader*. **Any change to the wire layout must bump `PROTOCOL_VERSION`** (`net.ts`) so a mixed-version client refuses rather than mis-decodes; extend the snapshot round-trip test.

### C. Co-op (host-authoritative, client re-derives)

Systems stay net-agnostic — they only mutate state/timers. Rendering consumes state. Concretely:

- **Motion + props** are pure functions of `deriveActionChannel` → identical on host, client-local, and remote players for free.
- **Ongoing particles** are spawned host-side in the systems via `fx.ts`; the client **re-derives** them from the derived action channel each frame (same pattern the client already uses to re-derive hit/blood FX from snapshot diffs — see `net/client.ts`, where `effects(prev, snap)` runs on every *accepted* snapshot). Cosmetic-only, so a slightly steppier remote emission (snapshot rate) is acceptable, exactly like the remote melee sweep. The swing-ramp (§B) is precisely what keeps the discrete repair/mate-heal readable here.
- **Completion payoff — anchor on persistent / semi-persistent state diffs, NOT transient flags.** The unreliable/unordered snapshot channel drops ticks, so `prev→snap` can jump across the exact tick a transient flag was set. Choose edges that survive a skipped tick:
  - **search done** → `cache.looted` `false→true` (permanent — never missed), *not* `searchT` reset.
  - **repair done** → barricade `hp` reaching `maxHp` (already in snapshot).
  - **mate-heal** → receiver `hp` rise + giver `medkits` decrement (both synced).
  - **revive done** → downed player `hp` `0→>0` (semi-permanent).
  - **reload done** → `reloadT` `>0→≤0`; **heal done** → `healT` `>0→≤0`.
  - **place** → a **new deployable id** appears (mirrors kill-by-id-vanishing, inverted).
- **Local player predicts its own payoff; remotes re-derive.** For your *own* action, fire the payoff (esp. audio) immediately on the local edge — re-deriving it from snapshots would lag it by `interpDelay` and dull the feel. This matches the existing local fire/heal prediction; remote teammates' payoffs come from the re-derived diffs above. Guard against double-play (predicted + re-derived) with the same one-shot gating existing re-derived SFX use.

Single-player must stay byte-for-byte unchanged in the sim; all additions are draw/FX + the (host-written, snapshot-carried) signals in §B.

### D. Per-action specifics

- **リロード** — extend `drawWeaponRig` to also respond to `reloadT` the way it responds to `switchT`: the gun dips/tilts (mag out) then re-seats as `reloadT → 0` (reuse the existing `raise`/ease/dip math, keyed on whichever of switch/reload is active). Note this reworks *the gun's own pose* — no overlay prop, so no rig-overlap. Start: eject a shell/mag particle (`fx`). Complete: brief ready-pop + the existing `Audio.reloadDone()` carries the clack. Bar stays.
- **回復 (self)** — replace the static aura with a **pulsing** (breathing, sin-driven) green glow; raise a **medkit/cross prop** to the chest at the off-hand pose origin (viz parts, §A.2); slight hunched bob; green motes rising while `healT` ticks. Complete: green flash burst + up-chime.
- **物漁り** — player **leans toward the crate + periodic dig bob** (`kind = search`, from the synced `searching` flag); the **crate lid rattles** (offset its existing rects by sin noise while `searchT > 0`); dust/debris kicks off the crate. Complete (`looted` edge): loot-pop burst (pickups already spawn — add the punch).
- **バリケード修理** — a **swing/hammer motion** toward the wall (tool prop at off-hand origin; `kind = repair`, driven by the swing-ramp §B); **sparks + dust** at the repair point each swing. Complete (barricade `hp → maxHp`): a "repaired" flash on the segment. Keep `Audio.repair()`; add a completion accent.
- **設置物の配置** — **sim placement stays instant and atomic** (`applyPlace`, `game.ts:1123` — no rooting, no cancel window). The feel is **draw-only**: the new deployable rises/settles with a scale-in + landing ring + dust, reusing the existing zombie `spawnT` emerge pattern (`game.ts:499`) keyed on a per-deployable spawn timestamp. Client re-derives the burst from the new-id edge. Replace the generic `Audio.ui()` with a place/thud accent. (Name the draw state `place`, matching `CoopEvent.place` — **not** `deploy`, which is the separate "leave shop, start day" event.)
- **蘇生** — the **reviver** gets a tending motion (kneel-lean + bob) and a **tending aura**, plus a faint beam/glow linking helper→downed body while the target's `assistT` charges (today only the body's bar shows). Reviver + phase are derived client-side from the target's synced `assistT` + nearest-standing-teammate. Complete (target `hp` `0→>0`): a revive shockwave burst + an accent (not the phase-change `Audio.dawn()`).
- **仲間へ回復** — a **give-gesture** lean toward the mate (swing-ramp, `kind = mateHeal`); a brief **glow on the receiver** on the receiver's `hp`-rise edge; a short medkit-prop flash on the giver. Uses the instant path (mate keeps fighting, not rooted).
- **武器切替 (optional)** — a small ready-flash/scale-pop when `switchT` hits 0, for consistency. Low priority; may be dropped.

### E. CONFIG

A new `CONFIG.actionFeel` tree (sibling of `CONFIG.fx`) holds all tunables: per-channel motion amplitude/frequency, prop offsets, particle rates/counts/colors, payoff burst sizes, and per-action overrides. No magic numbers in systems or draw. Values are first-pass; **the player locks them by playtest** (feel-first — this spec does not claim any value "feels right").

## Testing

Per CLAUDE.md, only pure/deterministic code is unit-tested; feel is validated by playtest.

- **Unit-testable (add tests):** the new pure helpers — `deriveActionChannel(player, state) → {kind, phase}`, `actionMotion(kind, phase, cfg) → {lean, bob}`, the swing-ramp decay, and the reload/switch rig-phase selection if extracted. Co-locate as `*.test.ts`.
- **Snapshot round-trip:** extend the existing snapshot tests to cover the new synced fields (`searching`, `swingT`, swing-kind) — encode → decode identity within quantization. Bump `PROTOCOL_VERSION` and confirm the mismatch path still refuses cross-version.
- **Not unit-tested (playtest):** all motion/particle/payoff *feel*. The acceptance bar is subjective and the player's: each action should read as "my character is doing this," not "a bar is filling." Verify in single-player first, then co-op (remote player shows the same motion + re-derived particles/payoff).

## Rollout

Ordered so the **riskiest shared mechanism (the synced action channel + co-op re-derivation) is validated early**, not last — the reverse of "do the easy single-player ones first." reload/heal don't touch the channel, so they'd leave the mechanism untested until deep in the sequence; instead:

1. **Draw/FX common helpers + リロード** — build the shared pieces (`actionMotion`, extracted part-dispatch, `deriveActionChannel` skeleton, a diegetic payoff burst) as a thin spike, proven first on reload (existing timer, no new sync). Establishes the pattern.
2. **回復 (self)** — the original complaint; exercises the off-hand prop + pulsing aura + diegetic payoff. Still single-player-only state.
3. **物漁り** — **first use of the synced channel** (`searching`) + co-op re-derivation (loot burst on `looted` edge). Flush out the net design here, early.
4. **蘇生** — first client-side reviver derivation from the target's `assistT`. Co-op path proven before piling on more.
5. **バリケード修理 / 仲間へ回復** — the swing-ramp (§B) transform, discrete→continuous, both single-player and co-op.
6. **設置物の配置** — draw-only spawn-in (lowest risk; no new sync).
7. **武器切替 ready-flash** — optional, only if it earns its place.
