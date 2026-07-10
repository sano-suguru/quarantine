# Unified Auto Controls (Vampire-Survivors-style) & Mobile-Forward Direction — Design Spec

- **Date:** 2026-07-09 (revised 2026-07-10)
- **Sub-project:** B — the first and largest of the CrazyGames bundle. Later sub-projects (embed niceties, C = CrazyGames SDK, D = metadata/cover) get their own specs.
- **Status:** Design approved in brainstorming; revised through two rubber-duck blind-spot reviews and successive simplifications. Pending user review before planning.

## What this is

QUARANTINE adopts **one control scheme on every platform: move-only, everything else automated** (Vampire Survivors / Brotato lineage). PC and mobile play identically; the only per-device difference is the movement input (WASD/keys vs a virtual stick) and menu input (mouse vs touch). Manual aiming, the manual flashlight, battery budgeting, and the Stalker light-ward are removed. The result is a casual, atmospheric, mobile-forward day/night siege co-op survival game.

Chosen for: braains.io/VS-grade pickup-and-play, perfect PC↔phone parity, and the smallest possible control surface (one scheme, no per-device branching, less code).

**Positioning note:** the product's appeal is **atmosphere + casual co-op + the day/night siege loop**, not a light-puzzle. The Stalker remains a strong *atmospheric pursuer* (a threat you flee and evade), not a ward puzzle — it is explicitly no longer framed as "the differentiator."

## Goal

Ship QUARANTINE on CrazyGames, touch-capable and portrait-first, toward the target triad: **Darkwood atmosphere (fear) + SAS3 fun (weapon growth, sweeping the horde) + braains.io casualness & easy multiplayer**. Single-player is the CrazyGames product; co-op continues (host-authoritative WebRTC).

## What is preserved vs. what changes

**Preserved (verified no behavioral diff):** the fixed-timestep sim loop and system order; enemy types, wave curve, weapon *stats*, upgrades, pickups, economy/salvage; the map/POIs; the co-op host-authoritative model and flow (shop, death/spectate, dawn respawn, gameOver/salvage sync, room-code connect); audio/dread.

**Deliberately changed (identity shift):**
- The **control scheme on all platforms** → single auto scheme. The old manual desktop scheme is removed, not branched.
- **Code removed:** mouse-aim combat path + crosshair-as-aim + the `mousedown`→`Input.firing` wiring; the `aimAssist` opt-in (auto-aim is now unconditional); the `F` flashlight toggle + `PlayerInput.lightToggle` + manual battery budgeting; the Stalker **ward** machinery (`playerWardsStalker`, ward battery cost, the aim-opposite warding/approach bias, `lightOn` gating).
- **Co-op wire simplifies (no new fields):** `PlayerInput.lightToggle` and the snapshot `lightOn` flag bit are removed; `aim` stays as-is. **Wire-compat is broken deliberately, so `PROTOCOL_VERSION` (`net.ts:19`) MUST be bumped by hand** — `versionMatches` does *not* auto-derive from the wire format; it only refuses a peer whose `PROTOCOL_VERSION` differs. The golden-byte snapshot test (`snapshot.test.ts:100`) fails on any encode change and is the backstop that catches a forgotten bump. **Do not delete the `stagger` entry from `STALKER_STATES` (`snapshot.ts:30`)** — ward removal makes `stagger` unreachable, but its wire index must stay stable (keep it as a dead state) or every later state renumbers and old/new peers silently desync.

## The single control scheme (all platforms)

**One direction, `aim`, drives everything** (gun, flashlight cone, melee, placement, dread/audio cones). `aim` is auto-derived:

> `aim` = angle to the **nearest visible zombie inside the on-screen viewport** (reusing `assistAim`, now always-on, clamped to the viewport so the gun/light never point at off-screen enemies). **When no target exists, `aim` = the current movement heading; when also idle, hold the last heading** (module-local state in `localInput`; never snaps to 0).

Consequence, and the reason model X was chosen: in combat the light shows what you're shooting; while exploring (no enemies) the light leads the way you move. No second direction, no new synced field, no split of `aim` readers.

| Action | PC | Mobile |
|---|---|---|
| Move | WASD / arrows | Floating virtual stick — the only continuous manual input (`moveX/moveY`). |
| Aim | — auto (`aim`, above) — | — auto — |
| Fire | — auto when a target exists — | Semi-autos (`auto:false`) re-trigger by **pulsing `firing`** at the weapon fire rate in the input layer (past the `firedThisHold` gate). |
| Flashlight | — always on, renders along `aim`; battery auto-drains + browns out; no toggle — | same |
| Reload | auto on empty | auto on empty |
| Interact (search / repair / revive) | auto on proximity (already auto today) + repair prompt | auto on proximity + repair contextual button |
| Weapon switch | `1/2/3` keys or click hotbar | tap hotbar |
| Heal | `H` or click | tap button (×count) |
| Fortify (Q) | `Q` or click | tap button (in-stock only). Placement direction = `aim` (threat, or movement heading when clear). **Caveat:** when idle + no enemy, `aim` holds the last heading, so placement can point in a *stale* direction; prefer the most recent movement heading at placement time. `placeSpot` steps down to the feet if blocked, so it's a feel wart, not a bug. |
| Pause / options | `Esc/P`, `O` | corner button |

The **mouse is unused for combat on PC** (VS-style); only menus/shop use it.

## Stalker (all platforms) — flee/evade threat, no ward

- **No ward.** The flashlight does not repel the Stalker. It is a pursuer you evade with movement, obstacles, and line-of-sight breaks; phantom perception (#47: fake silhouettes / non-localizable steps) is unchanged and carries the dread.
- Excluded from gun auto-aim (as today — don't waste bullets on the unkillable). It approaches from off-screen/behind and grabs; the "blind-side approach" survives as pure *atmosphere*, decoupled from any warding interaction.
- **Removed:** `playerWardsStalker`, the ward battery cost, the aim-opposite warding bias, and the `lightOn` ward gate. The #46–48 manual-ward feature is superseded (documented here so future readers know it was intentional, not lost). The `stagger` state (`stalker.ts` state machine) becomes unreachable — keep the symbol + its wire enum index (above); the core `lull→aggro→contact→retreat→despawn` machine is ward-independent and unchanged.
- **`flinchStalker` (`bullets.ts:68`→`stalker.ts:271`) becomes unreachable and is intentionally retired.** Today, manually shooting the Stalker makes it flinch (knockback + vis dip + cold spark); with auto-fire and the Stalker excluded from auto-aim, no bullet reaches it. This is consistent with "unkillable, don't fight it" — the Stalker can no longer be affected by bullets *or* light. (If a playtest says the loss hurts, a non-aim trigger can be added later.)
- **Telegraph FX shift (`stalkerFx.ts:44 stalkerIsLitByLocal`):** telegraphs are suppressed while the Stalker is lit. Since auto-aim never lights it, telegraphs will be on far more often — footfall/heartbeat rarely quiets. Add to playtest items; may need a threshold so it isn't constant.
- Battery still exists (drain + brownout, loot) purely as atmosphere/economy; it no longer affects the Stalker.

## Deletions & their collateral (from rubber-duck review)

- **`Input.firing` / mouse:** remove the `mousedown`/`mouseup`→`firing` combat wiring; auto-fire is synthesized in the input layer (`inp.firing` pulsed). Mouse stays for menus only. Remove the in-combat crosshair.
- **`aimAssist` setting:** auto-aim is always-on; remove the setting, its UI (`main.ts`), and all `getSettings().aimAssist` reads (`localInput.ts` + 2 in `main.ts`). `Settings` retains `loadout` + input-mode override, so it isn't empty.
- **`lightOn`:** retired (light always on). Remove the toggle branch in `player.ts`; battery drain/brownout stays in `flashlight.ts` (`flashlightIntensity`'s `!on` path becomes dead and is removed — **delete its `on=false→0` test at `flashlight.test.ts:17`**; the dead-battery→0 test stays). Free the snapshot flag bit (leave a hole; don't renumber the other bits: `absent`/`swingKind`/`searching`). Also drop the `lightOn &&` guard from its other consumers: the `lightDie` audio edge (`game.ts:239`) and the dust/darts atmosphere gate (`game.ts:380`).
- **Weapon hotbar (3-slot, all platforms):** `WEAPON_ORDER` has 7 entries incl. `knife` (slot 7, excluded from `isUpgradeableWeapon` + `cycleWeaponSlot`). The client-local loadout (≤3 ids, knife allowed) is remapped in `localInput` (tap/key index → absolute `WEAPON_ORDER` slot). **Wheel cycle becomes a cycle within the ≤3 loadout** (still skipping the knife per the existing filter); define this remap explicitly in planning.

## Architecture

`game/net/localInput.ts:sampleLocalInput(state)` stays the single input→sim seam.

| File | Edit |
|---|---|
| `game/net/localInput.ts` | Always-on viewport-clamped auto-aim; movement-heading fallback + hold-last idle state; semi-auto fire pulsing; loadout tap/key → `WEAPON_ORDER` slot; drop the mouse-angle fallback and `aimAssist` gate. |
| `game/net/playerInput.ts`, `game/net/snapshot.ts`, `game/net/net.ts` | Remove `lightToggle` (input) and the `lightOn` snapshot flag (leave a bit hole; keep `STALKER_STATES` indices stable). No new fields (`aim` already synced). **Bump `PROTOCOL_VERSION`.** |
| `game/input.ts` | Add touch state + `touchstart/move/end/cancel` with `preventDefault`; keep WASD/keys; remove combat mouse wiring (keep mouse for menus). **Multi-touch:** track per-`touch.identifier` so the left stick keeps its finger while a right-side tap (heal/fortify/switch) lands on another — a naive single-touch model mis-attributes the second finger. |
| `game/systems/player.ts`, `game/systems/flashlight.ts` | Remove the `F`-toggle/manual-battery branch; battery is purely automatic. Melee/placement/fx keep reading `aim`. |
| `game/systems/stalker.ts`, `stalkerFx.ts`, `stalkerPhantom.ts` | Remove ward + ward-bias + `lightOn` gate; keep pursuit/grab/phantoms/atmosphere. |
| `game/game.ts` | Flashlight cone renders from `aim` (unchanged path). Remove crosshair-as-aim. Fortify/deploy placement uses `aim` (now threat-or-movement — no stale-direction bug). |
| `game/main.ts` | Remove crosshair, `aimAssist` UI, mouse-combat handlers. Keep title torch (uses the normal light path), pause/options. |
| `game/engine/renderer.ts` + `game/config.ts` | Runtime responsive view-scale (portrait mobile widens the world view); `CONFIG.zoom` default kept for desktop-landscape. |
| HUD: `index.html`, `game/style.css`, `game/game.ts:updateHUD` | Responsive layout under `body.mobile`; touch widgets (stick, 3-slot hotbar, action buttons); safe-area insets. Remove `aimAssist` UI. |
| `game/settings.ts` / `game/meta.ts` | Client-local `loadout` (≤3 ids) + input-mode override toggle; remove `aimAssist`. |

### Device detection (for HUD/layout only — the scheme never branches)

`matchMedia("(pointer: coarse)")` + touch capability + viewport, refined on the first `pointerdown/touchstart` type; `?mobile`/`?desktop` and an in-game toggle override (hybrid devices / CrazyGames players who can't set query flags). Sets `body.mobile`.

## HUD layout (portrait-native)

Same `#hud` DOM, re-laid-out via `body.mobile`.
- **Left-bottom:** floating movement stick.
- **Right-bottom:** contextual taps — Medkit (×count), Fortify (in-stock only), Repair (only near a damaged barricade).
- **Bottom-center:** 3-slot icon hotbar (ammo/reload state, active highlight; tap to switch).
- **Top:** passive readouts — hp, battery gauge, Day, credits.
- **Safe area:** `env(safe-area-inset-*)` so widgets clear the notch/gesture bar.

One-hand claim: the core loop (move + auto everything + auto reload/interact) is playable with one thumb; right-side taps (switch/heal/fortify) are discrete.

## FOV / renderer

`viewHalfX = clientWidth/2/CONFIG.zoom` (`renderer.ts:237`). Portrait phones see a narrow slice; auto-aim currently filters by world-space `flashlight.range` only (`assistAim`, `localInput.ts:41`). Fix: responsive view-scale (portrait mobile widens the view in `resize()` under `body.mobile`; `CONFIG.zoom` default kept) **and** a **new viewport-rectangle test** on auto-aim target selection (via `Renderer.worldToScreenHalf()`, already imported in `localInput`) so gun+light never point off-screen — this is added logic, not just "always-on `assistAim`." Whichever is tighter, the view rect or `flashlight.range`, wins; document that interaction. Lighting cost stays bounded (`MAX_LIGHTS=8`, `renderer.ts:47`) and the spatial hash is world-space (view-independent); the real risk is fragment-shader fill-rate (see feel validation).

## Feel validation (feel-first)

No throwaway prototype — validate the **actual branch build** on a real device / CrazyGames embed, then hand to the user. Checklist (code can't verify):
- One thumb (mobile) / WASD-only (PC) carries the whole game; it feels like the same game on both.
- The `aim`-driven light (threat when present, movement when clear) reads as atmospheric, not disorienting.
- Auto-aim/fire feels right; never fires off-screen; target-switch hysteresis doesn't cause single-shot weapons (shotgun/magnum) to whiff annoyingly; 3 slots aren't cramped.
- The Stalker still reads as a credible, tense pursuer without a ward — and without bullet-flinch. Watch that its telegraph FX (now rarely suppressed by light) doesn't become constant and dull the footfall/heartbeat quiet.
- Mobile-GPU **fill-rate/thermal** of the flashlight + grid fragment shaders + glow at DPR≤2 (DPR capped at 2).
- Dread cues (`surrounded`/`lurking`, screech/groan) are cone-based on `aim`; confirm they still feel meaningful under a narrow portrait FOV.

## Out of scope (later sub-projects)

- CrazyGames SDK (C), metadata/cover (D). **In sub-project B (prerequisite):** `touch-action:none` + touch `preventDefault` + `user-select:none` (the stick/hotbar don't function without them).
- Sim rules, enemy/wave/weapon-stat/economy data, the co-op flow.

## Success criteria

- A new player on PC (WASD only) and on a phone in portrait (one thumb) plays the **same game with the same controls** — sweeps the horde, switches among 3 weapons, heals, survives a night.
- The Stalker remains a credible flee/evade threat (validated by playtest).
- Sim/enemy/economy behavior identical to `main`; the co-op wire only *removes* `lightToggle`/`lightOn` and keeps the `STALKER_STATES` enum stable. `PROTOCOL_VERSION` is bumped so `versionMatches` refuses old peers (golden-byte test catches a forgotten bump).
- Reads as atmospheric horror despite full automation (playtest).
