# DO Server 2b ① Milestone C-1 — `flashT`/hurt-shake client-migration + stale-comment/dead-code cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the full-screen damage flash (`flashT`) and its co-located local-player hurt camera-shake fully client-owned per-viewer cues (fixing a latent gap where the DO computes and discards them), and sweep the host-authoritative-era stale comments + now-dead game-over/deploy client code left by M-A/M-B.

**Architecture:** `flashT`/`flashColor` and the local-player hurt `cam.shake` bump live on the shared `State` today and are decayed/bumped inside the headless sim (`stepSim`, `sysAI`). Under DO authority the sim runs on the server and `State.flashT`/`flashColor`/`cam.shake` are **not** in the snapshot, so those bumps are computed and thrown away — a client never sees a normal zombie-hit flash or the hurt shake. This milestone removes them from `State`/`stepSim`/`sysAI` and re-derives them **on each client** from the local player's synced `hitFlash` edge (the same diff `client.ts` `effects()` already uses for `fxHurt`/`Audio.hurt`), plus the existing client-side stalker-scare bump. Then it deletes the dead `gameover`/`clientGameOver`/`endRun`/`requestDeploy`/`deploy` paths and fixes host-era comments.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Bun, Vite, Vitest, Biome. Pure sim in `sim/` (no DOM/WebGL/audio, enforced by `sim/tsconfig.json`); client layer in `game/`.

## Global Constraints

- **`sim/` stays headless** — no DOM/WebGL/audio imports; `flashT` decay/bump code that needs no sim state must live in `game/`, not `sim/`.
- **Derive-first fx** — combat/feel cues are re-derived on the client from snapshot diffs; nothing new goes on the wire in this milestone. `flashT` was never snapshotted and must not become snapshotted.
- **Feel-first, playtest-verified** — the flash + hurt-shake are game-feel; this milestone is **not done until played** (`bun run dev:coop`), not just compiled.
- **No `PROTOCOL_VERSION` bump** — this milestone changes no wire format (removing a never-snapshotted field is not a wire change; the golden byte test in `snapshot.test.ts` is unaffected). Leave `PROTOCOL_VERSION` at its current value (19).
- **Scope discipline** — touch only the comments/code enumerated in Task 2. Do **not** broadly rewrite "single-player" language across `game/game.ts` (much of it is accurate: `sim/` really is byte-for-byte reusable). The **reconnect** comments (`sim/config.ts` reconnect block, `game/net/client.ts` two-channel reconnect comments) are **out of scope here** — they belong to PR2, which rewrites that code.

---

## Grounding facts (verified against current `main`, 2026-07-14)

- `flashT`/`flashColor` sites: `sim/types.ts:585-586` (State fields), `sim/state.ts:100-101` (init), `sim/step.ts:29` (decay), `sim/systems/ai.ts:361-364` (local-player bump, inside `if (target.id === state.localId)`), `game/game.ts:447-448` (stalker-scare bump, client-side), `game/game.ts:1253-1254` (render — the full-screen `#flash` opacity + color gradient).
- **`flashT`/`flashColor` are NOT in the snapshot** (`sim/snapshot.ts` carries neither). Confirmed: no test references `flashT`/`flashColor` (grep of `sim/**/*.test.ts` = none), so removing them from `State`/`stepSim`/`sysAI` breaks no test.
- The `sysAI` local-player block (`ai.ts:360-365`) bumps **three** discarded-on-DO things together: `state.flashT`, `state.flashColor`, and `state.cam.shake`. `cam.shake` is likewise **not** snapshotted (camera is client-only; `sysCamera` runs on the client). So the local **hurt shake** has the identical "DO bump discarded" gap as `flashT` — this plan migrates both together (they are one cohesive per-local-viewer feedback unit). **Out of scope:** the barricade-break `cam.shake` at `ai.ts:349` (a separate, non-local-gated cue with the same pre-existing gap) is left untouched.
- On a client today, `stepSim` never runs, so `state.flashT` is **never decayed** client-side — the stalker-scare bump at `game.ts:447` currently sticks. Moving decay to a client-side `decayFlash(dt)` in the render loop fixes that too.
- Dead code from M-A/M-B (no game-over, deploy retired): `game/game.ts:1461-1475` `endRun` (only caller is `clientGameOver`), `game/game.ts:1477-1480` `clientGameOver`, `game/net/client.ts:124-125` gameover branch + `client.ts:24` import, `game/net/client.ts:409-411` `requestDeploy` (no callers), `game/net/events.ts:15` `deploy` CoopEvent, `game/net/events.ts:26-33` `gameover` HostEvent. The `#over` debrief overlay HTML + `#restartBtn` wiring become orphaned but stay (broader UI cleanup out of §8 scope; PR2's terminal-fail→`toTitle` re-establishes a route to title).

## File structure

- **Task 1** — Modify: `sim/types.ts`, `sim/state.ts`, `sim/step.ts`, `sim/systems/ai.ts`, `game/game.ts`, `game/net/client.ts`. (Removes `flashT`/`flashColor` from `State`; adds client-owned flash in `game.ts`; re-derives flash+hurt-shake in `client.ts`.)
- **Task 2** — Modify: `game/game.ts`, `game/net/client.ts`, `game/net/events.ts`, `sim/config.ts`, `sim/engine/players.ts`, `sim/systems/shop.test.ts`. (Deletes dead paths; fixes host-era comments.)

Task 1 (behavior/feel) and Task 2 (mechanical cleanup) are independent and each independently CI-green; ordered flash-first so the riskier feel change lands before the trivial sweep.

---

## Task 1: Migrate `flashT` + local hurt cam-shake to a client-owned per-viewer cue

**Files:**
- Modify: `sim/types.ts:585-586` (remove `flashT`/`flashColor` from `State`)
- Modify: `sim/state.ts:100-101` (remove the two initializers)
- Modify: `sim/step.ts:29` (remove the decay line)
- Modify: `sim/systems/ai.ts:360-365` (remove the local-player flash+shake block)
- Modify: `game/game.ts` (add client-owned flash state + `bumpFlash`/`decayFlash`; retarget stalker-scare bump; render reads module vars)
- Modify: `game/main.ts` (call `decayFlash(dt)` in the client render loop)
- Modify: `game/net/client.ts` (bump flash + hurt-shake on the local `hitFlash` edge)

**Interfaces:**
- Produces (from `game/game.ts`):
  - `export function bumpFlash(amt: number, color: [number, number, number]): void` — add `amt` to the client flash (clamped ≤ 1) and set its color.
  - `export function decayFlash(dt: number): void` — exponential decay of the client flash by `CONFIG.feel.flashDecay`.
- Consumes: `game/net/client.ts` and `game/main.ts` import `bumpFlash`/`decayFlash` from `../game`.

> **Note on testing:** `flashT`/hurt-shake are game-feel and were never unit-tested (deliberate project scope — feel is validated by playtest, not Vitest). This task therefore has **no new unit test**; its gates are `typecheck`/`build`/`lint` (types removed cleanly) + the **playtest** in Final Verification. This is consistent with the project's "only pure/deterministic code is tested" discipline. Do not add a token test for `bumpFlash`.

> **Feel note (rubber-duck):** deriving the flash/shake from the synced `hitFlash` edge means two hits landing **within one snapshot interval** (~33ms at `sendHz=30`, under the `hurtIframe=0.12s` window) collapse to a single edge → one flash/shake instead of two. This is **no worse than before** (the DO discarded the flash/shake entirely, so a client saw zero), and is cosmetic. Not a blocker; noted so the playtester isn't surprised.

- [ ] **Step 1: Remove `flashT`/`flashColor` from the `State` type**

In `sim/types.ts`, delete these two lines (currently 585-586):

```typescript
  flashT: number;
  flashColor: [number, number, number];
```

(They sit among the other screen-feel fields on `State`. Leave `hitstopT`, `cam`, etc. untouched.)

- [ ] **Step 2: Remove the `State` initializers**

In `sim/state.ts`, delete these two lines (currently 100-101):

```typescript
    flashT: 0,
    flashColor: [1, 0.3, 0.3],
```

- [ ] **Step 3: Remove the `stepSim` decay**

In `sim/step.ts`, delete line 29:

```typescript
  state.flashT *= Math.exp(-CONFIG.feel.flashDecay * dt);
```

(`CONFIG.feel.flashDecay` stays defined — Step 6 reuses it client-side.)

- [ ] **Step 4: Remove the `sysAI` local-player flash+shake block**

In `sim/systems/ai.ts`, the hit-application block (around 353-368) currently reads:

```typescript
      if (target.iframe <= 0) {
        target.hitFlash = 0.28;
        target.iframe = CONFIG.feel.hurtIframe;
        pushFx(state, { t: "hurt", x: target.x, y: target.y, local: target.id === state.localId });
        // screen flash and camera shake are the LOCAL player's own feedback
        if (target.id === state.localId) {
          state.flashT = Math.min(1, state.flashT + 0.7);
          state.flashColor = [1, 0.18, 0.18];
          state.cam.shake = Math.min(state.cam.shake + 8, 20);
        }
      }
```

Replace it with (drop the whole `if (target.id === state.localId)` block; keep `hitFlash`/`iframe`/`pushFx`):

```typescript
      if (target.iframe <= 0) {
        target.hitFlash = 0.28;
        target.iframe = CONFIG.feel.hurtIframe;
        // hurt fx (blood) + the local viewer's screen flash & camera shake are re-derived
        // client-side off the synced `hitFlash` edge (client.ts effects()); the DO would only
        // discard them (flashT/cam are not snapshotted).
        pushFx(state, { t: "hurt", x: target.x, y: target.y, local: target.id === state.localId });
      }
```

- [ ] **Step 5: Verify `sim/` still type-checks (headless boundary intact)**

Run: `bun run typecheck`
Expected: FAILs now on `game/game.ts` (still reads `state.flashT`/`state.flashColor`) — that is fixed in Steps 6-8. If it instead fails inside `sim/` (e.g. a missed `flashT` reference), fix that first. The point of this step is to confirm `sim/` itself is clean.

- [ ] **Step 6: Add client-owned flash state + `bumpFlash`/`decayFlash` in `game/game.ts`**

In `game/game.ts`, near the other module-scope render/feel vars (e.g. beside `gradeSatCur`/`gradeDimCur` around line 149), add:

```typescript
// Full-screen damage flash is a PER-VIEWER cue, owned client-side (not on State / not synced):
// the DO would only compute+discard it. Bumped on the local player's hitFlash edge (client.ts)
// and by the stalker scare (below); decayed each client frame (main.ts calls decayFlash).
let flashT = 0;
let flashColor: [number, number, number] = [1, 0.3, 0.3];

/** Add to this client's screen flash (clamped) and set its color. */
export function bumpFlash(amt: number, color: [number, number, number]): void {
  flashT = Math.min(1, flashT + amt);
  flashColor = color;
}

/** Exponential decay of this client's screen flash (called from the render loop). */
export function decayFlash(dt: number): void {
  flashT *= Math.exp(-CONFIG.feel.flashDecay * dt);
}
```

(`CONFIG` is already imported in `game.ts`.)

- [ ] **Step 7: Retarget the stalker-scare bump + the render to the client vars**

In `game/game.ts`, the stalker-scare block — flashT at **447**, flashColor at **448**, cam.shake at **449** (verified) — currently reads:

```typescript
        // Hard flash (0.7 base + boost, matching the pre-sync host total) in cold stalker purple.
        state.flashT = Math.min(1, state.flashT + 0.7 + CONFIG.stalker.scareFlashBoost);
        state.flashColor = [0.8, 0.1, 0.8];
```

Replace with:

```typescript
        // Hard flash (0.7 base + boost) in cold stalker purple — client-owned per-viewer cue.
        bumpFlash(0.7 + CONFIG.stalker.scareFlashBoost, [0.8, 0.1, 0.8]);
```

(Leave the `state.cam.shake` line at 449 and the camera-lurch that follow it untouched — those are already client-side.)

Then the render (around 1253-1254) currently reads:

```typescript
  fl.style.opacity = String(Math.min(0.6, state.flashT));
  fl.style.background = `radial-gradient(circle at 50% 50%, transparent 40%, rgba(${Math.round(state.flashColor[0] * 255)},${Math.round(state.flashColor[1] * 255)},${Math.round(state.flashColor[2] * 255)},0.9) 100%)`;
```

Replace `state.flashT`/`state.flashColor` with the module vars:

```typescript
  fl.style.opacity = String(Math.min(0.6, flashT));
  fl.style.background = `radial-gradient(circle at 50% 50%, transparent 40%, rgba(${Math.round(flashColor[0] * 255)},${Math.round(flashColor[1] * 255)},${Math.round(flashColor[2] * 255)},0.9) 100%)`;
```

- [ ] **Step 8: Decay the flash in the client render loop**

In `game/main.ts`, the client branch of `frame()` already runs `sysFx` when the run is live (around 330-333):

```typescript
      if (st.running) {
        sysFx(st, dt); // advance client-spawned particles/blood/damage text
        clientAmbience(dt); // dread / heartbeat / groan from the snapshot world
      }
```

Add `decayFlash(dt)` alongside `sysFx`:

```typescript
      if (st.running) {
        sysFx(st, dt); // advance client-spawned particles/blood/damage text
        decayFlash(dt); // decay the per-viewer damage flash (was stepSim's job pre-DO)
        clientAmbience(dt); // dread / heartbeat / groan from the snapshot world
      }
```

Add `decayFlash` to the existing `import { … } from "./game"` in `main.ts`.

- [ ] **Step 9: Re-derive the flash + hurt-shake on the local `hitFlash` edge in `client.ts`**

In `game/net/client.ts` `effects()`, the local-player hurt edge (around 305-310) currently reads:

```typescript
    for (const pl of next.players) {
      const p = pp.get(pl.id);
      if (p && pl.hitFlash > p.hitFlash + 0.01) {
        fxHurt(st, pl.x, pl.y);
        if (pl.id === st.localId) Audio.hurt();
      }
```

Replace the inner edge block so the local viewer also gets the screen flash + hurt shake (the feedback removed from `sysAI` in Step 4):

```typescript
    for (const pl of next.players) {
      const p = pp.get(pl.id);
      if (p && pl.hitFlash > p.hitFlash + 0.01) {
        fxHurt(st, pl.x, pl.y);
        if (pl.id === st.localId) {
          Audio.hurt();
          // screen flash + camera shake are the LOCAL viewer's own hurt feedback, re-derived
          // here (the DO discards them — flashT/cam aren't snapshotted). Values mirror the
          // pre-DO sysAI bump for feel parity.
          bumpFlash(0.7, [1, 0.18, 0.18]);
          st.cam.shake = Math.min(st.cam.shake + 8, 20);
        }
      }
```

Add `bumpFlash` to the existing `import { … } from "../game"` in `client.ts` (currently `clientApplyHello, clientBanked, clientGameOver, getState, startClientGame` — note `clientGameOver` is removed in Task 2, so keep the two edits independent).

- [ ] **Step 10: Full type-check + build + lint**

Run: `bun run typecheck && bun run test && bun run lint && bun run build`
Expected: PASS. (`test` should be unaffected — no test touched `flashT`.)

- [ ] **Step 11: Commit**

```bash
git add sim/types.ts sim/state.ts sim/step.ts sim/systems/ai.ts game/game.ts game/main.ts game/net/client.ts
git commit -m "feat(net): 2b①C-1 — flashT + local hurt-shake become client-owned per-viewer cues"
```

---

## Task 2: Delete dead game-over/deploy paths + fix host-authoritative-era comments

**Files:**
- Modify: `game/net/events.ts` (remove `deploy` CoopEvent + `gameover` HostEvent; fix host-era comments)
- Modify: `game/net/client.ts` (remove gameover branch + `clientGameOver` import + `requestDeploy`)
- Modify: `game/game.ts` (delete `endRun` + `clientGameOver`; fix comments)
- Modify: `sim/config.ts` (net header host-era language)
- Modify: `sim/engine/players.ts` (game-over comments on `anyAlive`/`cameraTarget`)
- Modify: `sim/systems/shop.test.ts` (describe labels)

**Interfaces:** none produced. This task only removes exports/branches that have no live callers (verified: `clientGameOver` called only from `client.ts:125`; `endRun` called only from `clientGameOver`; `requestDeploy` has no callers; `deploy` CoopEvent unhandled on the DO since M-B).

> **Note on testing:** mechanical deletion + comment edits. `bun run typecheck && bun run test && bun run lint && bun run build` is the gate (compilation proves nothing references the removed symbols; `shop.test.ts` still passes with only its describe strings changed). No new unit test.

- [ ] **Step 1: Remove the `deploy` CoopEvent and fix the CoopEvent host-era comments**

In `game/net/events.ts`, delete the `deploy` line (15) from `CoopEvent`:

```typescript
  | { t: "deploy" } // leave the shop, start the next day
```

and update the `join`/`rejoin` comment block (18-21) — replace `host` language with the DO reality:

```typescript
  // First message a client sends on every arena (re)connect, so the DO can decide this peer's
  // identity before spawning: `join` = fresh peer (DO assigns a free slot); `rejoin` =
  // reconnect — DO matches pid+nonce to the dropped player's still-held body and re-attaches
  // in place (no respawn). Unmatched/expired tokens fall back to a fresh slot. See worker/arena.ts.
  | { t: "join" }
  | { t: "rejoin"; pid: number; nonce: string };
```

- [ ] **Step 2: Remove the `gameover` HostEvent and fix the `roomfull` comment**

In `game/net/events.ts`, the `HostEvent` union (26-37) currently reads:

```typescript
/** Host → client notifications. */
export type HostEvent =
  | {
      t: "gameover";
      salvage: number; // this player's banked share
      day: number;
      kills: number;
      money: number;
    }
  // Room is at capacity (host + 3). The host sends this instead of assigning a slot; the client
  // tears its own link down on receipt (host doesn't close immediately — see host.ts reject()).
  | { t: "roomfull" }
  | { t: "banked"; salvage: number }; // dawn SALVAGE payout for this player (client → addSalvage)
```

Replace with (drop `gameover`; there is no game-over in the living arena — SALVAGE banks via `banked` at dawn):

```typescript
/** DO → client notifications. */
export type HostEvent =
  // Arena is at capacity (maxPlayers). The DO sends this instead of assigning a slot; the client
  // tears its own link down on receipt (the DO does not close immediately — see worker/arena.ts).
  | { t: "roomfull" }
  | { t: "banked"; salvage: number }; // dawn SALVAGE payout for this player (client → addSalvage)
```

- [ ] **Step 3: Remove the gameover branch + `clientGameOver` import + `requestDeploy` in `client.ts`**

In `game/net/client.ts`, the import (24) currently:

```typescript
import { clientApplyHello, clientBanked, clientGameOver, getState, startClientGame } from "../game";
```

Remove `clientGameOver` (and — if Task 1 already landed — this same line now also imports `bumpFlash`; keep that):

```typescript
import { bumpFlash, clientApplyHello, clientBanked, getState, startClientGame } from "../game";
```

Then delete the gameover branch in `onRel` (124-125):

```typescript
      } else if (msg.t === "gameover") {
        clientGameOver(msg.salvage, msg.day, msg.kills, msg.money);
```

so the chain goes directly from the `hello` handler to the `banked` handler.

Then delete `requestDeploy` (409-411):

```typescript
  requestDeploy(): void {
    this.link.sendRel({ t: "deploy" });
  }
```

- [ ] **Step 4: Delete `endRun` + `clientGameOver` in `game/game.ts` and fix their comments**

In `game/game.ts`, delete `endRun` (1459-1475) and `clientGameOver` (1477-1480):

```typescript
/** End the run on this machine: bank our salvage share and show the debrief. Shared by
 *  the host/single gameOver and the client's gameover-event handler. */
function endRun(salvage: number, day: number, kills: number, money: number): void {
  state.running = false;
  Audio.gameOver();
  Audio.stopDread();
  addSalvage(salvage); // banks to THIS machine's localStorage (each player keeps their own)
  el("over-wave").textContent = String(day);
  el("over-kills").textContent = String(kills);
  el("over-money").textContent = String(money);
  el("over-salvage").textContent = String(salvage);
  hide("hud");
  show("over");
  // snap grade to full color so debrief / title show no desaturation bleed-through
  gradeSatCur = 1;
  gradeDimCur = 1;
}

/** Apply the host's gameover event: bank our share + show the debrief on this client. */
export function clientGameOver(salvage: number, day: number, kills: number, money: number): void {
  endRun(salvage, day, kills, money);
}
```

Keep `clientBanked` (immediately below) — it is live (dawn payout). Update its comment (1482-1483) which references `clientGameOver`:

```typescript
/** Apply a dawn SALVAGE payout: bank this player's share to their cross-run meta. The arena
 *  keeps cycling — there is no game-over in the living arena. */
export function clientBanked(salvage: number): void {
  addSalvage(salvage);
}
```

Then fix the two grade-comment references to `endRun` (148 and 752). Line 148 currently:

```typescript
// Snapped to 1 by endRun/toTitle; held (not advanced) while not running.
```

→

```typescript
// Snapped to 1 by toTitle (and the newState reset); held (not advanced) while not running.
```

Line 752 currently contains `are held at whatever endRun/toTitle already snapped them to (1/1)` — change `endRun/toTitle` to `toTitle`.

- [ ] **Step 5: Fix the `deployPlace` / buy JSDoc "host/single" language in `game.ts`**

In `game/game.ts`, the buy/place helper JSDoc (around 1402 and 1412) references `host/single`. Update to the DO reality:

- Line ~1402: `/** Buy a Fortify (deployable) item by id. Client → request; host/single → apply + re-render. */`
  → `/** Buy a Fortify (deployable) item by id. Client → CoopEvent request; the DO applies authoritatively. */`
- Line ~1412: the JSDoc containing `on host/single it applies authoritatively. Gating (alive, not in shop, etc.) is done by` → replace `on host/single it applies authoritatively` with `the DO applies it authoritatively`, and `not in shop` with `day-only at the fortress` (M-B regated purchasing on `phase === "day"`, not `inShop`).

> Do not touch the other "single-player" comments in `game.ts` (e.g. 39, 101, 122, 238, 350) — those correctly describe that `sim/`/pure-render code is reusable; they are not stale.

- [ ] **Step 6: Fix the `sim/config.ts` net header host-era language**

In `sim/config.ts`, the net-block header (9-12) currently:

```typescript
  // co-op networking (host-authoritative). client interpolation / prediction params.
  // DO-hop: interpDelayMs, smoothCorrect, snapTeleportThresh are starting points, feel-tuned at gate
  net: {
    sendHz: 30, // host snapshot broadcast rate
```

Replace the host-era phrases (leave the `reconnect` block untouched — PR2 owns it):

```typescript
  // co-op networking (DO-authoritative). client interpolation / prediction params.
  // DO-hop: interpDelayMs, smoothCorrect, snapTeleportThresh are starting points, feel-tuned at gate
  net: {
    sendHz: 30, // DO snapshot broadcast rate
```

- [ ] **Step 7: Fix the `anyAlive`/`cameraTarget` game-over comments in `players.ts`**

In `sim/engine/players.ts`:

- Line ~81: `local player only when the whole party is down (the frame before game over).`
  → `local player only when the whole party is down (spectator camera; the arena keeps cycling).`
- Line ~136: `/** Any player still standing? (false = whole party wiped → game over). Absent players`
  → `/** Any player still standing? (false = whole party down; the arena keeps running — respawn timers + the night clock carry to dawn). Absent players`

(Keep the function bodies unchanged.)

- [ ] **Step 8: Fix the `shop.test.ts` host-authoritative describe labels**

In `sim/systems/shop.test.ts`:

- Line 7: `describe("applyBuy (Fortify purchase, host-authoritative)", () => {` → `describe("applyBuy (Fortify purchase, DO-authoritative)", () => {`
- Line 60: `describe("draft apply (host-authoritative)", () => {` → `describe("draft apply (DO-authoritative)", () => {`

- [ ] **Step 9: Full gate**

Run: `bun run typecheck && bun run test && bun run lint && bun run build`
Expected: PASS. Compilation confirms no live reference to the removed `clientGameOver`/`endRun`/`requestDeploy`/`deploy`/`gameover` symbols; `shop.test.ts` still passes with renamed describes.

- [ ] **Step 10: Commit**

```bash
git add game/net/events.ts game/net/client.ts game/game.ts sim/config.ts sim/engine/players.ts sim/systems/shop.test.ts
git commit -m "chore(net): 2b①C-1 — delete dead game-over/deploy client paths + host-era comment triage"
```

---

## Final verification

- [ ] **Full gate:** `bun run typecheck && bun run test && bun run lint && bun run build`
- [ ] **Playtest (feel gate — flash + hurt-shake are game-feel):** `bun run dev:coop`, connect two clients to the same arena.
  - (a) A zombie hits your local player → you see the **red full-screen flash + camera shake** (previously discarded on the DO → this is the gap being fixed).
  - (b) The flash **decays** (does not stick) after the hit — confirms client-side `decayFlash`.
  - (c) The other client's screen does **not** flash when *you* get hit (per-viewer, not global).
  - (d) A stalker grab still triggers the **purple** hard flash + lurch on the victim client only.
  - (e) No console errors; no regression in blood/`fxHurt`.

## Notes for PR2 (do NOT implement here)

- PR2 (arena auto-reconnect) owns the `sim/config.ts` `reconnect` block comments ("P4"/"host") and the `game/net/client.ts` two-channel reconnect comments (`lastActivityMs`, `suspend`/`rebind` doc) — they are rewritten as part of driving the reconnect loop. Leaving them here keeps this PR a clean mechanical sweep and avoids a merge conflict with PR2.
- The `#over` debrief overlay HTML + `#restartBtn` are now orphaned (never shown). Their removal is deferred (broader UI cleanup); PR2's terminal-reconnect-failure path re-establishes a route to `toTitle`.
