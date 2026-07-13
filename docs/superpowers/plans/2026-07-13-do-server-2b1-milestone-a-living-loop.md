# 2b① Milestone A — Living Arena Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the 2a held-night gate into a living day/night arena on the Durable Object — real cycle, death→timed-respawn, coherent drop-in, and dawn SALVAGE banking — with the shop still deferred.

**Architecture:** The pure sim gains the missing loop pieces (respawn timer, dawn orchestration) as small headless, unit-tested systems in `sim/`. The DO (`worker/arena.ts`) stops forcing a held night, reacts to `stepSim`'s `"dawn"` return by calling one pure `sysDawn(state)` helper (day++/startDay/revive-stragglers/compute-banking), and unicasts each present player their SALVAGE share as a new `banked` rel message. The client banks it via the existing `addSalvage`. No global pause is ever set server-side.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Bun, Vitest (node env), Cloudflare Durable Object (standard WebSocket API), Biome.

## Global Constraints

- **The DO never globally pauses:** never set `state.paused` or `state.inShop` server-side. (`state.inShop` retirement is M-B; in M-A it simply stays `false`.)
- **`sim/` stays headless:** no DOM/WebGL/Audio/Web-Worker imports in `sim/` — enforced by `sim/tsconfig.json` (`lib: ["ES2022"]`, `types: []`) and CI.
- **Systems are net-agnostic:** they take `(state, dt)` and mutate state / return values; they never import net code.
- **Derive-first fx:** no `fxEvents` on the wire. The one new wire message, `banked`, is a **rel** (JSON) message like `hello`/`gameover`, never a snapshot field.
- **Fixed-dt:** the DO steps `stepSim(s, 1 / CONFIG.simHz)` once per tick (no wall-clock accumulator).
- **Test scope:** only pure/deterministic code gets Vitest coverage (co-located `*.test.ts`). DO/client wiring is verified via `bun run dev:coop` (wrangler dev + browser), not unit tests.
- **Shop stays deferred in M-A:** the `arena.ts` `onMessage` buy/place/deploy/draft branch stays a no-op (M-B). No draft roll in M-A.

---

## File structure

- `sim/types.ts` — add `Player.downT`, `State.salvageBanked`; remove `State.heldNight`.
- `sim/state.ts` — init `salvageBanked: 0`; remove `heldNight` init.
- `sim/config.ts` — add `siege.respawnDelay`; remove `siege.heldNightDay`.
- `sim/systems/siege.ts` — remove the held-night re-arm branch from `sysSiege`.
- `sim/step.ts` — remove the `"wipe"` short-circuit + retype; wire in `sysRespawn`.
- `sim/engine/players.ts` — `makePlayer` inits `downT`; `revivePlayer` resets `downT`; add pure `homeSpawnFor(id)` helper and use it in `revivePlayer`.
- `sim/systems/respawn.ts` — **new**: `sysRespawn(state, dt)` ticks downed players' timers and respawns at the fortress.
- `sim/systems/dawn.ts` — **new**: `sysDawn(state)` (day++/startDay/revive-stragglers/banking) + `bankSalvageAtDawn` + `reviveStragglers`.
- `worker/arena.ts` — `ensureRunning` starts Day-1; `step()` reacts to `"dawn"` and unicasts `banked`.
- `game/net/events.ts` — add `{ t: "banked"; salvage: number }` to `HostEvent`.
- `game/net/client.ts` — handle the `banked` rel message.
- `game/game.ts` — export `clientBanked(salvage)` → `addSalvage`.
- Tests: `sim/systems/siege.test.ts` (edit), `sim/step.test.ts` (edit), `sim/systems/respawn.test.ts` (new), `sim/engine/players.test.ts` (new or edit), `sim/systems/dawn.test.ts` (new).

---

### Task 1: Remove the held-night gate from the pure sim

**Files:**
- Modify: `sim/types.ts` (remove `heldNight` field, ~line 565-567)
- Modify: `sim/state.ts` (remove `heldNight: false`, line 93)
- Modify: `sim/systems/siege.ts` (remove the held-night re-arm in `sysSiege`, lines 87-91)
- Modify: `sim/config.ts` (remove `heldNightDay`, line 253)
- Test: `sim/systems/siege.test.ts` (add the no-re-arm case; **delete the existing `describe("heldNight", …)` block, lines 144-167**, which references the removed `s.heldNight`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `sysSiege(state, dt): "night" | "dawn" | null` now returns `"dawn"` on the night-clock expiry frame unconditionally (no held-night re-arm). `State` no longer has `heldNight`.

- [ ] **Step 1: Write the failing test** — add to `sim/systems/siege.test.ts` inside the `describe("sysSiege", …)` block:

```typescript
  it("dawns at night's end with no held-night re-arm", () => {
    const s = newState();
    startNight(s);
    s.phaseT = 0.5;
    expect(sysSiege(s, 1)).toBe("dawn"); // no heldNight flag exists to re-arm the clock
  });
```

- [ ] **Step 2: Run it — expect a TYPE error first (heldNight still referenced elsewhere) or a pass**

Run: `bun run test -- sim/systems/siege.test.ts`
Expected: the suite still compiles/passes today (held-night defaults false), but `bun run typecheck` will drive the removal. Proceed to strip `heldNight`.

- [ ] **Step 3: Remove the `heldNight` field** from `sim/types.ts` — delete these lines:

```typescript
  /** DO held-night gate (2a): sysSiege never transitions to dawn while true, so the arena runs
   *  a sustained night and never globally pauses (per-player shop + day/night cycle = 2b). */
  heldNight: boolean;
```

- [ ] **Step 4: Remove the init** in `sim/state.ts` — delete the `heldNight: false,` line.

- [ ] **Step 5: Remove the re-arm branch** in `sim/systems/siege.ts` `sysSiege` — replace:

```typescript
  state.phaseT -= dt;
  if (state.phaseT > 0) return null;
  if (state.heldNight) {
    // held night (DO 2a): re-arm the night clock so it loops (18:00→06:00 repeats) and never dawns
    state.phaseT = nightDuration(state.day);
    return null;
  }
  return "dawn";
```

with:

```typescript
  state.phaseT -= dt;
  if (state.phaseT > 0) return null;
  return "dawn";
```

- [ ] **Step 6: Remove the config key** in `sim/config.ts` — delete:

```typescript
    heldNightDay: 4, // representative mid-game day the DO starts the held night at (DO 2a gate)
```

- [ ] **Step 6b: Delete the stale `heldNight` test block** in `sim/systems/siege.test.ts` — remove the entire `describe("heldNight", () => { … })` block (lines 144-167). It sets `s.heldNight = true/false`, which no longer exists; leaving it fails the sim typecheck. The new no-re-arm case from Step 1 already covers the "dawns at night's end" behavior.

- [ ] **Step 7: Typecheck + test** (arena.ts still references `heldNight`/`heldNightDay`/`startNight` — expect DO errors; they are fixed in Task 5. Run the sim tests + sim typecheck scope only here.)

Run: `bun run test -- sim/systems/siege.test.ts && bunx tsc -p sim/tsconfig.json --noEmit`
Expected: sim tests PASS; `sim/` typecheck PASS. (Root `bun run typecheck` will still fail on `worker/arena.ts` until Task 5 — that is expected mid-plan.)

- [ ] **Step 8: Commit**

```bash
git add sim/types.ts sim/state.ts sim/systems/siege.ts sim/config.ts sim/systems/siege.test.ts
git commit -m "refactor(sim): remove held-night gate — sysSiege dawns unconditionally"
```

---

### Task 2: Remove the `stepSim` wipe short-circuit

**Files:**
- Modify: `sim/step.ts` (remove `if (!anyAlive(state)) return "wipe";`, retype)
- Test: `sim/step.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `stepSim(state, dt): "night" | "dawn" | null` (the `"wipe"` member is gone). The sim now runs every system even when no player is alive.

Rationale: the `return "wipe"` sat *before* `sysSiege`, so an all-down party froze the night clock and dawn never came. Removing it lets the night clock advance (via `sysSiege`) and respawn timers (Task 3) tick while everyone is down. Verified safe: `awardBounty` is a no-op with no living player, `sysPickups` only collects for alive players.

- [ ] **Step 1: Edit the test** — in `sim/step.test.ts` replace the `"returns 'wipe' when no player is alive"` case with:

```typescript
  it("keeps running (returns null, not a wipe) when every player is down", () => {
    const s = newState();
    s.running = true;
    for (const p of s.players) p.hp = 0;
    expect(stepSim(s, 1 / 60)).toBe(null); // no game-over: the night clock keeps advancing
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun run test -- sim/step.test.ts`
Expected: FAIL — `stepSim` still returns `"wipe"`.

- [ ] **Step 3: Remove the short-circuit** in `sim/step.ts` — delete the line:

```typescript
  if (!anyAlive(state)) return "wipe";
```

and change the signature:

```typescript
export function stepSim(state: State, dt: number): "night" | "dawn" | null {
```

Also remove the now-unused `anyAlive` import (line 2: `import { anyAlive } from "./engine/players";`) **only if** nothing else in the file uses it (it does not).

- [ ] **Step 4: Run tests to verify pass**

Run: `bun run test -- sim/step.test.ts`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add sim/step.ts sim/step.test.ts
git commit -m "refactor(sim): drop stepSim wipe short-circuit — no game-over, sim runs while all-down"
```

---

### Task 3: Individual timed respawn (`downT` + `sysRespawn`)

**Files:**
- Modify: `sim/types.ts` (add `Player.downT`)
- Modify: `sim/config.ts` (add `siege.respawnDelay`)
- Modify: `sim/engine/players.ts` (init `downT` in `makePlayer`; reset `downT` in `revivePlayer`)
- Create: `sim/systems/respawn.ts`
- Modify: `sim/step.ts` (call `sysRespawn` after `sysAssist`)
- Test: `sim/systems/respawn.test.ts`

**Interfaces:**
- Consumes: `revivePlayer(state, p)` (existing 3-arg `revivePlayer(_state, p, opts = {})`; default opts = fortress spawn at `HOME_SPAWN.x + ((id % 4) - 1.5) * 36`, full HP).
- Produces:
  - `Player.downT: number` — seconds spent downed; ticks while `hp <= 0 && !absent`, reset to 0 on revive.
  - `sysRespawn(state: State, dt: number): void` — ticks `downT`; at `CONFIG.siege.respawnDelay` calls `revivePlayer` (fortress).

> **Scope note:** the fortress-respawn *coordinate spread* (spec §2's `id % 4` → cap widening) is **deferred out of M-A**. Widening to the 12-cap pushes spawns past the HOME walls (x=±180) — the naive fix spawns players outside the fortress and breaks `players.test.ts`. The `id % 4` overlap is pre-existing and transient (the `sysAI` positional de-overlap separates stacked bodies within a frame). Revisit as a spawn-placement polish later, not in the loop milestone.

- [ ] **Step 1: Add the config constant** in `sim/config.ts` `siege` block (near the night-duration keys):

```typescript
    respawnDelay: 17, // seconds a downed player spectates before auto-respawning at the fortress
```

- [ ] **Step 2: Add the `Player.downT` field** in `sim/types.ts` (right after `assistT`):

```typescript
  /** seconds spent downed (hp<=0). Ticks in sysRespawn; at CONFIG.siege.respawnDelay the player
   *  auto-respawns at the fortress. Reset to 0 by revivePlayer (peer/timer/dawn). */
  downT: number;
```

- [ ] **Step 3: Init it** in `sim/engine/players.ts` `makePlayer` (beside `assistT: 0,`):

```typescript
    downT: 0,
```

- [ ] **Step 4: Reset `downT` in `revivePlayer`** in `sim/engine/players.ts` — add `p.downT = 0;` immediately beside the existing `p.assistT = 0;` line. (Do NOT change the fortress-teleport coordinate block — the spread widening is deferred, see the Scope note above. This keeps `players.test.ts`'s `Math.abs(p.x) < 120` assertion valid.)

- [ ] **Step 5: Write the failing test** — create `sim/systems/respawn.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { HOME_SPAWN } from "../data/map";
import { addPlayer } from "../engine/players";
import { newState } from "../state";
import { sysRespawn } from "./respawn";

// newState() pre-seeds one player (id 0). Reset the roster in each test so addPlayer ids are
// unambiguous and present-counts are exactly what the test sets up.
describe("sysRespawn", () => {
  it("ticks downT for a downed player without reviving before the delay", () => {
    const s = newState();
    s.players = [];
    const p = addPlayer(s, 0, 500, 500);
    p.hp = 0;
    sysRespawn(s, 1);
    expect(p.downT).toBeCloseTo(1, 5);
    expect(p.hp).toBe(0);
  });

  it("respawns at the fortress at full HP once downT reaches respawnDelay", () => {
    const s = newState();
    s.players = [];
    const p = addPlayer(s, 0, 500, 500);
    p.hp = 0;
    sysRespawn(s, CONFIG.siege.respawnDelay + 0.01);
    expect(p.hp).toBe(p.maxHp);
    expect(p.downT).toBe(0);
    expect(p.y).toBe(HOME_SPAWN.y); // teleported home
  });

  it("does not tick an absent (disconnected) held body", () => {
    const s = newState();
    s.players = [];
    const p = addPlayer(s, 0, 500, 500);
    p.hp = 0;
    p.absent = true;
    sysRespawn(s, 5);
    expect(p.downT).toBe(0);
  });

  it("leaves an alive player untouched", () => {
    const s = newState();
    s.players = [];
    const p = addPlayer(s, 0, 500, 500);
    sysRespawn(s, 5);
    expect(p.downT).toBe(0);
    expect(p.hp).toBe(p.maxHp);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun run test -- sim/systems/respawn.test.ts`
Expected: FAIL — `./respawn` module not found.

- [ ] **Step 7: Implement `sim/systems/respawn.ts`**:

```typescript
import { CONFIG } from "../config";
import { revivePlayer } from "../engine/players";
import type { State } from "../types";

/**
 * Individual timed respawn. A downed player (hp<=0, not a disconnected held body) accrues `downT`;
 * once it reaches CONFIG.siege.respawnDelay they respawn at the fortress. Runs after sysAssist so a
 * teammate's in-place peer-revive (which sets hp>0 and resets downT) takes priority the same frame.
 */
export function sysRespawn(state: State, dt: number): void {
  for (const p of state.players) {
    if (p.hp > 0 || p.absent) continue;
    p.downT += dt;
    if (p.downT >= CONFIG.siege.respawnDelay) revivePlayer(state, p); // fortress, full HP; resets downT
  }
}
```

- [ ] **Step 8: Wire it into `stepSim`** in `sim/step.ts` — add the import and call it right after `sysAssist`:

```typescript
import { sysRespawn } from "./systems/respawn";
```
```typescript
  sysAssist(state, sdt);
  sysRespawn(state, sdt);
```

- [ ] **Step 9: Run the tests + sim typecheck**

Run: `bun run test -- sim/systems/respawn.test.ts && bunx tsc -p sim/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add sim/types.ts sim/config.ts sim/engine/players.ts sim/systems/respawn.ts sim/step.ts sim/systems/respawn.test.ts
git commit -m "feat(sim): individual timed fortress respawn (downT + sysRespawn)"
```

---

### Task 4: Dawn orchestration + SALVAGE banking (`sysDawn`)

**Files:**
- Modify: `sim/types.ts` (add `State.salvageBanked`)
- Modify: `sim/state.ts` (init `salvageBanked: 0`)
- Create: `sim/systems/dawn.ts`
- Test: `sim/systems/dawn.test.ts`

**Interfaces:**
- Consumes: `salvageEarned(day, kills)` + `salvageShare(total, recipients)` (`sim/data/arsenal.ts`); `startDay(state)` (`sim/systems/siege.ts`); `revivePlayer(state, p)` (`sim/engine/players.ts`).
- Produces:
  - `State.salvageBanked: number` — cumulative SALVAGE already handed out this arena life (baseline for the per-dawn delta).
  - `sysDawn(state: State): { pid: number; salvage: number }[]` — the whole dawn transition: `day++`, bank each present (`!absent`) player their share of the incremental SALVAGE, revive stragglers at the fortress, `startDay`. Returns the per-player banked amounts for the DO to unicast.

- [ ] **Step 1: Add `State.salvageBanked`** in `sim/types.ts` (near `kills`):

```typescript
  /** cumulative SALVAGE already banked to clients this arena life; baseline for the per-dawn
   *  delta (dawn banks salvageEarned(day,kills) - salvageBanked, split among present players). */
  salvageBanked: number;
```

- [ ] **Step 2: Init it** in `sim/state.ts` (beside `kills: 0,`):

```typescript
    salvageBanked: 0,
```

- [ ] **Step 3: Write the failing test** — create `sim/systems/dawn.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { CONFIG } from "../config";
import { salvageEarned, salvageShare } from "../data/arsenal";
import { addPlayer } from "../engine/players";
import { newState } from "../state";
import { sysDawn } from "./dawn";

describe("sysDawn", () => {
  it("increments the day and re-enters the day phase", () => {
    const s = newState();
    s.day = 2;
    s.phase = "night";
    sysDawn(s);
    expect(s.day).toBe(3);
    expect(s.phase).toBe("day");
  });

  it("banks the incremental SALVAGE split among present players", () => {
    const s = newState();
    s.players = []; // drop the pre-seeded id0 so present-count is exactly 2
    addPlayer(s, 0, 0, 0);
    addPlayer(s, 1, 0, 0);
    s.day = 1;
    s.kills = 20;
    s.salvageBanked = 0;
    const out = sysDawn(s); // day→2
    const total = salvageEarned(2, 20);
    const share = salvageShare(total, 2);
    expect(out).toEqual([
      { pid: 0, salvage: share },
      { pid: 1, salvage: share },
    ]);
    expect(s.salvageBanked).toBe(total); // baseline advanced so the next dawn banks only the delta
  });

  it("excludes absent (disconnected) players from banking", () => {
    const s = newState();
    s.players = [];
    const a = addPlayer(s, 0, 0, 0);
    addPlayer(s, 1, 0, 0);
    a.absent = true;
    const out = sysDawn(s);
    expect(out.map((b) => b.pid)).toEqual([1]);
  });

  it("revives stragglers still down at dawn (safety net)", () => {
    const s = newState();
    s.players = [];
    const p = addPlayer(s, 0, 500, 500);
    p.hp = 0;
    p.downT = 3; // below respawnDelay — timer hadn't fired
    sysDawn(s);
    expect(p.hp).toBe(p.maxHp);
    expect(p.downT).toBe(0);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun run test -- sim/systems/dawn.test.ts`
Expected: FAIL — `./dawn` module not found.

- [ ] **Step 5: Implement `sim/systems/dawn.ts`**:

```typescript
import { salvageEarned, salvageShare } from "../data/arsenal";
import { revivePlayer } from "../engine/players";
import type { State } from "../types";
import { startDay } from "./siege";

/** Bank the SALVAGE earned since the last dawn to each present (non-absent) player.
 *  Uses the existing global-kills formula incrementally: delta = total - alreadyBanked, split
 *  evenly. Advances the baseline. Returns the per-player amounts for the caller to deliver. */
export function bankSalvageAtDawn(state: State): { pid: number; salvage: number }[] {
  const total = salvageEarned(state.day, state.kills);
  const delta = total - state.salvageBanked;
  state.salvageBanked = total;
  const present = state.players.filter((p) => !p.absent);
  const share = salvageShare(delta, present.length);
  return present.map((p) => ({ pid: p.id, salvage: share }));
}

/** Revive anyone still down at dawn (timer hadn't fired) — the "new day, everyone fresh" reset. */
export function reviveStragglers(state: State): void {
  for (const p of state.players) if (p.hp <= 0 && !p.absent) revivePlayer(state, p);
}

/** The full dawn transition, run by the DO on stepSim's "dawn". Advances the day, banks SALVAGE,
 *  revives stragglers at the fortress, and re-enters the lit day. Returns per-player banked amounts. */
export function sysDawn(state: State): { pid: number; salvage: number }[] {
  state.day++;
  const banked = bankSalvageAtDawn(state);
  reviveStragglers(state);
  startDay(state);
  return banked;
}
```

- [ ] **Step 6: Run the tests + sim typecheck**

Run: `bun run test -- sim/systems/dawn.test.ts && bunx tsc -p sim/tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add sim/types.ts sim/state.ts sim/systems/dawn.ts sim/systems/dawn.test.ts
git commit -m "feat(sim): sysDawn — day++ / dawn SALVAGE banking / straggler revive"
```

---

### Task 5: DO drives the cycle (Day-1 start + dawn reaction + `banked` unicast)

**Files:**
- Modify: `worker/arena.ts` (`ensureRunning`, `step`, `spawnFresh`, imports)
- Modify: `game/net/events.ts` (add `banked` to `HostEvent`)

**Interfaces:**
- Consumes: `stepSim(state, dt): "night" | "dawn" | null`; `sysDawn(state): {pid,salvage}[]`; `startDay(state)`; `homeSpawnFor(id)`.
- Produces: on the dawn frame the DO unicasts each present player `{ t: "banked", salvage }` on the rel channel. A fresh arena starts at **Day-1 day phase** (no held night).

- [ ] **Step 1: Add the `banked` HostEvent** in `game/net/events.ts` `HostEvent` union:

```typescript
  | { t: "banked"; salvage: number } // dawn SALVAGE payout for this player (client → addSalvage)
```

Note: adding a rel/JSON `NetMsg` variant is **additive** — the binary snapshot layout is unchanged, so `PROTOCOL_VERSION` is **not** bumped in M-A (an older client just ignores the unknown `banked` in its `onRel` if/else). The 18→19 bump belongs to M-B, where the binary snapshot changes (`inShop` bit removal).

- [ ] **Step 2: Start a fresh arena at Day-1** in `worker/arena.ts` `ensureRunning` — replace:

```typescript
    if (!this.state) {
      const s = newState();
      s.running = true;
      s.heldNight = true;
      s.day = CONFIG.siege.heldNightDay;
      startNight(s); // begin already in the held night (no day→night transition, no banner)
      this.state = s;
    }
```

with:

```typescript
    if (!this.state) {
      const s = newState();
      s.running = true;
      startDay(s); // fresh Day-1 (newState is already day/phaseT; this seeds caches + roamers)
      this.state = s;
    }
```

Update the imports at the top of `worker/arena.ts`: remove `startNight`, add `startDay` and `sysDawn`:

```typescript
import { startDay } from "../sim/systems/siege";
import { sysDawn } from "../sim/systems/dawn";
```

(Keep the existing `HOME_SPAWN` and `addPlayer`/`removePlayer` imports — `spawnFresh` still uses them.)

- [ ] **Step 3: React to `"dawn"` in `step()`** — replace the `stepSim` call block:

```typescript
    stepSim(s, 1 / CONFIG.simHz); // fixed-dt, one tick one step (no wall-clock accumulator)
    clearFx(s); // 2a: zero fxEvents on the wire — cues are all client-derived
```

with:

```typescript
    const outcome = stepSim(s, 1 / CONFIG.simHz); // fixed-dt, one tick one step
    if (outcome === "dawn") {
      // living cycle: advance the day, bank SALVAGE to present players, revive stragglers, re-enter day.
      const payouts = sysDawn(s);
      for (const { pid, salvage } of payouts) {
        if (salvage <= 0) continue;
        const peer = [...this.peers.values()].find((p) => p.decided && p.pid === pid);
        if (peer) this.send(peer.ws, { t: "banked", salvage });
      }
    }
    clearFx(s); // zero fxEvents on the wire — cues are all client-derived
```

- [ ] **Step 4: Refresh the `spawnFresh` comment** in `worker/arena.ts` (coordinates unchanged — the spread widening is deferred, see Task 3's Scope note). Replace only the comment:

```typescript
    const x = HOME_SPAWN.x + ((pid % 4) - 1.5) * 36;
    // 2a held-night gate: spawn ALIVE at HOME (downed-spawn / spectate = 2b)
    addPlayer(s, pid, x, HOME_SPAWN.y, `P${pid + 1}`);
```

with:

```typescript
    const x = HOME_SPAWN.x + ((pid % 4) - 1.5) * 36;
    // drop-in: spawn ALIVE at the fortress in the current phase (respawn/spectate handled by sysRespawn)
    addPlayer(s, pid, x, HOME_SPAWN.y, `P${pid + 1}`);
```

- [ ] **Step 5: Full typecheck**

Run: `bun run typecheck`
Expected: PASS (the whole repo now compiles — arena.ts no longer references `heldNight`/`heldNightDay`/`startNight`).

- [ ] **Step 6: Verify the live cycle** (DO/client not unit-tested — use the harness):

Run: `bun run dev:coop`, open `http://localhost:5173`, Start → arena `MAIN`. Observe:
- Boots into **Day-1** (daytime ambient, roamers), not a held night.
- Day timer runs → **NIGHT** banner + horde → night clock → **DAY** banner, day counter increments, ambient returns.
- The worker log shows the `[arena] effective … Hz` line steady through the transition.

Expected: a full day→night→day cycle with no freeze/pause.

- [ ] **Step 7: Commit**

```bash
git add worker/arena.ts game/net/events.ts
git commit -m "feat(net): DO drives the day/night cycle — Day-1 start, dawn banking unicast"
```

---

### Task 6: Client banks the dawn payout

**Files:**
- Modify: `game/game.ts` (export `clientBanked`)
- Modify: `game/net/client.ts` (handle the `banked` rel message)

**Interfaces:**
- Consumes: `addSalvage(amount)` (`game/meta.ts`, already imported in `game.ts`); the `{ t: "banked"; salvage }` rel message.
- Produces: `clientBanked(salvage: number): void` (exported from `game.ts`) — banks to this machine's meta.

- [ ] **Step 1: Add `clientBanked` to `game/game.ts`** (near `clientGameOver`):

```typescript
/** Apply a dawn SALVAGE payout: bank this player's share to their cross-run meta. Unlike
 *  clientGameOver this does NOT end the run — the arena keeps cycling. */
export function clientBanked(salvage: number): void {
  addSalvage(salvage);
}
```

- [ ] **Step 2: Handle the message in `game/net/client.ts`** — in the `onRel` handler, add a branch beside the `gameover` one:

```typescript
      } else if (msg.t === "banked") {
        clientBanked(msg.salvage);
```

and add `clientBanked` to the existing `../game` import.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Verify banking end-to-end** (harness):

Run: `bun run dev:coop`, play through one full night into dawn. In DevTools, read `localStorage.getItem("q_meta")` before and after dawn — the `salvage` balance should increase at the dawn transition. (No death required — the point of fork Q3.)

Expected: SALVAGE balance rises each dawn.

- [ ] **Step 5: Commit**

```bash
git add game/game.ts game/net/client.ts
git commit -m "feat(net): client banks the dawn SALVAGE payout (banked rel message)"
```

---

### Task 7: Verify drop-in coherence (no spurious banner on join)

**Files:**
- Verify only: `sim/systems/siegeEdge.test.ts` (already exists and already covers `prev=null`).

**Interfaces:**
- Consumes: `siegeEdgeCue(prev, next, day)` — already returns `[]` when `prev === null` (`siegeEdge.ts:9`).

No code change: `spawnFresh` (Task 5) already spawns joiners alive at the fortress, `phase`/`day`/`phaseT` already ride the snapshot, and the client starts `prevPhase = null` so the first snapshot fires no banner. This task is a **verification gate**, not new work.

- [ ] **Step 1: Confirm the unit coverage already exists.** `sim/systems/siegeEdge.test.ts` already has: `it("no edge (same phase, or first snapshot prev=null) yields nothing", …)` asserting `siegeEdgeCue(null, "night", 4)` → `[]`. Do **not** overwrite the file. If (and only if) that assertion is somehow missing, add it — otherwise leave the file untouched.

Run: `bun run test -- sim/systems/siegeEdge.test.ts`
Expected: PASS (the drop-in case is present).

- [ ] **Step 2: Verify drop-in in the harness:** with `bun run dev:coop` running and an arena mid-night (from Task 5), open a **second** browser tab and join the same arena. The joiner should spawn alive at the fortress in the current night with **no** NIGHT banner and no mass kill/spawn burst.

(No commit — verification only.)

---

## Final verification

- [ ] **Full gate:** `bun run typecheck && bun run test && bun run lint && bun run build`
- [ ] **Playtest (feel gate, M-A scope = loop mechanics only):** `bun run dev:coop` — verify (a) Day-1 start; (b) a full day→night→day cycle with day counter advancing; (c) die at night → ~17s spectate → respawn at the fortress; (d) a teammate peer-revives faster in place; (e) all-party-down → night continues → dawn revives everyone (no game-over); (f) SALVAGE rises each dawn without dying; (g) mid-night drop-in coherent (no banner). Keep the horizon short — difficulty/economy feel is out of scope until M-B (no shop → no run progression, so the day-scaled curve gets punishing).

## Notes for M-B / M-C (do NOT implement here)

- **M-B (per-player shop):** DO `onMessage` handles the 5 CoopEvents (rebase `apply*` guards off `state.inShop` onto `phase==="day"` + fortress radius); per-player dawn draft roll with a `draftRolledForDay` guard; retire `state.inShop` (5 snapshot sites + `PROTOCOL_VERSION` 18→19 + hello v-gate); client shop UI non-pausing/day-only/fortress-gated with movement-input suppression; **idle-body-at-daytime-fortress safety is a blocking feel gate**.
- **M-C (resilience/cleanup):** drive the client auto-reconnect loop over `wsLink`; migrate `flashT` fully client-side (State-only today, not snapshotted; sysAI's server bump is discarded — derive from local `hitFlash` edge); stale-comment triage (`sim/config.ts`, `game/net/events.ts`, `game/net/client.ts` reconnect comments, `sim/engine/players.ts` game-over comments); delete the now-dead `gameover`/`clientGameOver`/`endRun` client path.
