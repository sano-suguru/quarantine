# Action Feel — Design

**Date:** 2026-07-03
**Status:** Approved (direction & scope); spec pending user review
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

## Design

### A. The shared "action feel" vocabulary

Every in-scope action expresses itself through up to four channels. Not every action uses all four; each is a small, reusable helper, never a per-action code path.

1. **Character motion** (`drawPlayer`, game.ts) — an action-driven offset added alongside the existing `recoilX/recoilY`: a small **lean** toward the action's focus (crate / wall / mate / aim) plus a **periodic bob/jitter** (sin of `state.time`, phase-scaled). Amplitude and frequency per action from `CONFIG`.
2. **Overlay prop** (extend the `drawWeaponRig` part-dispatch) — a composed viz-part prop posed by action phase: medkit/cross (heal), tool (repair), the object being set (deploy). Reuses the exact rect/circle/tri/hex/ring dispatch weapons already use — **not stacked primitives faking a shape** ([[extend-mechanism-over-fake-with-primitives]]).
3. **Ongoing particles** (`fx.ts`) — a throttled emitter while the action runs: green motes rising (heal), dust/debris off the crate (search), sparks/dust off the wall (repair), a tending aura mote for revive/mate-heal. Bounded by the existing particle cap.
4. **Completion payoff** (`fx.ts` + audio) — a burst + a floating label (`+HP` / `LOOTED` / `REPAIRED` / `REVIVED`) + an audio accent on the transition edge.

### B. Where each channel is driven from — action state

Draw and FX need to know, per player, *what action is active and its 0..1 phase*. Three of the seven already carry a synced timer usable directly:

- **heal** → `healT` (synced), **reload** → `reloadT` (synced), **switch** → `switchT` (synced).

The other four lack a clean, **client-visible** acting-player state:

- **search** — only the *cache*'s `searchT` is synced; the player has `searching` but it's night-only and not in the snapshot.
- **repair / mate-heal** — only a shared `repairCd` cooldown; no "is repairing/giving right now" signal.
- **revive** — the timer lives on the *downed target* (`assistT`), not the reviver.

**Decision:** add one minimal, unified per-player **action channel** used purely for feel — `{ kind: ActionKind, t: number }` (kind enum incl. `none/search/repair/deploy/revive/mateHeal`; `t` a 0..1 phase or a small ramp). Systems set it (host-authoritative, net-agnostic — they only write state); `drawPlayer`/FX read it. It is added to the snapshot (a `u8` kind + `u8` quantized phase per player — ≤2 bytes × ≤4 players, negligible vs. the ~16 KB budget). heal/reload/switch keep their own precise timers for their bars/rig; the action channel is *additive* for motion + ongoing particles + payoff on the four that lack a signal. This is the "extend the mechanism" move: one state channel instead of four ad-hoc draw hacks.

### C. Co-op (host-authoritative, client re-derives)

Systems stay net-agnostic — they only mutate state/timers. Rendering consumes state. Concretely:

- **Motion + props** are pure functions of the synced timers / action channel → identical on host, client-local, and remote players for free.
- **Ongoing particles** are spawned host-side in the systems via `fx.ts`; the client **re-derives** them from the synced action state each frame (same pattern the client already uses to re-derive hit/blood FX from snapshot diffs — see `net/client.ts`). Cosmetic-only, so a slightly steppier remote emission (snapshot rate) is acceptable, exactly like the remote melee sweep.
- **Completion payoff** is an **edge**: host fires it; client re-derives it from the action-state edge (timer → 0 / `searchT` reset / `reviveT` complete), mirroring how kills are re-derived (a kill is learned by an id vanishing). Payoff audio is gated the same way existing re-derived SFX are, to avoid double-play.

Single-player must stay byte-for-byte unchanged in the sim; all additions are draw/FX + the (host-written, snapshot-carried) action channel.

### D. Per-action specifics

- **リロード** — extend `drawWeaponRig` to also respond to `reloadT` the way it responds to `switchT`: the gun dips/tilts (mag out) then re-seats as `reloadT → 0` (reuse the existing `raise`/ease/dip math, keyed on whichever of switch/reload is active). Start: eject a shell/mag particle (`fx`). Complete: brief ready-pop + the existing `Audio.reloadDone()` carries the clack. Bar stays.
- **回復 (self)** — replace the static aura with a **pulsing** (breathing, sin-driven) green glow; raise a **medkit/cross prop** to the chest (viz parts); slight hunched bob; green motes rising while `healT` ticks. Complete: green flash burst + `+HP` float + up-chime.
- **物漁り** — player **leans toward the crate + periodic dig bob** (action channel = `search`); the **crate lid rattles** (offset its existing rects by sin noise while `searchT > 0`); dust/debris kicks off the crate. Complete: loot-pop burst + `LOOTED` float (pickups already spawn — add the punch).
- **バリケード修理** — a repeating **swing/hammer motion** toward the wall (tool prop, action channel = `repair`); **sparks + dust** at the repair point each swing. Complete (wall reaches max HP): a "repaired" flash on the segment + `REPAIRED` float. Keep `Audio.repair()`; add a completion accent.
- **設置物の配置** — a quick **place/set-down motion** on `applyPlace()` (action channel = `deploy`, short ramp); the object **rises/settles with a landing ring + dust** instead of popping in; a spawn burst. Replace the generic `Audio.ui()` with a place/thud accent.
- **蘇生** — the **reviver** gets a tending motion (kneel-lean + bob) and a **tending aura**, plus a faint beam/glow linking helper→downed body while `assistT` charges (today only the body's bar shows). Complete: a revive shockwave burst + `REVIVED` float + an accent (not the phase-change `Audio.dawn()`).
- **仲間へ回復** — a **give-gesture** lean toward the mate; a brief **glow on the receiver** + `+HP` float on them; a short medkit-prop flash on the giver. Uses the instant path (mate keeps fighting, not rooted).
- **武器切替 (optional)** — a small ready-flash/scale-pop when `switchT` hits 0, for consistency. Low priority; may be dropped.

### E. CONFIG

A new `CONFIG.actionFeel` tree (sibling of `CONFIG.fx`) holds all tunables: per-channel motion amplitude/frequency, prop offsets, particle rates/counts/colors, payoff burst sizes, and per-action overrides. No magic numbers in systems or draw. Values are first-pass; **the player locks them by playtest** (feel-first — this spec does not claim any value "feels right").

## Testing

Per CLAUDE.md, only pure/deterministic code is unit-tested; feel is validated by playtest.

- **Unit-testable (add tests):** any new pure helper — e.g. an `actionMotion(kind, phase, cfg) → {lean, bob}` pure function, and the reload/switch rig-phase selection if extracted. Co-locate as `*.test.ts`.
- **Snapshot round-trip:** extend the existing snapshot tests to cover the new action-channel fields (encode → decode identity within quantization).
- **Not unit-tested (playtest):** all motion/particle/payoff *feel*. The acceptance bar is subjective and the player's: each action should read as "my character is doing this," not "a bar is filling." Verify in single-player first, then co-op (remote player shows the same motion + re-derived particles/payoff).

## Rollout

Suggested order (each independently playtestable, lands the shared mechanism first):

1. **リロード** — highest value, most direct reuse (rig already animates on switch); establishes the pattern.
2. **回復 (self)** — the original complaint; exercises prop + pulsing aura + payoff.
3. **物漁り** — exercises the action channel + crate reaction + ongoing dust.
4. **バリケード修理**, **設置物の配置** — single-player-relevant additions.
5. **蘇生**, **仲間へ回復** — co-op; exercises re-derivation on remote players end-to-end.
