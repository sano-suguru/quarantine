# DO Server — Phase 2: Authority Relocation (browser → DO) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate the authoritative simulation from the host browser (method C, WebRTC listen server) to a Cloudflare Durable Object; every player becomes a WebSocket client of one always-live DO, and the held-night feel gate proves prediction + edge placement hold over the extra hop.

**Architecture:** Extract a headless `stepSim` into `sim/` (the DO can't run `game.ts`'s DOM-coupled `update()`). Add a WebSocket `Arena` DO that runs `stepSim` on a fixed-dt `setInterval` loop and broadcasts binary snapshots. The client keeps its prediction/interpolation and derives all fx from synced snapshot fields (derive-first — **zero `fxEvents` on the wire in 2a**). Work lands in two milestones so every commit stays runnable: **Milestone A** adds the DO path *alongside* method C (safe, additive, mergeable); **Milestone B** is the atomic cutover + method-C deletion.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Bun, Vite, Vitest, Biome, Cloudflare Workers/Durable Objects (`wrangler`), WebSocket. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-12-do-server-phase2-authority-relocation-design.md` (roots a–d, derive-first, sequencing). Umbrella scope: `docs/superpowers/specs/2026-07-11-do-authoritative-server-design.md`.

## Global Constraints

- **Big-bang, but bisection-safe:** method C stays fully runnable through Milestone A; Milestone B Task 12 is the single atomic cutover. Never leave a commit with nothing runnable.
- **`sim/` imports nothing from `game/` or the DOM/WebAudio/WebGL.** It type-checks under `lib: ["ES2022"]` (its own `sim/tsconfig.json`). The DO (`worker/`) and the client (`game/`) both depend on `sim/`; neither the DO nor `sim/` may import `game/`.
- **The DO sim never globally pauses** — `state.paused`/`inShop` are never set server-side (`stepSim` returns `"dawn"` instead of calling `openShop()`).
- **2a carries zero `fxEvents` on the wire** — the DO clears `state.fxEvents` each tick; the client derives all cues from synced fields.
- **Single-player / method-C feel stays unchanged through Milestone A** (the CLAUDE.md invariant): the `stepSim` extraction is byte-identical system logic wrapped by `game.ts`'s `update()`.
- **Data-driven, no special-case debt:** held-night is one explicit `heldNight` flag consulted by `sysSiege`, not a magic config value.
- **TDD** for pure logic (`roster`, `wire`, `heldNight`/`sysSiege`, `stepSim` transition returns, `siegeEdgeCue`). DO loop / WebSocket / transport adapter / feel are validated on the `wrangler dev` harness + playtest, not unit tests (per CLAUDE.md).
- **Gates before each commit:** `bun run typecheck && bun run test && bun run lint`. For `worker/` changes also `cd worker && bunx tsc --noEmit` (uses the root-pinned tsc). `bun run build` before the milestone-closing commits.
- Swap-and-pop array removal, world-space coords, mutable data types — existing conventions unchanged.

## File Structure

**New — `sim/` (pure, shared by DO + client):**
- `sim/net/roster.ts` — pure connection helpers (`pickSlot` 0-based, `makeNonce`, `rejoinMatches`). + `sim/net/roster.test.ts`.
- `sim/net/wire.ts` — pure 1-byte-tag framing (`frameSnap`/`frameRel`/`unframe`). + `sim/net/wire.test.ts`.
- `sim/step.ts` — headless `stepSim(state, dt)`. + `sim/step.test.ts`.
- `sim/systems/siegeEdge.ts` — pure `siegeEdgeCue(prev, next, day)` (client transition derivation). + `sim/systems/siegeEdge.test.ts`.

**Modified — `sim/`:**
- `sim/types.ts` — add `heldNight: boolean` to `State`.
- `sim/state.ts` — init `heldNight: false`.
- `sim/systems/siege.ts` — `heldNight` short-circuit.
- `sim/config.ts` — `net.maxPlayers`, `net.inputHz`, `siege.heldNightDay`; retune `net.interpDelayMs`/`smoothCorrect`/`snapTeleportThresh` (Milestone B).

**New — `worker/` (DO authority):**
- `worker/arena.ts` — the `Arena` DO (WS accept, `setInterval` loop, roster, broadcast, metrics).

**Modified — `worker/`:**
- `worker/room.ts` — route `/arena/:CODE` to the `Arena` DO; export `Arena`.
- `worker/wrangler.toml` — `ARENA` DO binding + migration.
- `worker/tsconfig.json` — include `arena.ts`.

**New — `game/` (client transport):**
- `game/net/wsLink.ts` — `createArenaLink(url)`: a `PeerLink`-shaped adapter over one WebSocket.

**Modified — `game/`:**
- `game/net/signaling.ts` — `arenaUrl(code)` dial helper.
- `game/net/net.ts` — add the coexisting `"doclient"` mode (Milestone A); collapse to one path (Milestone B).
- `game/game.ts` — `update()` becomes a `stepSim` wrapper (Milestone A); deleted (Milestone B).
- `game/net/client.ts` — prevPhase-edge transition derivation (Milestone B); reconcile retune.
- `game/main.ts` — add `doclient` path (Milestone A); collapse three paths → one (Milestone B).
- **Deleted (Milestone B):** `game/net/host.ts`, `game/net/transport.ts`, `game/net/ticker.ts`, + method-C signaling/lobby.

---

# MILESTONE A — Additive DO path (method C untouched)

## Task 1: Capture the method-C netStats baseline

**Files:**
- Create: `docs/superpowers/notes/2026-07-12-method-c-netstats-baseline.md`

**Interfaces:** none (documented measurement; the comparison bar for the Task 14 feel gate).

This is a **pre-condition for big-bang** — method C is deleted in Milestone B, so the baseline must be recorded while it still runs. No production code changes.

- [ ] **Step 1: Run a method-C co-op session with netlog**

Run `bun run dev:coop`. In one browser open `http://localhost:5173/?netlog`, Host a raid, Deploy. In a second browser (or device) join by the room code with `?netlog`. Play into a night horde.

- [ ] **Step 2: Record the numbers + a feel note**

On the client, read the `#netstat` HUD line (`RTT … · loss … · reord … · frz … · jit … · snap …`). Capture typical values during the night horde (not the lobby). Write `docs/superpowers/notes/2026-07-12-method-c-netstats-baseline.md` with: the measured `rtt/loss/reorders/freeze/jitter/interval` (a representative range, e.g. median + peak), the network setup (same-machine two tabs vs LAN vs internet+TURN), and a 2–3 sentence **qualitative feel note** (aim/fire responsiveness, hit-registration lag, corpse/kill timing). Note this is the method-C bar the DO path is compared against, and that the RTT metric semantics differ on the DO path (WebRTC rel channel vs TCP-multiplexed — see spec Open Questions), so compare feel + freeze% primarily, RTT with that caveat.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/notes/2026-07-12-method-c-netstats-baseline.md
git commit -m "docs(net): capture method-C netStats baseline before big-bang"
```

---

## Task 2: Pure roster helpers in `sim/net/`

**Files:**
- Create: `sim/net/roster.ts`, `sim/net/roster.test.ts`

**Interfaces:**
- Produces:
  - `type SlotDecision = { kind: "assign"; pid: number } | { kind: "full" }`
  - `pickSlot(decidedPids: Iterable<number>, max: number): SlotDecision` — lowest free pid in `0..max-1` (0-based; **no reserved host slot**, unlike `host.ts`'s 1-based `pickSlot`).
  - `makeNonce(): string` — cooperative-unique reconnect token.
  - `rejoinMatches(cand: { pid: number; nonce: string; decided: boolean }, pid: number, nonce: string): boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// sim/net/roster.test.ts
import { describe, expect, it } from "vitest";
import { makeNonce, pickSlot, rejoinMatches } from "./roster";

describe("pickSlot (0-based, no host reservation)", () => {
  it("assigns the lowest free slot from 0", () => {
    expect(pickSlot([], 12)).toEqual({ kind: "assign", pid: 0 });
    expect(pickSlot([0, 1], 12)).toEqual({ kind: "assign", pid: 2 });
    expect(pickSlot([0, 2], 12)).toEqual({ kind: "assign", pid: 1 }); // fills the gap
  });
  it("returns full when every slot is taken", () => {
    expect(pickSlot([0, 1, 2], 3)).toEqual({ kind: "full" });
  });
});

describe("makeNonce", () => {
  it("produces distinct tokens", () => {
    expect(makeNonce()).not.toBe(makeNonce());
  });
});

describe("rejoinMatches", () => {
  const cand = { pid: 3, nonce: "abc", decided: true };
  it("matches on pid+nonce for a decided peer", () => {
    expect(rejoinMatches(cand, 3, "abc")).toBe(true);
  });
  it("rejects a wrong nonce, wrong pid, or undecided peer", () => {
    expect(rejoinMatches(cand, 3, "xyz")).toBe(false);
    expect(rejoinMatches(cand, 2, "abc")).toBe(false);
    expect(rejoinMatches({ ...cand, decided: false }, 3, "abc")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- roster.test.ts`
Expected: FAIL — `Cannot find module './roster'`.

- [ ] **Step 3: Implement `sim/net/roster.ts`**

```ts
// sim/net/roster.ts
// Pure connection-lifecycle helpers, shared by the Arena DO (worker/) and any future
// client-authority fallback. No DOM / no @cloudflare/workers-types (sim/ boundary).

export type SlotDecision = { kind: "assign"; pid: number } | { kind: "full" };

/**
 * Lowest free player id in 0..max-1, or `full`. Ported from host.ts's pickSlot but 0-based:
 * the DO has no host player, so every slot 0..max-1 is a client. A slot counts occupied by ANY
 * decided peer (open OR held-absent for reconnect) — a held body's slot is reserved for its owner.
 */
export function pickSlot(decidedPids: Iterable<number>, max: number): SlotDecision {
  const used = new Set(decidedPids);
  for (let n = 0; n < max; n++) if (!used.has(n)) return { kind: "assign", pid: n };
  return { kind: "full" };
}

let nonceSeq = 0;
/** Cooperative (not adversarial) reconnect token — unique enough not to collide in a session. */
export function makeNonce(): string {
  return `${(nonceSeq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A rejoin claim matches a still-held peer when it is decided and pid+nonce both agree. */
export function rejoinMatches(
  cand: { pid: number; nonce: string; decided: boolean },
  pid: number,
  nonce: string,
): boolean {
  return cand.decided && cand.pid === pid && cand.nonce === nonce;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- roster.test.ts`
Expected: PASS.

- [ ] **Step 5: Boundary + commit**

Run: `bunx tsc --noEmit -p sim/tsconfig.json` (must PASS — no DOM leaked in).

```bash
git add sim/net/roster.ts sim/net/roster.test.ts
git commit -m "feat(sim): pure roster helpers (0-based pickSlot, nonce, rejoin match)"
```

---

## Task 3: Pure 1-byte-tag wire framing in `sim/net/`

**Files:**
- Create: `sim/net/wire.ts`, `sim/net/wire.test.ts`

**Interfaces:**
- Produces:
  - `const NET_TAG = { snap: 1, rel: 2 } as const`
  - `frameSnap(buf: ArrayBuffer): ArrayBuffer` — tag byte + raw snapshot bytes.
  - `frameRel(obj: unknown): ArrayBuffer` — tag byte + UTF-8 JSON.
  - `type Unframed = { kind: "snap"; buf: ArrayBuffer } | { kind: "rel"; obj: unknown }`
  - `unframe(data: ArrayBuffer): Unframed` — peel the tag, slice/parse the rest.

Collapses today's two WebRTC channels (`snap` unreliable + `rel` reliable JSON) into one ordered binary WebSocket stream. `TextEncoder`/`TextDecoder` are ES2022 globals (available under the sim `lib`, no DOM).

- [ ] **Step 1: Write the failing test**

```ts
// sim/net/wire.test.ts
import { describe, expect, it } from "vitest";
import { frameRel, frameSnap, unframe } from "./wire";

describe("wire framing", () => {
  it("round-trips a snapshot buffer behind the snap tag", () => {
    const payload = new Uint8Array([9, 8, 7, 255, 0]).buffer;
    const u = unframe(frameSnap(payload));
    expect(u.kind).toBe("snap");
    if (u.kind === "snap") expect(new Uint8Array(u.buf)).toEqual(new Uint8Array([9, 8, 7, 255, 0]));
  });
  it("round-trips a rel object behind the rel tag", () => {
    const u = unframe(frameRel({ t: "join" }));
    expect(u.kind).toBe("rel");
    if (u.kind === "rel") expect(u.obj).toEqual({ t: "join" });
  });
  it("distinguishes the two by the leading tag byte", () => {
    expect(new Uint8Array(frameSnap(new Uint8Array([1]).buffer))[0]).toBe(1);
    expect(new Uint8Array(frameRel({}))[0]).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- wire.test.ts`
Expected: FAIL — `Cannot find module './wire'`.

- [ ] **Step 3: Implement `sim/net/wire.ts`**

```ts
// sim/net/wire.ts
// One binary WebSocket multiplexes snapshots (binary) and reliable messages (JSON) behind a
// 1-byte tag. Pure: TextEncoder/TextDecoder are ES2022 globals, no DOM.

export const NET_TAG = { snap: 1, rel: 2 } as const;

const enc = new TextEncoder();
const dec = new TextDecoder();

function withTag(tag: number, body: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(body.length + 1);
  out[0] = tag;
  out.set(body, 1);
  return out.buffer;
}

export function frameSnap(buf: ArrayBuffer): ArrayBuffer {
  return withTag(NET_TAG.snap, new Uint8Array(buf));
}

export function frameRel(obj: unknown): ArrayBuffer {
  return withTag(NET_TAG.rel, enc.encode(JSON.stringify(obj)));
}

export type Unframed = { kind: "snap"; buf: ArrayBuffer } | { kind: "rel"; obj: unknown };

export function unframe(data: ArrayBuffer): Unframed {
  const bytes = new Uint8Array(data);
  const body = bytes.subarray(1);
  if (bytes[0] === NET_TAG.snap) {
    // copy so the returned ArrayBuffer isn't a view into the socket's larger buffer
    return { kind: "snap", buf: body.slice().buffer };
  }
  return { kind: "rel", obj: JSON.parse(dec.decode(body)) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- wire.test.ts`
Expected: PASS.

- [ ] **Step 5: Boundary + commit**

Run: `bunx tsc --noEmit -p sim/tsconfig.json` (PASS).

```bash
git add sim/net/wire.ts sim/net/wire.test.ts
git commit -m "feat(sim): 1-byte-tag wire framing (snap binary + rel JSON on one stream)"
```

---

## Task 4: `heldNight` flag + `sysSiege` short-circuit + config

**Files:**
- Modify: `sim/types.ts` (add `heldNight`), `sim/state.ts` (init), `sim/systems/siege.ts` (short-circuit), `sim/config.ts` (`net.maxPlayers`, `siege.heldNightDay`)
- Test: `sim/systems/siege.test.ts` (create)

**Interfaces:**
- Produces: `State.heldNight: boolean`; `sysSiege` returns `null` (never `"dawn"`) while `heldNight`, re-arming the night clock so it never elapses.
- Config: `CONFIG.net.maxPlayers = 12`; `CONFIG.siege.heldNightDay` — the representative mid-game day the DO starts the held night at (choose `4`; tune at the gate).

- [ ] **Step 1: Write the failing test**

```ts
// sim/systems/siege.test.ts
import { describe, expect, it } from "vitest";
import { newState } from "../state";
import { startNight, sysSiege } from "./siege";

describe("heldNight", () => {
  it("never returns dawn while held; the night clock stays positive", () => {
    const s = newState();
    s.running = true;
    s.heldNight = true;
    startNight(s); // phase=night, phaseT=nightDuration(day)
    // drive far past the normal night length
    for (let i = 0; i < 100000; i++) {
      const ev = sysSiege(s, 1 / 60);
      expect(ev).not.toBe("dawn");
    }
    expect(s.phase).toBe("night");
    expect(s.phaseT).toBeGreaterThan(0);
  });

  it("still returns dawn when NOT held", () => {
    const s = newState();
    s.running = true;
    s.heldNight = false;
    startNight(s);
    s.phaseT = 0.0001;
    expect(sysSiege(s, 1 / 60)).toBe("dawn");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test -- siege.test.ts`
Expected: FAIL — `heldNight` missing on `State` / dawn still returned.

- [ ] **Step 3: Add the field + init**

In `sim/types.ts`, on the `State` interface (near `phase`/`phaseT`, ~line 560):

```ts
  /** DO held-night gate (2a): sysSiege never transitions to dawn while true, so the arena runs
   *  a sustained night and never globally pauses (per-player shop + day/night cycle = 2b). */
  heldNight: boolean;
```

In `sim/state.ts` `newState()` (beside `phaseT`, ~line 92): add `heldNight: false,`.

- [ ] **Step 4: Short-circuit `sysSiege`**

In `sim/systems/siege.ts`, replace the night branch (`:83–86`):

```ts
  // night: spawns keep coming (capped); dawn arrives on the clock, not on a wipe-out
  sysWave(state, dt, nightMaxZombies(state.day));
  state.phaseT -= dt;
  if (state.phaseT > 0) return null;
  if (state.heldNight) {
    // held night (DO 2a): re-arm the night clock so it loops (18:00→06:00 repeats) and never dawns
    state.phaseT = nightDuration(state.day);
    return null;
  }
  return "dawn";
```

- [ ] **Step 5: Add config**

In `sim/config.ts` `net:` block add `maxPlayers: 12,` and `inputHz: 25,` (used in Task 11; add now to co-locate). In the `siege:` block add `heldNightDay: 4,` (representative mid-game night for the gate).

- [ ] **Step 6: Run test + gates**

Run: `bun run test -- siege.test.ts` (PASS), then `bun run typecheck && bun run lint` and `bunx tsc --noEmit -p sim/tsconfig.json`.

- [ ] **Step 7: Commit**

```bash
git add sim/types.ts sim/state.ts sim/systems/siege.ts sim/systems/siege.test.ts sim/config.ts
git commit -m "feat(sim): heldNight flag holds sysSiege at night (DO 2a gate); net.maxPlayers/inputHz"
```

---

## Task 5: Extract headless `sim/step.ts`; wrap it in `game.ts`'s `update()`

**Files:**
- Create: `sim/step.ts`, `sim/step.test.ts`
- Modify: `game/game.ts` (`update()` becomes a wrapper)

**Interfaces:**
- Produces: `stepSim(state: State, dt: number): "night" | "dawn" | "wipe" | null` — the headless authoritative step. Runs the systems + `sysSiege`, pushes transition `fxEvents`, and **returns** the discrete outcome instead of calling `openShop()`/`gameOver()`. Excludes `sysFx`/`sysCamera`.
- Consumes (in `game.ts`): `stepSim`, then the client reactions.

- [ ] **Step 1: Read the current `update()` body**

Run: `sed -n '183,219p' game/game.ts`. Note the exact system order and the two client reactions (`gameOver()` on `!anyAlive`, `openShop()` on `ev==="dawn"`), and the `sysFx`/`sysCamera` calls to exclude.

- [ ] **Step 2: Write the failing test**

```ts
// sim/step.test.ts
import { describe, expect, it } from "vitest";
import { newState } from "./state";
import { stepSim } from "./step";

describe("stepSim", () => {
  it("returns 'night' and pushes the NIGHT/waveStart cues on the day→night edge", () => {
    const s = newState();
    s.running = true;
    s.phase = "day";
    s.phaseT = 0.0001; // one step tips it to night
    expect(stepSim(s, 1 / 60)).toBe("night");
    expect(s.fxEvents.some((e) => e.t === "announce" && e.label === "NIGHT")).toBe(true);
    expect(s.fxEvents.some((e) => e.t === "audio" && e.cue === "waveStart")).toBe(true);
  });
  it("returns null on a normal tick and does NOT set paused/inShop (no openShop)", () => {
    const s = newState();
    s.running = true;
    expect(stepSim(s, 1 / 60)).toBe(null);
    expect(s.paused).toBe(false);
    expect(s.inShop).toBe(false);
  });
  it("returns 'wipe' when no player is alive", () => {
    const s = newState();
    s.running = true;
    for (const p of s.players) p.hp = 0;
    expect(stepSim(s, 1 / 60)).toBe("wipe");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `bun run test -- step.test.ts`
Expected: FAIL — `Cannot find module './step'`.

- [ ] **Step 4: Create `sim/step.ts`**

Copy the `update()` body from `game.ts:183` verbatim, then apply exactly these changes: remove `sysFx`/`sysCamera` calls; replace `gameOver(); return;` with `return "wipe";`; replace the `ev === "dawn"` block's `openShop();` with `return "dawn";` (keep the `state.stalker.state = "retreat"` + `dawn` audio push); make the `ev === "night"` block `return "night";` (keep `spawnStalker` + the two pushes). Import every system/helper from `sim/` (they are all already there — `sysPlayer`/`sysAssist`/`sysAI`/`sysStalker`/`spawnStalker`/`sysDeployables`/`sysBullets`/`sysPickups`/`sysSiege` from `./systems/*`, `anyAlive` from `./engine/players`, `pushFx` from `./events`, `CONFIG` from `./config`).

```ts
// sim/step.ts
import { CONFIG } from "./config";
import { anyAlive } from "./engine/players";
import { pushFx } from "./events";
import { sysAI } from "./systems/ai";
import { sysAssist } from "./systems/assist";
import { sysBullets } from "./systems/bullets";
import { sysDeployables } from "./systems/deployables";
import { sysPickups } from "./systems/pickups";
import { sysPlayer } from "./systems/player";
import { sysSiege } from "./systems/siege";
import { spawnStalker, sysStalker } from "./systems/stalker";
import type { State } from "./types";

/**
 * The headless authoritative step. The DO's setInterval loop calls this once per fixed tick.
 * Returns the frame's discrete siege/end outcome INSTEAD of calling the client-side reactions
 * (openShop on dawn, gameOver on wipe) — the caller decides. Excludes sysFx/sysCamera (cosmetic,
 * per-client). Pushed transition events are cosmetic fxEvents; the DO clears them each tick.
 */
export function stepSim(state: State, dt: number): "night" | "dawn" | "wipe" | null {
  if (!state.running || state.paused) return null;
  let sdt = dt;
  if (state.hitstopT > 0) {
    state.hitstopT -= dt;
    sdt = dt * CONFIG.feel.hitstopScale;
  }
  state.flashT *= Math.exp(-CONFIG.feel.flashDecay * dt);
  state.time += sdt;
  sysPlayer(state, sdt);
  sysAssist(state, sdt);
  sysAI(state, sdt);
  if (!anyAlive(state)) return "wipe";
  if (state.stalker) sysStalker(state, sdt);
  sysDeployables(state, sdt);
  sysBullets(state, sdt);
  sysPickups(state, sdt);
  const ev = sysSiege(state, sdt);
  if (ev === "night") {
    spawnStalker(state);
    pushFx(state, { t: "announce", label: "NIGHT", day: state.day });
    pushFx(state, { t: "audio", cue: "waveStart" });
    return "night";
  }
  if (ev === "dawn") {
    if (state.stalker) state.stalker.state = "retreat";
    pushFx(state, { t: "audio", cue: "dawn" });
    return "dawn";
  }
  return null;
}
```

(If `tsc` reports a different import path for `spawnStalker`/`sysStalker`, match `game.ts`'s existing imports — do not guess.)

- [ ] **Step 5: Run to verify it passes**

Run: `bun run test -- step.test.ts`
Expected: PASS.

- [ ] **Step 6: Rewrite `game.ts`'s `update()` as a wrapper**

Replace the body of `game.ts`'s `update()` (`:183–219`) with a call to `stepSim` + the client reactions. Add `import { stepSim } from "../sim/step";`. Keep `sysFx`/`sysCamera` imports.

```ts
export function update(state: State, dt: number): void {
  const r = stepSim(state, dt);
  if (r === "wipe") {
    gameOver();
    return;
  }
  if (r === "dawn") openShop();
  // cosmetic tail — client-side only (the DO never runs these). Guarded like the old update().
  if (state.running && !state.paused) {
    sysFx(state, dt);
    sysCamera(state, dt);
  }
}
```

Note: `sysFx`/`sysCamera` now run with `dt` (not the hitstop-scaled `sdt`) and just after `sysSiege` instead of just before — inconsequential (`sysSiege`/`sysWave` create no particles and don't touch `state.cam`; hitstop is a brief cosmetic scale). Confirmed by the Step 8 feel check.

- [ ] **Step 7: Gates**

Run: `bun run typecheck && bun run test && bun run lint` (PASS) and `bunx tsc --noEmit -p sim/tsconfig.json` (PASS — `sim/step.ts` pulls in no DOM).

- [ ] **Step 8: Single-player feel check (invariant)**

Run `bun run dev`, play a full day→night→dawn cycle. Verify **feel-unchanged**: movement, fire/melee, kills (spark+shake+sound), hits, hurt, pickups, reload/switch, repair, NIGHT/DAY banners, wave-start/dawn stings, dread ambience — all identical to before. Record the result honestly (feel gate, not a unit test).

- [ ] **Step 9: Commit**

```bash
git add sim/step.ts sim/step.test.ts game/game.ts
git commit -m "refactor(sim): extract headless stepSim; game.ts update() wraps it (SP feel-unchanged)"
```

---

## Task 6: Arena DO skeleton — loop + broadcast + metrics

**Files:**
- Create: `worker/arena.ts`
- Modify: `worker/room.ts` (route `/arena/:CODE`, export `Arena`), `worker/wrangler.toml` (binding + migration), `worker/tsconfig.json` (include `arena.ts`)

**Interfaces:**
- Produces: the `Arena` DO — accepts a WebSocket at `/arena/:CODE`, runs `stepSim` on `setInterval(1000/CONFIG.simHz)`, broadcasts `frameSnap(encodeSnapshot(state, tick))` at `CONFIG.net.sendHz`, tracks an effective-tick-rate counter + snapshot-size, stops the loop when empty.
- Consumes: `sim/step` `stepSim`, `sim/state` `newState`, `sim/snapshot` `encodeSnapshot`, `sim/systems/siege` `startNight`, `sim/events` `clearFx`, `sim/net/wire` `frameSnap`, `CONFIG`.

This task establishes the loop + broadcast with a **single hard-coded player** (no lifecycle yet); Task 7 adds join/rejoin. Verified by typecheck + a `wrangler dev` smoke, not a unit test (DO runtime).

- [ ] **Step 1: Add the DO binding + migration to `worker/wrangler.toml`**

After the `REGISTRY` binding block, add:

```toml
# Authoritative game-arena DO (sub-project 2a). One arena = one DO (idFromName = room code).
# Runs the sim loop + broadcasts snapshots over one WebSocket per client.
[[durable_objects.bindings]]
name = "ARENA"
class_name = "Arena"
```

After the `v2` migration block, add:

```toml
[[migrations]]
tag = "v3"
new_sqlite_classes = ["Arena"]
```

- [ ] **Step 2: Include `arena.ts` in `worker/tsconfig.json`**

Change `"include": ["room.ts"]` → `"include": ["room.ts", "arena.ts"]`.

- [ ] **Step 3: Create `worker/arena.ts` (skeleton: loop + broadcast + metrics)**

```ts
// worker/arena.ts
// Authoritative game arena as a Durable Object. Runs the headless sim on a fixed-dt setInterval
// loop and broadcasts binary snapshots to every connected client over one WebSocket each.
// Standard WebSocket API (not Hibernation): the loop is non-hibernatable anyway, and an in-memory
// socket map mirrors the proven room.ts pattern.
import { CONFIG } from "../sim/config";
import { clearFx } from "../sim/events";
import { frameSnap } from "../sim/net/wire";
import { encodeSnapshot } from "../sim/snapshot";
import { startNight } from "../sim/systems/siege";
import { newState } from "../sim/state";
import { stepSim } from "../sim/step";
import type { State } from "../sim/types";

export interface Env {
  ARENA: DurableObjectNamespace;
}

const STEP_MS = 1000 / CONFIG.simHz;
const BROADCAST_EVERY = Math.max(1, Math.round(CONFIG.simHz / CONFIG.net.sendHz)); // ticks per broadcast

export class Arena {
  private sockets = new Set<WebSocket>();
  private state: State | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  // metrics (spec §feel gate): effective tick rate + last snapshot size, logged periodically.
  private ticksThisWindow = 0;
  private windowStartMs = 0;
  private lastSnapBytes = 0;

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1] as WebSocket;
    server.accept();
    this.attach(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private ensureRunning(): void {
    if (!this.state) {
      const s = newState();
      s.running = true;
      s.heldNight = true;
      s.day = CONFIG.siege.heldNightDay;
      startNight(s); // begin already in the held night (no day→night transition, no banner)
      this.state = s;
    }
    if (!this.loop) {
      this.windowStartMs = Date.now();
      this.loop = setInterval(() => this.step(), STEP_MS);
    }
  }

  private step(): void {
    const s = this.state;
    if (!s) return;
    stepSim(s, 1 / CONFIG.simHz); // fixed-dt, one tick one step (no wall-clock accumulator)
    clearFx(s); // 2a: zero fxEvents on the wire — cues are all client-derived
    this.tick++;
    this.ticksThisWindow++;
    if (this.tick % BROADCAST_EVERY === 0) this.broadcast();
    // effective tick-rate log every ~5 s (spec: the 30 Hz-fallback trigger + gate instrument)
    const now = Date.now();
    if (now - this.windowStartMs >= 5000) {
      const hz = (this.ticksThisWindow * 1000) / (now - this.windowStartMs);
      console.log(`[arena] effective ${hz.toFixed(1)} Hz · snap ${this.lastSnapBytes} B · clients ${this.sockets.size}`);
      this.ticksThisWindow = 0;
      this.windowStartMs = now;
    }
  }

  private broadcast(): void {
    const s = this.state;
    if (!s || this.sockets.size === 0) return;
    const buf = encodeSnapshot(s, this.tick);
    this.lastSnapBytes = buf.byteLength;
    const framed = frameSnap(buf);
    for (const ws of this.sockets) {
      try {
        ws.send(framed);
      } catch {
        /* socket mid-close — the close handler prunes it */
      }
    }
  }

  private attach(ws: WebSocket): void {
    this.sockets.add(ws);
    this.ensureRunning();
    // Task 7 adds the join/rejoin/input message handling. Skeleton: just keep the socket
    // so it receives broadcasts; drop it on close and stop the loop when empty.
    ws.addEventListener("close", () => this.detach(ws));
    ws.addEventListener("error", () => this.detach(ws));
  }

  private detach(ws: WebSocket): void {
    this.sockets.delete(ws);
    if (this.sockets.size === 0) this.stop();
  }

  private stop(): void {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    this.state = null; // 2a: a fully-empty arena resets (persistence = 2b)
    this.tick = 0;
  }
}
```

- [ ] **Step 4: Route `/arena/:CODE` in `worker/room.ts`**

Add the export near the `Registry` re-export (`room.ts:15`):

```ts
export { Arena } from "./arena";
```

Add `ARENA: DurableObjectNamespace;` to the `Env` interface. In `fetch()`, before the `/room/` match, add:

```ts
    const arenaMatch = url.pathname.match(/^\/arena\/([^/]+)$/);
    if (arenaMatch) {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const code = decodeURIComponent(arenaMatch[1] as string).toUpperCase();
      return env.ARENA.get(env.ARENA.idFromName(code)).fetch(req);
    }
```

- [ ] **Step 5: Worker typecheck**

Run: `cd worker && bunx tsc --noEmit` (from repo root: `bunx tsc --noEmit -p worker/tsconfig.json`).
Expected: PASS. If a `sim/` import fails to resolve, confirm the relative path (`../sim/...`) and that `moduleResolution: "bundler"` is set (it is).

- [ ] **Step 6: `wrangler dev` smoke**

Run `bun run signal` (or `cd worker && bunx wrangler dev --port 8787`). In a terminal, connect a raw WebSocket to `ws://127.0.0.1:8787/arena/TEST` (e.g. a one-liner `bunx wscat` or a 5-line Bun script) and confirm: the server accepts the upgrade, `[arena] effective ~60.0 Hz` logs appear, and binary frames arrive. Kill the client → the log stops (loop cleared). This is a manual smoke; no committed test client (no gate-only code).

- [ ] **Step 7: Commit**

```bash
git add worker/arena.ts worker/room.ts worker/wrangler.toml worker/tsconfig.json
git commit -m "feat(worker): Arena DO skeleton — fixed-dt stepSim loop + snapshot broadcast + tick-rate log"
```

---

## Task 7: Arena connection lifecycle — join / rejoin / grace / input

**Files:**
- Modify: `worker/arena.ts`

**Interfaces:**
- Consumes: `sim/net/roster` (`pickSlot`, `makeNonce`, `rejoinMatches`), `sim/net/wire` (`unframe`, `frameRel`), `sim/engine/players` (`addPlayer`, `removePlayer`), `sim/data/map` (`HOME_SPAWN`), `PROTOCOL_VERSION` (import from a `sim/`-safe location — see Step 1).

Ports `host.ts`'s roster machinery, honoring the spec's two constraints: **the slot commit is `await`-free** (no double-claim race), and there is **no lobby branch** (always drop-in; every socket waits for its first `join`/`rejoin` rel). Uses `Date.now()` for grace timing (the DO wall clock; retire held bodies immediately on empty-arena stop).

- [ ] **Step 1: Resolve `PROTOCOL_VERSION` placement**

`PROTOCOL_VERSION` lives in `game/net/net.ts` today (client-side). The DO needs it for the Hello version gate but must not import `game/`. Move the constant to `sim/` — create `sim/net/protocol.ts` exporting `export const PROTOCOL_VERSION = 18;`, and re-export it from `game/net/net.ts` (`export { PROTOCOL_VERSION } from "../../sim/net/protocol";`) so existing importers are unaffected. Commit this move as part of this task.

- [ ] **Step 2: Add per-socket peer tracking + the message handler**

In `worker/arena.ts`, add a `Peer` record and replace the skeleton `attach`/`detach` with the lifecycle. Key code:

```ts
import { addPlayer, removePlayer } from "../sim/engine/players";
import { HOME_SPAWN } from "../sim/data/map";
import { frameRel, unframe } from "../sim/net/wire";
import { makeNonce, pickSlot, rejoinMatches } from "../sim/net/roster";
import { PROTOCOL_VERSION } from "../sim/net/protocol";

interface Peer {
  ws: WebSocket;
  pid: number;      // -1 until decided
  decided: boolean;
  nonce: string;
  goneAt: number;   // Date.now() when the socket dropped; 0 = live
}
```

Peer set: `private peers = new Map<WebSocket, Peer>();` (replaces the raw `sockets` set — derive the broadcast list from `peers` where `decided`). On `attach(ws)`: create an undecided `Peer`, `ensureRunning()`, wire `message`/`close`.

Message handler (all synchronous — **no `await` before `decided=true`**):

```ts
  private onMessage(peer: Peer, data: ArrayBuffer): void {
    const u = unframe(data);
    if (u.kind !== "rel") return; // clients only send rel (input/join/…) — snapshots are server→client
    const msg = u.obj as { t: string; [k: string]: unknown };
    const s = this.state;
    if (!s) return;
    if (msg.t === "join" || msg.t === "rejoin") {
      if (peer.decided) return; // duplicate claim
      if (msg.t === "rejoin") this.tryRejoin(peer, msg.pid as number, msg.nonce as string);
      else this.decideFresh(peer);
      return;
    }
    if (!peer.decided) return; // gameplay before identity is dropped
    if (msg.t === "input") {
      const p = s.players.find((pl) => pl.id === peer.pid);
      if (p) p.input = msg.input as State["players"][number]["input"];
    } else if (msg.t === "ping") {
      this.send(peer.ws, { t: "pong", id: msg.id });
    }
    // buy/place/deploy/draft: 2b (per-player shop). Not handled in the held-night gate.
  }

  private decideFresh(peer: Peer): void {
    const s = this.state;
    if (!s || peer.decided) return;
    const decided = [...this.peers.values()].filter((p) => p.decided).map((p) => p.pid);
    const slot = pickSlot(decided, CONFIG.net.maxPlayers);
    if (slot.kind === "full") {
      this.send(peer.ws, { t: "roomfull" });
      return; // client tears down on receipt
    }
    peer.pid = slot.pid;
    peer.nonce = makeNonce();
    peer.decided = true; // committed synchronously — no await above this line
    this.spawnFresh(peer.pid);
    this.sendHello(peer);
  }

  private tryRejoin(peer: Peer, pid: number, nonce: string): void {
    const s = this.state;
    if (!s) return;
    const old = [...this.peers.values()].find((p) => p !== peer && rejoinMatches(p, pid, nonce));
    const body = s.players.find((p) => p.id === pid);
    if (old && body) {
      peer.pid = pid;
      peer.nonce = nonce;
      peer.decided = true;
      body.absent = false;
      old.goneAt = 0;
      this.dropPeer(old); // untrack the stale peer (its body is now owned by `peer`)
      this.sendHello(peer);
    } else {
      this.decideFresh(peer); // grace expired / unknown token → fresh slot
    }
  }

  private spawnFresh(pid: number): void {
    const s = this.state;
    if (!s || s.players.some((p) => p.id === pid)) return;
    const x = HOME_SPAWN.x + ((pid % 4) - 1.5) * 36;
    // 2a held-night gate: spawn ALIVE at HOME (downed-spawn / spectate = 2b)
    addPlayer(s, pid, x, HOME_SPAWN.y, `P${pid + 1}`);
  }

  private sendHello(peer: Peer): void {
    const s = this.state;
    if (!s) return;
    this.send(peer.ws, { t: "hello", localId: peer.pid, owned: s.owned, nonce: peer.nonce, v: PROTOCOL_VERSION });
  }

  private send(ws: WebSocket, obj: unknown): void {
    try { ws.send(frameRel(obj)); } catch { /* mid-close */ }
  }
```

- [ ] **Step 3: Grace-hold on drop + retire in the loop**

`close`/`error` handler: if the peer is decided and its body exists, mark `body.absent = true; peer.goneAt = Date.now();` (hold for reconnect); else untrack. In `step()`, after `stepSim`, retire expired held bodies:

```ts
    const grace = CONFIG.net.reconnect.graceMs;
    const now = Date.now();
    for (const p of [...this.peers.values()]) {
      if (!p.decided || p.goneAt === 0) continue;
      if (now - p.goneAt > grace) {
        removePlayer(s, p.pid);
        this.peers.delete(p.ws);
      }
    }
```

In `stop()` (empty arena), retire immediately (avoid the frozen-clock hazard): the state is nulled anyway, so just `this.peers.clear()` — no held body survives a reset.

- [ ] **Step 4: Broadcast from decided peers**

Update `broadcast()` to send to every peer's socket (decided or not — an undecided socket simply hasn't spawned; it can still receive the world). Keep the `try/catch`.

- [ ] **Step 5: Worker typecheck + smoke**

Run: `bunx tsc --noEmit -p worker/tsconfig.json` (PASS). `wrangler dev` smoke: connect a raw WS, send `frameRel({t:"join"})`, confirm a `hello` frame (pid 0 + nonce) comes back and snapshots follow. Send a second connection → pid 1. Close one → the log shows `clients` drop; reconnect within grace with `{t:"rejoin",pid,nonce}` → no new pid assigned.

- [ ] **Step 6: Commit**

```bash
git add worker/arena.ts sim/net/protocol.ts game/net/net.ts
git commit -m "feat(worker): Arena connection lifecycle — join/rejoin/grace/input (host.ts port, no host pid)"
```

---

## Task 8: Client WebSocket transport adapter + arena dial

**Files:**
- Create: `game/net/wsLink.ts`
- Modify: `game/net/signaling.ts` (add `arenaUrl`)

**Interfaces:**
- Produces: `createArenaLink(url: string): PeerLink` — a `PeerLink`-shaped adapter over one `WebSocket`, framing via `sim/net/wire`. `arenaUrl(code: string): string` — the `ws://`/`wss://` dial URL (mirrors `roomUrl`).
- Consumes: the `PeerLink` interface (`game/net/transport.ts:94`), `sim/net/wire` (`frameSnap`/`frameRel`/`unframe`).

Not unit-tested (WebSocket/DOM); the framing it relies on is already tested (Task 3). Verified by typecheck + the Task 9 harness.

- [ ] **Step 1: Add `arenaUrl` to `signaling.ts`**

Mirror `roomUrl` (`signaling.ts:40`): `wss://` + `location.host` over https, else `ws://` + `CONFIG.net.signalUrl`. Add:

```ts
/** Dial URL for the authoritative arena DO (same scheme rules as roomUrl). */
export function arenaUrl(code: string): string {
  const https = location.protocol === "https:";
  const scheme = https ? "wss" : "ws";
  const host = https ? location.host : CONFIG.net.signalUrl;
  return `${scheme}://${host}/arena/${encodeURIComponent(code.toUpperCase())}`;
}
```

- [ ] **Step 2: Create `game/net/wsLink.ts`**

```ts
// game/net/wsLink.ts
// A PeerLink-shaped adapter over one binary WebSocket to the Arena DO. Snapshots (binary) and
// reliable messages (JSON) are multiplexed behind a 1-byte tag (sim/net/wire), so client.ts's
// existing PeerLink call sites (sendSnap/sendRel/onSnap/onRel/onOpen/onClose/close) are unchanged.
import { frameRel, unframe } from "../../sim/net/wire";
import type { PeerLink } from "./transport";

export function createArenaLink(url: string): PeerLink {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const snapCbs: ((buf: ArrayBuffer) => void)[] = [];
  const relCbs: ((obj: unknown) => void)[] = [];
  const openCbs: (() => void)[] = [];
  const closeCbs: (() => void)[] = [];
  let closed = false;
  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb();
  };
  ws.addEventListener("open", () => {
    for (const cb of openCbs) cb();
  });
  ws.addEventListener("close", fireClose);
  ws.addEventListener("error", fireClose);
  ws.addEventListener("message", (e) => {
    const u = unframe(e.data as ArrayBuffer);
    if (u.kind === "snap") for (const cb of snapCbs) cb(u.buf);
    else for (const cb of relCbs) cb(u.obj);
  });
  return {
    sendSnap() {
      /* client never sends snapshots (server→client only); no-op keeps the interface shape */
    },
    sendRel(obj) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frameRel(obj)); // guard mirrors transport.ts:178
    },
    onSnap(cb) {
      snapCbs.push(cb);
    },
    onRel(cb) {
      relCbs.push(cb);
    },
    onOpen(cb) {
      if (ws.readyState === WebSocket.OPEN) cb();
      else openCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
      if (closed) cb();
    },
    close() {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}
```

- [ ] **Step 3: Typecheck + lint + commit**

Run: `bun run typecheck && bun run lint` (PASS).

```bash
git add game/net/wsLink.ts game/net/signaling.ts
git commit -m "feat(net): PeerLink-shaped WebSocket adapter (createArenaLink) + arenaUrl dial"
```

---

## Task 9: Coexisting `doclient` mode wired into `main.ts` (method C untouched)

**Files:**
- Modify: `game/net/net.ts` (add `"doclient"` to `NetMode`), `game/main.ts` (dev entry + frame path)

**Interfaces:**
- The new `doclient` mode reuses the entire existing `client` render/predict/interp path (`Client.render`/`send`), only swapping the transport (`createArenaLink` instead of a WebRTC `PeerLink`). Reachable behind a dev entry (`?arena=CODE`) so **method C's `single`/`host`/`client` paths stay fully runnable** (bisection baseline).

- [ ] **Step 1: Add the mode**

In `game/net/net.ts`, change `export type NetMode = "single" | "host" | "client";` → `... | "client" | "doclient";`.

- [ ] **Step 2: Dev entry in `main.ts`**

At the end of `main()` (after the sprite load), add a dev-only arena entry that reads `?arena=CODE`, creates a `Client` over `createArenaLink(arenaUrl(code))`, and sets `Net.mode = "doclient"`:

```ts
  const arenaParam = new URLSearchParams(location.search).get("arena");
  if (arenaParam) {
    hide("start");
    const link = createArenaLink(arenaUrl(arenaParam));
    Net.mode = "doclient";
    Net.client = new Client(link);
  }
```

Add imports: `createArenaLink` from `./net/wsLink`, `arenaUrl` from `./net/signaling` (Client/Net already imported).

- [ ] **Step 3: Frame path — treat `doclient` exactly like `client`**

In `frame()`, change the client branch guard from `Net.mode === "client"` to `Net.mode === "client" || Net.mode === "doclient"`. The body is unchanged (predict/interp/send/sysFx/sysCamera/clientAmbience). For `doclient`, skip the reconnect watchdog for now (`coopRoomCode` is null) — add `&& Net.mode === "client"` to the watchdog guard so only method C reconnects (arena reconnect is Task 11+/2b).

- [ ] **Step 4: Typecheck + lint**

Run: `bun run typecheck && bun run lint` (PASS).

- [ ] **Step 5: Harness playtest (the Milestone-A deliverable)**

Terminal 1: `cd worker && bunx wrangler dev --port 8787`. Terminal 2: `bun run dev`. Open `http://localhost:5173/?arena=TEST&netlog`. Expected: the game appears on the first snapshot, showing a **held-night arena with a live horde**; your player predicts locally and the world interpolates; the `#netstat` HUD shows RTT/loss/etc. against the local DO. Move/aim/fire feel responsive. **Verify method C still works:** open `http://localhost:5173/` (no `?arena`), Host + Deploy a normal single/co-op session — unchanged.

- [ ] **Step 6: Commit — closes Milestone A**

```bash
git add game/net/net.ts game/main.ts
git commit -m "feat(net): coexisting doclient mode — play against the Arena DO alongside method C"
```

> **Milestone A is a clean, additive PR boundary.** Everything to here can merge to `main` with method C still the default: the DO path is opt-in via `?arena`. Consider merging here before Milestone B's cutover.

---

# MILESTONE B — Atomic cutover + method-C deletion

## Task 10: Client siege-transition derivation via the `prevPhase` edge

**Files:**
- Create: `sim/systems/siegeEdge.ts`, `sim/systems/siegeEdge.test.ts`
- Modify: `game/net/client.ts` (track `prevPhase`, derive cues on the edge)

**Interfaces:**
- Produces: `siegeEdgeCue(prev: SiegePhase | null, next: SiegePhase, day: number): FxEvent[]` — the transition cues to replay when the synced phase changes (`[]` when no edge). Reuses the existing `drainFxEvents` sink.

Replaces the wire one-shot the spec first imagined: with zero wire `fxEvents`, the client derives the NIGHT/DAY banner + wave-start/dawn stings from the snapshot's `phase` edge.

- [ ] **Step 1: Write the failing test**

```ts
// sim/systems/siegeEdge.test.ts
import { describe, expect, it } from "vitest";
import { siegeEdgeCue } from "./siegeEdge";

describe("siegeEdgeCue", () => {
  it("day→night yields NIGHT banner + waveStart sting", () => {
    expect(siegeEdgeCue("day", "night", 4)).toEqual([
      { t: "announce", label: "NIGHT", day: 4 },
      { t: "audio", cue: "waveStart" },
    ]);
  });
  it("night→day yields DAY banner + dawn sting", () => {
    expect(siegeEdgeCue("night", "day", 5)).toEqual([
      { t: "announce", label: "DAY", day: 5 },
      { t: "audio", cue: "dawn" },
    ]);
  });
  it("no edge (same phase, or first snapshot prev=null) yields nothing", () => {
    expect(siegeEdgeCue("night", "night", 4)).toEqual([]);
    expect(siegeEdgeCue(null, "night", 4)).toEqual([]); // drop-in mid-night: no banner
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun run test -- siegeEdge.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `sim/systems/siegeEdge.ts`**

```ts
// sim/systems/siegeEdge.ts
import type { FxEvent, SiegePhase } from "../types";

/**
 * Client-side derivation of the siege one-shots from the synced phase edge. The DO carries no
 * fxEvents (derive-first); the client tracks the last-seen phase and replays the banner + sting
 * when it flips. prev=null (first snapshot) yields nothing, so a drop-in mid-night shows no banner.
 */
export function siegeEdgeCue(prev: SiegePhase | null, next: SiegePhase, day: number): FxEvent[] {
  if (prev === null || prev === next) return [];
  if (next === "night") {
    return [
      { t: "announce", label: "NIGHT", day },
      { t: "audio", cue: "waveStart" },
    ];
  }
  return [
    { t: "announce", label: "DAY", day },
    { t: "audio", cue: "dawn" },
  ];
}
```

- [ ] **Step 4: Run to verify it passes** — `bun run test -- siegeEdge.test.ts` → PASS.

- [ ] **Step 5: Wire into `client.ts`**

Add a `private prevPhase: SiegePhase | null = null;` field. In the `onSnap` handler (`client.ts:143`), after `applySnapshot`/`effects` and before storing `this.prev`, derive + drain the edge cues:

```ts
    const cues = siegeEdgeCue(this.prevPhase, snap.phase, snap.day);
    this.prevPhase = snap.phase;
    if (cues.length) {
      const st = getState();
      for (const c of cues) st.fxEvents.push(c);
      drainFxEvents(st); // banner + sting via the existing sink
    }
```

Reset `this.prevPhase = null` in `resetNet()` (so a reconnect doesn't fire a stale banner). Add `import { siegeEdgeCue } from "../../sim/systems/siegeEdge";` (`drainFxEvents`, `getState` already imported).

- [ ] **Step 6: Gates + commit**

Run: `bun run typecheck && bun run test && bun run lint` and `bunx tsc --noEmit -p sim/tsconfig.json` (PASS).

```bash
git add sim/systems/siegeEdge.ts sim/systems/siegeEdge.test.ts game/net/client.ts
git commit -m "feat(net): derive siege banner/stings from the synced phase edge (zero-wire transitions)"
```

---

## Task 11: Retune reconcile constants + rate-limit client input

**Files:**
- Modify: `sim/config.ts` (reconcile constants), `game/main.ts` (input send throttle)

**Interfaces:**
- Consumes: `CONFIG.net.inputHz` (Task 4). Produces: retuned `interpDelayMs`/`smoothCorrect`/`snapTeleportThresh` starting values + a client send throttle. Exact values are feel-tuned at the gate; these are the documented starting points.

- [ ] **Step 1: Retune the constants**

In `sim/config.ts` `net:` block: `interpDelayMs: 150` (was 100), `smoothCorrect: 0.15` (was 0.2 — gentler for the jitterier hop), `snapTeleportThresh: 120` (was 80 — wider so larger corrections still ease). Add a comment that these are DO-hop starting points, feel-tuned at the gate.

- [ ] **Step 2: Throttle client input send**

In `main.ts`'s client/doclient branch, gate `Net.client?.send(inp)` behind an accumulator so it ships at `CONFIG.net.inputHz` (latest-wins), not every rAF. Add near the other frame accumulators:

```ts
  let sendAcc = 0;
  const inputStep = 1 / CONFIG.net.inputHz;
```

In the branch:

```ts
      sendAcc += dt;
      if (inp && sendAcc >= inputStep) {
        sendAcc = 0;
        Net.client?.send(inp);
      }
```

(The local prediction still runs every frame; only the *send* is throttled — latest-wins, per spec §d. Watch semi-auto fire feel at the gate.)

- [ ] **Step 3: Gates + feel spot-check**

Run: `bun run typecheck && bun run lint` (PASS). On the `?arena` harness, confirm movement/aim still feel responsive with the throttled send + wider interp.

- [ ] **Step 4: Commit**

```bash
git add sim/config.ts game/main.ts
git commit -m "tune(net): DO-hop reconcile starting points + ~25Hz latest-wins input send"
```

---

## Task 12: Atomic cutover — one path, delete method-C frame branches

**Files:**
- Modify: `game/main.ts` (collapse to one path), `game/game.ts` (delete `update()` wrapper), `game/net/net.ts` (mode)

**Interfaces:** after this task the browser has a **single client path** against the DO. `single`/`host` no longer exist. This is the one commit where the old paths stop running — it lands only because Tasks 6–9 proved the DO path.

- [ ] **Step 1: Make the arena the default entry**

Rework the title flow so Start (and/or the co-op entry) dials the arena: on Start, `Net.mode = "client"`, `Net.client = new Client(createArenaLink(arenaUrl(code)))`, where `code` is a room code entered by the player (reuse the existing room-code input; a single default arena code is fine for the gate). Remove the `startSingleRun`/`startHostRun` distinction — there is one "connect and play." Keep the audio-load gate (`Audio.whenSamplesReady()`) before connecting.

- [ ] **Step 2: Delete the `single` and `host` frame paths + the worker ticker**

In `main.ts`: delete the `startTicker(...)` host loop block (`:388–433`) entirely, and in `frame()` delete the `Net.mode === "single"` branch (`:446–459`) and the "host: rendering only" comment/branch. Keep only the client path (now handling `Net.mode === "client"`). Remove now-dead imports (`update`, `audioAmbience`, `sampleLocalInput`'s host use, `startTicker`, `Host`, `emptyInput`'s host use — let `tsc` guide you).

- [ ] **Step 3: Delete `game.ts`'s `update()` wrapper**

`update()` in `game.ts` is no longer called by the browser (only the DO runs `stepSim`). Delete `export function update(...)` from `game.ts` and its now-dead imports (`stepSim`, `sysFx`, `sysCamera` if unused elsewhere — `tsc` will flag). Keep `stepSim` in `sim/` (the DO uses it).

- [ ] **Step 4: Gates + build**

Run: `bun run typecheck && bun run test && bun run lint && bun run build` (all PASS). `bunx tsc --noEmit -p sim/tsconfig.json` + `bunx tsc --noEmit -p worker/tsconfig.json` (PASS).

- [ ] **Step 5: Harness playtest**

`wrangler dev` + `bun run dev`; connect via the title → arena. Full held-night play: movement, fire/melee, kills, hits, hurt, banner-on-first-transition behavior (none on drop-in mid-night), dread ambience. Single-player no longer exists — that's expected.

- [ ] **Step 6: Commit**

```bash
git add game/main.ts game/game.ts game/net/net.ts
git commit -m "feat(net): atomic cutover — single DO client path; delete single/host frame paths + update()"
```

---

## Task 13: Delete method-C dead code

**Files:**
- Delete: `game/net/host.ts`, `game/net/transport.ts`, `game/net/ticker.ts`
- Modify: `game/net/net.ts` (drop `"host"`/`"single"` from `NetMode`, drop `host` field), `game/net/client.ts` (drop the WebRTC `PeerLink` import if it pointed at `transport.ts` — repoint to a local type or `wsLink`), `game/main.ts` + `game/net/signaling.ts` (remove host-lobby / SDP / quick-match-becomes-host wiring), `worker/room.ts` (remove the `/room/:CODE` SDP-relay route + the `Room` DO if fully unused), `worker/wrangler.toml` (drop the `Room` binding/migration only if `Room` is deleted)

**Interfaces:** pure deletion of the now-unreachable WebRTC listen-server path. No behavior change (the code is dead after Task 12).

- [ ] **Step 1: Delete the transport + host + ticker modules**

```bash
git rm game/net/host.ts game/net/transport.ts game/net/ticker.ts
```

- [ ] **Step 2: Repoint the `PeerLink` type**

`client.ts` and `wsLink.ts` import `PeerLink` from `./transport`. Move the `PeerLink` interface (7 methods) into `game/net/wsLink.ts` (or a small `game/net/link.ts`) and repoint both imports. `PeerLink` is the transport contract, now WebSocket-only.

- [ ] **Step 3: Prune `net.ts`, signaling, and main.ts**

`NetMode` becomes just `"client"` (or drop the type if trivial). Remove `Net.host`. In `signaling.ts` remove `roomUrl(..., "host")` / host + SDP-relay helpers, keeping only `arenaUrl` (and any client join used by the arena flow). In `main.ts` remove the host-lobby UI wiring (`openHostLobby`, public/private toggle, quick-match-becomes-host, registry meta heartbeat, the reconnect ladder if it targeted method C). Let `tsc` + `knip` drive the dead-code removal. **Do not** remove the arena reconnect if you added one; if not, note reconnect is 2b.

- [ ] **Step 4: Prune the worker SDP relay**

If the `Room`/`Registry` signaling DOs are now fully unused (the game no longer dials `/room/:CODE`), remove the `/room/` route + the `Room` class + its binding/migration. If the public-room registry is still wanted for arena discovery later, leave `Registry` and note it; otherwise remove it too. Keep the `[assets]` game-serving block and `/turn` (TURN is WebRTC-only and now dead — remove `/turn` + its budget code as well if nothing uses it). Be conservative: delete only what `tsc`/grep proves unreachable; note anything deferred.

- [ ] **Step 5: Full gates + build + knip**

Run: `bun run typecheck && bun run test && bun run lint && bun run build` (PASS). `bunx tsc --noEmit -p worker/tsconfig.json` (PASS). Run `bunx knip` and confirm no new dead-code regressions beyond the known data-table exports.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(net): delete method-C listen server (host/WebRTC transport/ticker/SDP relay)"
```

---

## Task 14: Feel gate

**Files:**
- Modify: `docs/superpowers/notes/2026-07-12-method-c-netstats-baseline.md` (append the DO-path comparison), or a sibling `-do-gate-result.md`

**Interfaces:** none (playtest + metrics; the acceptance gate for 2a).

- [ ] **Step 1: Local harness feel + metrics**

`wrangler dev` + `bun run dev`; play the held-night arena solo with `?netlog`. Read the `#netstat` HUD and the DO's `[arena] effective … Hz · snap … B` console logs. Confirm the DO holds ~60 Hz and snapshot size is reasonable (well under 16 KB). Record feel vs. the Task 1 baseline.

- [ ] **Step 2: Edge placement + real latency**

Deploy via the GitHub Actions worker-deploy workflow (never local `wrangler deploy` — per CLAUDE.md). With `locationHint` set for your region (`apac-ne` for Japan), connect from a browser (and, if available, a second device/friend) over the internet. Compare RTT/freeze/feel to the baseline, accounting for the RTT-metric-semantics caveat (spec Open Questions). Push the effective-tick-rate under whatever player count you can muster.

- [ ] **Step 3: Record the result honestly**

Write the comparison: measured DO-path `netStats` + effective Hz + snapshot size, at the counts reached, vs. the method-C baseline, with a qualitative feel verdict (movement/fire/hit-timing/gore over the hop). State plainly whether the gate passes, and if any Open Question fired (30 Hz fallback? directional-gore regression felt? semi-auto input drop? RTT budget?). This is the go/no-go for the umbrella §Contingency ladder.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/notes/
git commit -m "docs(net): DO-path feel-gate result vs method-C baseline"
```

---

## Self-Review

**1. Spec coverage:**
- (a) DO lifecycle (pickSlot 0-based, nonce-rejoin, grace, no-host, drop-in, empty-stop, standard WS) → Tasks 2, 6, 7. ✓
- (b) headless `stepSim` (exclude sysFx/sysCamera, decouple openShop/gameOver, held-night invariant) → Tasks 4, 5. ✓
- (c) derive-first, zero wire fxEvents, phase-edge transitions, local-muzzle predicted → Tasks 6 (DO clears fxEvents), 10; `effects()` unchanged (kept). ✓
- (d) single-WS transport + 1-byte tag, PeerLink adapter, input rate-limit, reconcile retune, main.ts collapse, method-C deletion, wrangler-dev harness, baseline capture → Tasks 1, 3, 8, 9, 11, 12, 13. ✓
- Feel gate (real browsers + permanent tick-rate/snapshot metrics) → Tasks 6 (metrics), 14. ✓
- Bisection-safe sequencing (coexist through A, atomic cutover in B) → Milestone split + Task 9/12. ✓
- Two porting constraints (await-free slot commit, drop-in-only) → Task 7 Step 2. ✓
- **Out of scope (correctly):** per-player shop, day/night cycle, death/respawn, arenaReset wire events, matchmaking pool, synthetic load-driver → 2b / sub-project 3. ✓

**2. Placeholder scan:** No "TBD"/"handle appropriately". Non-TDD tasks (DO/transport/cutover) show concrete code and exact `wrangler dev`/gate verification. Task 13's conservative-deletion guidance is explicit ("delete only what tsc/grep proves unreachable; note anything deferred") rather than hand-waving.

**3. Type consistency:** `pickSlot(decidedPids, max)` (Task 2) used with `CONFIG.net.maxPlayers` (Tasks 4, 7). `stepSim` return union `"night"|"dawn"|"wipe"|null` (Task 5) consumed identically by the DO (Task 6/7) and the `game.ts` wrapper (Task 5). `NET_TAG`/`frameSnap`/`frameRel`/`unframe` (Task 3) used by both the DO (Task 6) and `wsLink` (Task 8). `PeerLink` shape stable (Task 8 → repointed Task 13). `siegeEdgeCue(prev,next,day)` (Task 10) matches the `FxEvent` `announce`/`audio` variants from Phase 1. `heldNight` field (Task 4) read in `stepSim`/`sysSiege` and set by the DO (Task 6).

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-12-do-server-phase2-authority-relocation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, two-stage review between tasks, fast iteration. Natural checkpoint: pause after Task 9 (Milestone A) to merge the additive PR before the cutover.

**2. Inline Execution** — batch execution in this session with checkpoints.

**Which approach?** (Per your flow: the plan first goes to a rubber-duck blind-spot review, then we execute.)
