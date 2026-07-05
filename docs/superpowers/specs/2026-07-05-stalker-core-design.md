# The Stalker — Core Differentiator Design

**Date:** 2026-07-05
**Status:** Direction & scope brainstormed and feel-validated via throwaway prototype; **revised after independent (rubber-duck) review against the codebase**; **pending user review**, then plan.
**Kind:** New core mechanic (game identity), not a feel-polish pass. Establishes QUARANTINE's differentiation.
**Sequencing (decided 2026-07-05):** this rides on two engine foundations it currently lacks — **(1) wall occlusion of light/vision** (enables "lurks behind walls / edge of light", and independently fixes aim-through-buildings) and **(2) enemy navigation around walls** (enables "routes to the least-watched opening", and independently fixes the too-dumb beeline crowd). Both are built **before** the Stalker, as their own specs. Implementation order: light occlusion → AI navigation/behavior spectrum → Stalker.

## Problem

Top-down day/night zombie siege is a flooded genre (SAS3, 7 Days to Die, countless survivors-likes). QUARANTINE needs **meaningful** differentiation — not "weird for its own sake," but a sharp identity — while staying an indie built on the existing engine.

Two findings from brainstorming drove this design:

1. **The genre's fun and its horror pull opposite ways.** "Sweep satisfaction" (a strong player mowing a horde — SAS3) is easy to build but drifts *away* from fear. "Attrition/being cornered" (horror) is what we want but hard to build. A clever *single mechanic* won't carry the game — a throwaway "noise = the crowd swarms you" prototype felt flat, because taxing the fun crowd-combat just suppresses the fun.
2. **What's fun is proven by precedent — when the pieces are attached correctly.** The fear-generating layer belongs on a **separate apex predator**, not on the crowd. See §Pillars.

The current game's crowd combat is already fun (confirmed by the user). So the differentiator must **add a fear layer on top without diluting the crowd combat**.

## Goal

Add **one persistent apex entity — "the Stalker: the one that learns you"** — that hunts the player personally, on top of (never replacing) the existing fun crowd combat. Its terror is produced by **behavior + a light/attention resource dilemma + a dedicated telegraph (audio/FX) system** — *not* by the sprite's form. It must be **fair (heard before seen), legible, and beatable-by-evasion, never by normal firepower.**

The result is a fusion no top-down game commonly ships: **Darkwood's dread + 7 Days to Die's prep loop + a Resident Evil 2 Mr. X-style pursuer.**

## Pillars (design touchstones — we already stand on two of them)

We do **not** import these as new feature sets. QUARANTINE already sits on the first two at the skeleton level; we **sharpen** them and let the Stalker bind them.

- **Darkwood (atmosphere pillar)** — top-down oppressive dread, light/dark as the survival axis, *you are prey at night*, sound matters. Already present: gloom lighting ([[lighting-gloom-albedo-model]]), aimed flashlight cone, day/night siege. → sharpen.
- **7 Days to Die (prep-loop pillar)** — day explore/loot → night siege, fortify & repair barricades, loot-to-afford-defense economy, escalating nights. Already present: barricade repair, caches, waves, day/night, salvage meta. → sharpen.
- **Resident Evil 2 Remake — Mr. X (the differentiator)** — a persistent, **noise-driven, unkillable** pursuer that coexists with normal combat. This is the new layer. Its proven fun-factors are the design spec for our Stalker (§Mr. X fun-factors).

**The Stalker is the keystone.** Darkwood's "sound & light = survival" and 7DtD's "your day actions become your night's cost" both flow into the Stalker's two mechanics — immediate noise-attraction and cumulative menace. One entity fuses both pillars into a single identity.

## Non-goals (scope fence)

- **No quarter-view / isometric rewrite.** The original impulse (立体感) is deferred: top-down carries dread through behavior, light, and audio — validated by prototype. If depth is wanted later, it comes from lighting/shadow work, not a perspective rewrite that would touch renderer, depth-sort, collision, and the flashlight lighting model.
- **No 7DtD sandbox depth.** No crafting trees, no block-by-block building, no farming/vehicles/skill trees, no open-world persistence. QUARANTINE is a tight run-based horror, not a survival sandbox.
- **The Stalker is not killable by normal weapons.** Making it beatable with firepower collapses the fear (a Mr. X you can gun down is a trash mob). Phase 1: it can only be *warded* (light) and *evaded*; contact is a major scare, then it withdraws.
- **No arcade text callouts in-action.** Consistent with the diegetic-feedback initiative (floating damage numbers were deliberately removed — they "read as accounting and fight the dread", see `2026-06-30-combat-gore-feedback-design.md`). The grab/scare is conveyed by screen collapse + camera lurch + audio stinger + drag, **never a "掴まれた！" label.**
- **No feel regression; correct co-op invariant.** The Stalker is a **core mechanic present in both single-player and co-op** — it deliberately *changes* single-player, so "single-player byte-for-byte unchanged" (the CLAUDE.md invariant, which is about *co-op edits not touching the SP path*) does **not** apply to the feature itself. The real invariants: (a) adding the Stalker must **not regress existing ballistics / movement / camera / crowd-sweep feel**; (b) systems stay net-agnostic (state + events, never importing net code); (c) the Stalker is host-authoritative. Since `sysAI` and feel are not unit-tested (only pure functions are — CLAUDE.md), (a) is guarded by **playtest feel gates**, not tests.

## Mr. X fun-factors → design principles (port these, they are the point)

Mr. X was *fun*, not just scary. Six reasons, each a principle we must honor:

1. **Whole-map tension field.** He's always *maybe* near, so every room/backtrack carries dread. → The Stalker makes the whole night map a hunting ground, not a scripted scare.
2. **Legible via sound — heard before seen.** Footsteps telegraph distance/direction; you *read* the threat and outmaneuver it. **Fairness is non-negotiable.** → A dedicated audio telegraph is the Stalker's primary "reading" tool; it never punishes without warning.
3. **Breaks your plans → emergent evasion stories.** He interrupts your intent; you improvise (reroute, lead away, duck away). → Requires map geometry that affords looping/hiding/rerouting.
4. **Resource dilemma — can't kill, warding costs.** Staggering him burns ammo you need for zombies. → Warding the Stalker with light costs battery *and* means your light is off the crowd: **"crowd or Stalker."**
5. **Fear → mastery arc.** You learn his patterns and the map, and earn the satisfaction of *outplaying* him. → The Stalker must be *learnable and evadable*, so competence is a payoff. Fear-only exhausts.
6. **Pacing / relief.** Not constant; safe beats between pursuit. Alien Isolation's flaw is relentlessness. → The Stalker is an occasional apex predator, not omnipresent; lit shelter is temporary safety.

## Design — Phase 1 (the felt core, in-engine)

The smallest slice that proves the terror is real in gloom.

**Sprite prerequisite (blocks everything else):** the art is *chosen* (generated & design-adopted: cold blue-grey, contrasts the crowd's warm tones, distinct radial silhouette — top-down-appropriate) but **not yet in the repo**. Before any ENEMY_TYPES/render work: export it to `game/assets/sprites/stalker.png` (128²) **and** add `"stalker"` to `REQUIRED_SPRITES` (`spriteAssets.ts`). The load gate (`game.ts:537` — every EnemyType needs a sprite, no SDF fallback) and `enemies.test.ts`/`spriteAssets.test.ts` will otherwise fail the moment a `stalker` entry is added.

### Behavior

- **Night only; single instance;** separate from the wave queue. Lurks in the dark at the edge of vision.
- **Light relationship (core):** advances toward the player while **outside** the flashlight cone; a cone touch **staggers/recoils** it — and (crucially) that stagger **lingers for a fixed window** after the beam leaves, so warding is a *flick*, not a continuous hold (see Warding below). (Weeping-angel × light, but forgiving enough to be readable.)
- **No `chasing` latch.** The crowd latches to permanent pursuit at night (`autoAggro` → `chasing` never reverts, `ai.ts:61`/`types.ts:223`). The Stalker must **not** use that model — it runs its own state machine (**aggro ↔ lull**, driven by noise, §below), so "moving quietly lets you evade" is actually possible.
- **Noise attraction via the unified noise model — immediate (the Mr. X mechanic):** firing (louder weapons more), running, and cache-rummaging emit **noise sources** (position + intensity + decay) that draw the Stalker toward the loudest/nearest source (and let it pick "the loudest player" in co-op); quiet lets you evade. **This noise model is defined and owned by the AI-navigation spec** (`2026-07-05-enemy-ai-navigation-design.md`) — its hearing and the existing crowd `lure` (`ai.ts:117`) are the first consumers; the Stalker just reads the same sources. One noise concept across crowd, `lure`, and Stalker — positional (not a single global scalar), so per-source locality and "whose noise?" are preserved. *This is the "noise-aggro" idea from early brainstorming, now attached to the unkillable Stalker (and the crowd) through one shared model — which is why it works here and fell flat when it was a bespoke crowd-only tax.*
- **Warding = cooldown stagger, NOT continuous drain.** A *brief* light touch staggers/recoils it for a fixed window (then it resumes). It does **not** require holding the beam on it. Rationale (from review): continuous-hold-drains collides with an already-tight battery economy (~60 s full charge vs much longer nights, `config.ts`) — the tuning window would vanish; it also invites the degenerate "pin the light one direction and turtle." A stagger-on-tap ward preserves the "crowd or Stalker — where do I flick my light *this instant*" choice without forcing constant-on. Battery cost of a ward-flick is small and CONFIG-tuned.
- **Approach direction (anti-turtle):** HOME is a walled fort with four boardable openings (`map.ts`). To avoid the Stalker being absorbed into the crowd funnel (it comes through the same opening the player is already lighting/shooting → harmless), it **approaches from a different vector than the crowd the player is currently engaging** (another opening / behind). Whether it respects wall collision or phases through is a Phase-1 decision (default: respects walls but routes to the *least-watched* opening).
- **Unkillable (Phase 1):** only warded/evaded. **Contact = major scare** (heavy damage) then it withdraws — not chip damage, a "*it got me*" beat.
- **Retreats at dawn.**
- **Aim-assist:** light stays coupled to aim; `aimAssist` (opt-in, default OFF — `settings.ts`) is framed as an accessibility option that *trades away* Stalker tension, and **the Stalker is excluded from aim-assist target selection** (so it neither auto-wards nor is ignored-into-unfairness). Most players (default OFF) get the full horror.

### Telegraph & perception FX — a NEW dedicated subsystem

Deliberately **built fresh**, not bolted onto the existing ambient dread wiring. Overloading the ambient system to fake this would be the exact "fake with primitives / special-case" debt we avoid ([[extend-mechanism-over-fake-with-primitives]]); a genuinely new entity earns a genuine new mechanism.

- Driven by **proximity × unlit** (dread rises as it nears while unobserved). Escalating tells:
  - flashlight cone **flicker** (approach cue),
  - **audible footfalls** — distance/direction-legible, the primary reading tool (Mr. X principle #2),
  - **fleeting false silhouettes** at the edge of vision (perception unreliability — like the existing `darts`, `game.ts:342`, which carry **no hitbox**),
  - **rising heartbeat**, **red vignette** at high dread.
- **Fairness invariant (real vs. fake must be distinguishable):** the fairness principle (#2) and the perception-lies goal only coexist if the player can tell a real cue from a fake one. So:
  - **Any cue that precedes a real consequence is always a real cue.** The Stalker never reaches you without a *true* telegraph first.
  - **Real vs. fake are encoded differently:** real approach = a **localizable** directional footfall (you can point to it); fakes (false silhouettes, phantom steps) are **non-localizable** (rustle/ringing, no stable direction) and carry **no hitbox**. Lies unsettle; they never kill. This keeps "I heard it and reacted" a *learnable skill*, not a coin-flip.
- **Audio priority (anti-mask):** on dense nights the crowd's screech/groan (already thinned at saturation — `maxConcurrentVoices`/`lurkThinAt`, `config.ts`) can mask the Stalker's telegraph. The Stalker's telegraph audio takes a **reserved channel / priority + brief ducking of crowd voices** so it stays legible exactly when it matters most.
- **Grab/scare presentation:** diegetic only — view collapse + camera lurch + stinger + drag. No text.

### How it's built — an INDEPENDENT subsystem (corrected after review)

The original draft claimed the Stalker could ride `sysAI` via a "general light-relationship flag, not a Stalker-only path." Reading `ai.ts` proved that **self-deception**: pass1 is a single "steer toward nearest player + permanent `chasing` latch" model, pass2 is a hard de-overlap, and no other enemy would use the new behavior — so a flag would be a Stalker-only branch inside the shared crowd loop. The **principled** move (and the one truly faithful to "zero special-case debt") is the opposite: **the Stalker is its own clean subsystem, not an exception spliced into the crowd AI.**

- **Separate slot, not the crowd array.** `state.stalker: Stalker | null` (its own step function `sysStalker`, called from `update()` in the fixed order). Keeping it **out of `state.zombies`** avoids three concrete breakages found in review:
  - pass2 **de-overlap** (`ai.ts:181`) would let the crowd physically shove the "unstoppable" Stalker — excluded.
  - `sysBullets` **spatial-hash bullet collision** would damage it, breaking "unkillable" (else needs a bespoke hp-immune branch) — excluded.
  - snapshot **kill re-derivation** (`client.ts:245` treats a vanished id as a kill → fxKill + Audio.kill) would fire a false "you killed it" burst when the Stalker leaves view/despawns — excluded.
- **Its own state machine:** aggro ↔ lull driven by `state.noise` + cone/light checks; **no `chasing` latch**. Cone math already exists (`ai.ts:28,46`) but is currently dread-only (lurking count) — the Stalker reuses the computation, not the crowd's motion.
- **`game/data/enemies.ts`** — a `stalker` entry still exists for stats/sprite/glow/eye (draft: high hp, medium speed, cold glow `[0.5,0.55,0.7]`, pale eye `[0.75,0.85,1.0]`), but its **movement/damage rules live in `sysStalker`**, not the shared AI.
- **Net — a dedicated snapshot block, not "just in the snapshot."** Add a small fixed Stalker block (~12–20 B: pos/state/facing) to `encode`/`decode`/`captureSnapshot`/`applySnapshot`/`lerpSnapshots`, **exclude it from the id-disappearance = kill path**, and handle its exit via an **explicit despawn/withdraw event** (client plays a retreat cue, never a kill). Host-authoritative; systems stay net-agnostic.
- **Noise:** the positional **noise sources** model (instant detectability) is **owned by the AI-navigation spec** — the Stalker reads it, doesn't define it. **New here:** only `state.menace` (cumulative, Phase 2 driver) — a small state field; existing kill/loot/night-survive paths add to it.
- **New: dedicated Stalker telegraph FX/audio subsystem** — its own module, fed by proximity/unlit, emitting through `fx.ts` and a new procedural audio path with the priority/ducking above.
- **Map (`data/map.ts`)** — evasion/loop/hide affordances (Darkwood/RE2 loopy geometry) so evasion and mastery (principles #3, #5) are possible. **Phase 1.5** unless the current layout already suffices for the feel gate.
- **Tuning** — all constants (advance speed, recoil, ward-stagger window & cost, telegraph ranges/thresholds, contact damage, noise gains/decay) live in `CONFIG`, not the systems.

### Phase 1 vs Phase 1.5 (scope cut — keep the first slice truly minimal)

The feel gates below need only: **(1)** the Stalker's motion/state machine, **(2)** the *real* footfall telegraph (localizable) + cone flicker + heartbeat, **(3)** the cooldown-stagger ward, **(4)** the grab presentation, **(5)** the `state.noise` scalar, and the sprite prerequisite + separate slot/snapshot plumbing. Everything else is **Phase 1.5**, added only after the gates pass:

- **Phase 1 (prove the terror):** motion + real telegraph + ward + grab + noise scalar + slot/snapshot/sprite.
- **Phase 1.5 (deepen, post-gate):** the *fake* perception cues (false silhouettes/phantom steps), full audio ducking/priority polish, and any `map.ts` loop/hide geometry rework.
- **Phase 2:** cumulative `menace` (below).

## Design — Phase 2 (deferred; NOT detailed here, listed so Phase 1 leaves room)

- **Fed by your play (cumulative menace) — "自分のせいでこうなった."** Loud/greedy play (noise, kills, looting, surviving nights) grows `state.menace` → the Stalker arrives **sooner / harder each night** and **remembers the shelter** (comes faster over a run). The 7DtD "day cost → night" pillar, made personal.
- **Resolution** — whether/how it can be banished (spend a big resource: flare, generator light) and any run-ending confrontation.
- **Meta-run escalation** across the salvage/unlock loop.

## Validation plan (feel-first — not done until played)

- **Done:** throwaway prototypes exercised (a) noise→crowd (felt flat — informative negative result) and (b) the Stalker's light-ward-vs-crowd dilemma + telegraph FX (user: "良いと思います", with the aim-assist concern now resolved).
- **Next:** implement the Phase 1 slice in-engine and **playtest in gloom** before any Phase 2 work. Feel gates: (1) is "hold light on it vs shoot the crowd" genuinely tense? (2) does looking away make you nervous (telegraph working)? (3) does the grab make you flinch? Any "no" → retune before proceeding.

## Open questions

- **Co-op behavior (whole area is unspecified — must resolve before co-op ships the Stalker):**
  - Whom does it target with multiple players (nearest living? highest-noise? the isolated one)?
  - A **downed** player has empty input → aim/cone is frozen → **cannot ward** while awaiting revive. Does the Stalker ignore the downed, or is this an intended "protect the fallen" pressure? Avoid an unwinnable revive wait.
  - All-down → **dawn respawn** (`revivePlayer`): does the Stalker withdraw/reset, and how does its slot/menace carry over?
- **Tuning square (not triangle):** battery **economy** (drop rate 4% / shop supply / night length ≫ ~60 s charge) is a first-class fourth variable alongside ward-stagger window ↔ advance speed ↔ telegraph range. Confirm a fair, skill-winnable window exists given current supply; the cooldown-stagger ward is the main lever that keeps it open.
- **Wall interaction:** does the Stalker respect wall collision (routes to the least-watched opening) or phase through? Default is "respects walls, routes to least-watched," but verify it can't get stuck or trivially wall-blocked.
- **First-arrival trigger** — fixed night vs a `menace` threshold (interacts with Phase 2).
- Does the single-instance Stalker slot want to generalize (future: >1, or variants) or stay strictly one?
