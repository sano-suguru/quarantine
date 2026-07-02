# Co-op Session Teardown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give co-op a single, authoritative teardown path so that every way of leaving a session (lobby Back, game-over restart, tab close, failed/aborted join) closes its WebRTC links and resets all session state — eliminating ghost peers, stuck "waiting" clients, and stale-mode single-player runs.

**Architecture:** Three layers. (0) A tiny module-scope **session epoch** counter (`game/net/session.ts`) that every async co-op flow captures and re-checks after each `await`/timer/callback, so a teardown that happens mid-flight cancels the flow's write-back instead of resurrecting a dead session. (1) **`dispose()` primitives** on `Host`/`Client` that close links and clear timers idempotently. (2) A single module-level **`endCoop()`** in `main.ts` that bumps the epoch, disposes host/client, closes the signaling handle, clears timers, and resets every session variable to the single-player baseline — plus two *non-terminal* transition helpers (`abandonClientAttempt`, `beginPublicHostFromQuickMatch`) for the "attempt failed, stay in the flow" paths that must NOT do a full teardown.

**Tech Stack:** TypeScript (strict + `noUncheckedIndexedAccess`), Bun (package manager + test runner via Vitest), WebRTC DataChannels, Biome (lint/format). No new dependencies.

## Global Constraints

- **Toolchain:** Bun only. Type-check `bun run typecheck`; tests `bun run test`; lint `bun run lint`; a single test file `bun run test -- game/net/session.test.ts`.
- **TypeScript:** strict, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `verbatimModuleSyntax`, `isolatedModules`. Use `import type` for type-only imports. No `as any` / no casts that bypass these.
- **Biome:** 2-space indent, double quotes, semicolons, trailing commas, 100-col width, import types required. Run `bun run lint:fix` before committing if formatting drifts.
- **Single-player is sacred:** single-player behaviour must stay byte-for-byte unchanged. `game/game.ts`'s `startGame()` is NOT edited — it is only *wrapped*. The three runtime paths (single rAF `update()`, host worker-tick `update()`+broadcast, client interpolate-only) must be preserved.
- **Systems stay net-agnostic:** no net imports leak into `game/systems/`. This work touches only `game/net/*` and `game/main.ts`.
- **Testing scope (repo convention):** only pure/deterministic code is unit-tested. `game/net/session.ts`, `Host.dispose`, `Client.dispose` ARE unit-tested. `game/main.ts` is DOM/lifecycle wiring — excluded from coverage; its tasks end in `typecheck` + a scripted **2-tab manual playtest**, never a unit-test claim.
- **Commit trailer:** every commit ends with `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- **Protocol version stays 13.** An explicit `leave`/`hostleft` wire message is DEFERRED (YAGNI): `pagehide` + `pc.close()` + the epoch guard already fix all four leaks without a `PROTOCOL_VERSION` bump (which would risk gating mismatched peers). Do NOT add a leave message in this plan.
- **Design source of truth:** `docs/superpowers/specs/2026-07-02-coop-session-teardown-design.md`.

---

## File Structure

- **Create** `game/net/session.ts` — the epoch primitive (`bumpCoopEpoch`, `coopEpoch`, `isCoopEpochCurrent`). Single responsibility: session-liveness token.
- **Create** `game/net/session.test.ts` — epoch unit tests.
- **Create** `game/net/client.test.ts` — `Client.dispose()` unit test (no client test file exists yet).
- **Modify** `game/net/client.ts` — add `dispose()` + `disposed` guard.
- **Modify** `game/net/host.ts` — add `dispose()`, an `add()` disposed-guard, and `disposed` flag.
- **Modify** `game/net/host.test.ts` — add `Host.dispose()` tests (reuses the existing `FakePeerLink`).
- **Modify** `game/main.ts` — lift session vars to module scope; add `endCoop()`, `startSingleRun()`, `startHostRun()`, `becomeClient()`, `abandonClientAttempt()`, `beginPublicHostFromQuickMatch()`; wire every exit path; add a `pagehide` handler.

---

### Task 1: Session epoch module

**Files:**
- Create: `game/net/session.ts`
- Test: `game/net/session.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `bumpCoopEpoch(): void` — invalidates every previously-captured epoch (call once per teardown).
  - `coopEpoch(): number` — the current epoch token; capture at the start of any async co-op flow.
  - `isCoopEpochCurrent(epoch: number): boolean` — `true` iff `epoch` is still the live session.

- [ ] **Step 1: Write the failing test**

Create `game/net/session.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { bumpCoopEpoch, coopEpoch, isCoopEpochCurrent } from "./session";

// Each test starts from whatever the module's counter is; we only assert relative behaviour,
// so no reset hook is needed (the counter is monotonic and never read as an absolute value).
describe("coop session epoch", () => {
  let base: number;
  beforeEach(() => {
    base = coopEpoch();
  });

  it("reports a freshly captured epoch as current", () => {
    const e = coopEpoch();
    expect(isCoopEpochCurrent(e)).toBe(true);
  });

  it("invalidates a captured epoch after a bump", () => {
    const e = coopEpoch();
    bumpCoopEpoch();
    expect(isCoopEpochCurrent(e)).toBe(false);
  });

  it("treats the post-bump epoch as the new current one", () => {
    bumpCoopEpoch();
    const e = coopEpoch();
    expect(isCoopEpochCurrent(e)).toBe(true);
  });

  it("advances monotonically on each bump", () => {
    bumpCoopEpoch();
    const first = coopEpoch();
    bumpCoopEpoch();
    const second = coopEpoch();
    expect(second).toBeGreaterThan(first);
    expect(second).toBeGreaterThan(base);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- game/net/session.test.ts`
Expected: FAIL — cannot resolve `./session` (module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `game/net/session.ts`:

```ts
/**
 * Co-op session epoch — a single liveness token shared by every async lobby/join flow.
 *
 * Method C teardown is racy: joinRoom / quickMatch / reconnect all `await` the network, then write
 * back into the `Net` singleton (become client, arm the reconnect watchdog, …). If the player
 * leaves DURING that await, the write-back would resurrect a session that endCoop() just tore down
 * (ghost peer, stuck "connecting", stale mode). Every such flow captures `coopEpoch()` up front and
 * re-checks `isCoopEpochCurrent()` after each await/timer/callback; endCoop() calls `bumpCoopEpoch()`
 * so all in-flight flows see themselves as stale and bail (closing any link they obtained).
 */
let epoch = 0;

/** Invalidate every previously-captured epoch. Call exactly once per session teardown. */
export function bumpCoopEpoch(): void {
  epoch++;
}

/** The current session token. Capture this at the start of any async co-op flow. */
export function coopEpoch(): number {
  return epoch;
}

/** True iff `captured` is still the live session (i.e. no teardown happened since it was captured). */
export function isCoopEpochCurrent(captured: number): boolean {
  return captured === epoch;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test -- game/net/session.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add game/net/session.ts game/net/session.test.ts
git commit -m "feat(net): add co-op session epoch primitive

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: `Client.dispose()`

**Files:**
- Modify: `game/net/client.ts` (add `disposed` field near the other private state at ~72; add `dispose()` method next to `suspend()` at ~170)
- Test: `game/net/client.test.ts` (new)

**Interfaces:**
- Consumes: `PeerLink` (`game/net/transport.ts`).
- Produces: `Client.prototype.dispose(): void` — closes the current link, marks the client dead (`live = false`), idempotent.

- [ ] **Step 1: Write the failing test**

Create `game/net/client.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Client } from "./client";
import type { PeerLink } from "./transport";

/** Minimal PeerLink double: records close() calls; the wire()/handlers are inert no-ops. */
class FakeLink implements PeerLink {
  closeCalls = 0;
  sendSnap(): void {}
  sendRel(): void {}
  onSnap(): void {}
  onRel(): void {}
  onOpen(): void {}
  onClose(): void {}
  close(): void {
    this.closeCalls++;
  }
}

describe("Client.dispose", () => {
  it("closes the underlying link", () => {
    const link = new FakeLink();
    const client = new Client(link);
    client.dispose();
    expect(link.closeCalls).toBe(1);
  });

  it("is idempotent — a second dispose does not re-close the link", () => {
    const link = new FakeLink();
    const client = new Client(link);
    client.dispose();
    client.dispose();
    expect(link.closeCalls).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- game/net/client.test.ts`
Expected: FAIL — `client.dispose is not a function`.

- [ ] **Step 3: Add the `disposed` field**

In `game/net/client.ts`, find the reconnect-state block (around line 72):

```ts
  private live = true;
  private lastSnapAt = 0;
  private lastRelAt = 0;
```

Change it to:

```ts
  private live = true;
  private disposed = false;
  private lastSnapAt = 0;
  private lastRelAt = 0;
```

- [ ] **Step 4: Add the `dispose()` method**

In `game/net/client.ts`, find `suspend()` (around line 170):

```ts
  suspend(): void {
```

Insert this method immediately before it:

```ts
  /**
   * Terminal teardown: close the current link and mark the client dead. Idempotent — safe to call
   * from endCoop() regardless of whether we ever opened. Unlike suspend() (reconnect: keeps the
   * instance alive to rebind), dispose() ends this Client for good.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.live = false;
    this.link.close();
  }

```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test -- game/net/client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add game/net/client.ts game/net/client.test.ts
git commit -m "feat(net): add Client.dispose() terminal teardown

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: `Host.dispose()` + `add()` disposed-guard

**Files:**
- Modify: `game/net/host.ts` (add `disposed` field ~72; guard in `add()` ~76; add `dispose()` method)
- Test: `game/net/host.test.ts` (append a `describe("Host.dispose", …)` block; reuses `FakePeerLink`)

**Interfaces:**
- Consumes: existing `Host` internals (`this.peers`, `this.links`, `HostPeer.claimTimer`, `connectedPids()`), `FakePeerLink` from `host.test.ts`.
- Produces:
  - `Host.prototype.dispose(): void` — clears all `claimTimer`s, closes every link, empties `peers`/`links`, sets `started = false`; idempotent; re-entrancy-safe (a link's `onClose` firing during close sees empty `peers` and no-ops).
  - `Host.prototype.add(link)` now closes+ignores the link when disposed.

- [ ] **Step 1: Write the failing test**

Append to `game/net/host.test.ts` (after the existing `describe` blocks; `FakePeerLink` is already defined at the top of the file):

```ts
describe("Host.dispose", () => {
  it("closes every connected link and clears the roster", () => {
    resetState("day");
    const host = new Host();
    const a = new FakePeerLink();
    const b = new FakePeerLink();
    host.add(a);
    host.add(b);
    a.fireOpen();
    b.fireOpen();
    let aClosed = 0;
    let bClosed = 0;
    a.onClose(() => aClosed++);
    b.onClose(() => bClosed++);

    host.dispose();

    expect(aClosed).toBe(1);
    expect(bClosed).toBe(1);
    expect(host.connectedPids()).toEqual([]);
  });

  it("is idempotent — a second dispose is a no-op", () => {
    resetState("day");
    const host = new Host();
    const a = new FakePeerLink();
    host.add(a);
    a.fireOpen();
    let closes = 0;
    a.onClose(() => closes++);

    host.dispose();
    host.dispose();

    expect(closes).toBe(1);
  });

  it("rejects and closes links added after dispose", () => {
    resetState("day");
    const host = new Host();
    host.dispose();
    const late = new FakePeerLink();
    let closed = 0;
    late.onClose(() => closed++);

    host.add(late);

    expect(closed).toBe(1);
    expect(host.connectedPids()).toEqual([]);
  });
});
```

Note: `resetState`, `Host`, and `FakePeerLink` are already imported/defined in `host.test.ts`. If `describe`/`it`/`expect` are not yet imported at the top of the file, they are (the existing tests use them) — do not re-import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test -- game/net/host.test.ts`
Expected: FAIL — `host.dispose is not a function`.

- [ ] **Step 3: Add the `disposed` field**

In `game/net/host.ts`, find the class field block (around line 71):

```ts
export class Host {
  readonly links: PeerLink[] = [];
  private peers: HostPeer[] = [];
  private started = false;
```

Change it to:

```ts
export class Host {
  readonly links: PeerLink[] = [];
  private peers: HostPeer[] = [];
  private started = false;
  private disposed = false;
```

- [ ] **Step 4: Guard `add()` when disposed**

In `game/net/host.ts`, find the start of `add()` (around line 76):

```ts
  add(link: PeerLink): void {
    const peer: HostPeer = {
```

Insert the guard as the first statement:

```ts
  add(link: PeerLink): void {
    if (this.disposed) {
      link.close(); // a stale createHostLink()/signaling callback landed after teardown — refuse it
      return;
    }
    const peer: HostPeer = {
```

- [ ] **Step 5: Add the `dispose()` method**

In `game/net/host.ts`, add this method to the `Host` class (place it right after `add()` closes, before the private helpers). The ordering is deliberate: mark disposed, clear timers, then EMPTY `peers`/`links` BEFORE closing links, so the real `link.onClose` handler (which early-returns on `!this.peers.includes(peer)`) becomes a no-op during re-entrant close.

```ts
  /**
   * Terminal teardown: drop every peer and close every link. Idempotent and re-entrancy-safe —
   * peers/links are cleared BEFORE close() so the onClose handler (guarded by peers.includes) is a
   * no-op when the real link fires it synchronously. Also cancels any pending rejoin claim timers.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const peer of this.peers) {
      if (peer.claimTimer) clearTimeout(peer.claimTimer);
      peer.claimTimer = null;
    }
    const links = [...this.links];
    this.peers = [];
    this.links.length = 0;
    this.started = false;
    for (const link of links) link.close();
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `bun run test -- game/net/host.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 7: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add game/net/host.ts game/net/host.test.ts
git commit -m "feat(net): add Host.dispose() + reject post-dispose add()

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Consolidate co-op session state to module scope

**Files:**
- Modify: `game/main.ts` (module-var block ~52-74; `wireCoop` closure vars ~446-449; every `hostHandle`/`coopPollTimer`/`pendingClientManualState` reference)

**Interfaces:**
- Consumes: nothing new.
- Produces: module-scope `coopPollTimer: number`, `pendingClientManualState: ManualLobbyDisplayState | null`, and a single `coopHostHandle` (the closure-local `hostHandle` is removed and its references retargeted to `coopHostHandle`). This is a **pure refactor — no behaviour change** — so `endCoop()` (Task 5) can reach these from module scope.

**Why:** the reported bug class is *split ownership* — session state lives in three scopes (`Net` singleton, `main.ts` module vars, `wireCoop` closure vars), so no single function can reset it. Lifting the closure vars up is the structural precondition for a single `endCoop()`.

- [ ] **Step 1: Remove the duplicate `hostHandle` closure var**

In `game/main.ts`, find the `wireCoop` closure vars (around line 446):

```ts
  let hostHandle: HostRoom | null = null;
  let coopPollTimer = 0; // OPEN RAIDS poll interval id (0 = not polling)
```

Change to (delete `hostHandle`; `coopPollTimer` moves to module scope in Step 2 so remove it here too):

```ts
```

(i.e. remove both lines — `hostHandle` is replaced by the existing module `coopHostHandle`, and `coopPollTimer` becomes a module var.)

- [ ] **Step 2: Lift `coopPollTimer` and `pendingClientManualState` to module scope**

In `game/main.ts`, find the module var block (around line 73):

```ts
// public-room registry (D): the active host's signaling handle + whether it's listed publicly.
// Read by the Worker-clock tick to push registry meta (so a backgrounded public host isn't pruned).
let coopHostHandle: HostRoom | null = null;
let coopPublic = false;
```

Change to:

```ts
// public-room registry (D): the active host's signaling handle + whether it's listed publicly.
// Read by the Worker-clock tick to push registry meta (so a backgrounded public host isn't pruned).
let coopHostHandle: HostRoom | null = null;
let coopPublic = false;
// OPEN RAIDS poll interval id (0 = not polling). Module scope so endCoop() can stop it.
let coopPollTimer = 0;
// Manual-SDP client fallback UI state buffered until <details> opens. Module scope for endCoop() reset.
let pendingClientManualState: ManualLobbyDisplayState | null = null;
```

- [ ] **Step 3: Remove the old `pendingClientManualState` closure var**

In `game/main.ts`, find (around line 449):

```ts
    let pendingClientManualState: ManualLobbyDisplayState | null = null;
```

Delete this line (it is now the module var from Step 2).

- [ ] **Step 4: Retarget `hostHandle` references to `coopHostHandle`**

In `game/main.ts`, in the host-open flow (around lines 642-652), find:

```ts
    hostHandle = hostRoom(
      code,
      (link) => host.add(link),
      (s) => {
        refreshSquad();
        if (s.error) setStatus(`signaling: ${s.error} — use manual connect below`);
      },
    );
    coopHostHandle = hostHandle; // the host tick pushes registry meta through this
    // seed the listing now; buffered in hostRoom and flushed the instant the signaling WS opens
    hostHandle.setMeta({
```

Change to:

```ts
    coopHostHandle = hostRoom(
      code,
      (link) => host.add(link),
      (s) => {
        refreshSquad();
        if (s.error) setStatus(`signaling: ${s.error} — use manual connect below`);
      },
    );
    // seed the listing now; buffered in hostRoom and flushed the instant the signaling WS opens
    coopHostHandle.setMeta({
```

- [ ] **Step 5: Retarget the `closeLobby` `hostHandle` references**

In `game/main.ts`, find `closeLobby` (around line 568):

```ts
  const closeLobby = (): void => {
    hostHandle?.close(); // closes the signaling socket → Room DO unlists a public room
    hostHandle = null;
    coopHostHandle = null;
```

Change to:

```ts
  const closeLobby = (): void => {
    coopHostHandle?.close(); // closes the signaling socket → Room DO unlists a public room
    coopHostHandle = null;
```

(Task 5 replaces `closeLobby`'s body entirely, but make it compile now.)

- [ ] **Step 6: Type-check (catches any missed reference)**

Run: `bun run typecheck`
Expected: no errors. If `hostHandle` is reported as undefined anywhere, retarget that reference to `coopHostHandle`. If `coopPollTimer`/`pendingClientManualState` are reported unused, that's expected to resolve once used — but they are already referenced (poll setInterval, manual `<details>` toggle), so there should be no unused-var error.

- [ ] **Step 7: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add game/main.ts
git commit -m "refactor(main): lift co-op session vars to module scope

No behaviour change — consolidates hostHandle/coopPollTimer/pendingClientManualState
into module scope so a single endCoop() can reset them.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: `endCoop()` + run wrappers + terminal exit wiring

**Files:**
- Modify: `game/main.ts` (add module-level `endCoop`, `startSingleRun`, `startHostRun`; rewrite `closeLobby`; rewrite `startBtn`/`restartBtn`; rewrite the `deploy` handler; rewrite the `reconnectClient` give-up tail)

**Interfaces:**
- Consumes: `bumpCoopEpoch` (Task 1), `Host.dispose`/`Client.dispose` (Tasks 2-3), module vars from Task 4, `Net` (`game/net/net.ts`), `el`/`hide`/`show` (`game/ui.ts`), `startGame`/`toTitle` (`game/game.ts`), `Host` (`game/net/host.ts`).
- Produces:
  - `endCoop(): void` — the single terminal teardown. Bumps the epoch, disposes host+client, closes the signaling handle, clears the poll timer + reconnect overlay, resets ALL session vars to the single-player baseline. Idempotent.
  - `startSingleRun(): void` — `endCoop()` then `startGame()`. Used by the solo Start button.
  - `startHostRun(host: Host): void` — `startGame()`, `host.start()`, `hostStarted = true`. Used by the host Deploy button.

- [ ] **Step 1: Import the epoch helper**

In `game/main.ts`, find the net imports (around line 38-46) and add a `session` import next to the other `./net/*` imports:

```ts
import { Client } from "./net/client";
import { Host } from "./net/host";
```

Add immediately after the `Host` import:

```ts
import { bumpCoopEpoch } from "./net/session";
```

- [ ] **Step 2: Add `endCoop()` at module scope**

In `game/main.ts`, add this function at module scope, immediately BEFORE `function main()` (around line 137, next to `reconnectClient`):

```ts
/**
 * The single terminal teardown for a co-op session. Every way of leaving co-op for good — lobby
 * Back, game-over restart, tab close, reconnect give-up, or starting a solo run — routes here.
 * Bumps the session epoch first so any in-flight join/quickMatch/reconnect sees itself as stale and
 * bails (closing whatever link it obtained). Then disposes host/client links, closes the signaling
 * handle, stops timers, and resets every session var to the single-player baseline. Idempotent.
 */
function endCoop(): void {
  bumpCoopEpoch();
  Net.host?.dispose();
  Net.client?.dispose();
  coopHostHandle?.close();
  coopHostHandle = null;
  coopPublic = false;
  if (coopPollTimer) {
    clearInterval(coopPollTimer);
    coopPollTimer = 0;
  }
  reconnecting = false;
  el("reconnect").classList.remove("show");
  Net.mode = "single";
  Net.host = null;
  Net.client = null;
  hostStarted = false;
  coopRoomCode = null;
  pendingClientManualState = null;
}

/** Solo Start: tear down any lingering co-op session, then build the single-player world. */
function startSingleRun(): void {
  endCoop();
  startGame();
}

/** Host Deploy: build the world and start the authoritative sim/broadcast for connected peers. */
function startHostRun(host: Host): void {
  startGame(); // builds the fresh world + shows the HUD (hides the lobby)
  host.start(); // spawn a player for everyone already connected
  hostStarted = true; // frame loop now sims + broadcasts
}
```

- [ ] **Step 3: Route the solo Start button through `startSingleRun`**

In `game/main.ts`, find the Start button (around line 142):

```ts
  el("startBtn").onclick = () => {
    coopRoomCode = null; // solo: no room to reconnect to (don't arm the client watchdog)
    startGame();
  };
  el("restartBtn").onclick = toTitle;
```

Change to:

```ts
  el("startBtn").onclick = startSingleRun;
  el("restartBtn").onclick = () => {
    endCoop(); // game-over → title must fully drop any co-op mode/links (was leaking a ghost peer)
    toTitle();
  };
```

- [ ] **Step 4: Rewrite `closeLobby` to delegate to `endCoop`**

In `game/main.ts`, find `closeLobby` (around line 568, as left by Task 4):

```ts
  const closeLobby = (): void => {
    coopHostHandle?.close(); // closes the signaling socket → Room DO unlists a public room
    coopHostHandle = null;
    coopPublic = false;
    Net.mode = "single";
    Net.host = null;
    Net.client = null;
    hostStarted = false;
    coopRoomCode = null; // disarm the reconnect watchdog
    hide("lobby");
    openCoopHub(); // back to the hub (you entered the lobby from there)
  };
```

Change to:

```ts
  const closeLobby = (): void => {
    endCoop(); // disposes host/client links (host: no ghost peer; client: host sees us drop) + resets
    hide("lobby");
    openCoopHub(); // back to the hub (you entered the lobby from there)
  };
```

- [ ] **Step 5: Route the host Deploy button through `startHostRun`**

In `game/main.ts`, find the deploy handler (around line 631):

```ts
    deploy.onclick = () => {
      startGame(); // builds the fresh world + shows the HUD (hides this lobby)
      host.start(); // spawn a player for everyone already connected
      hostStarted = true; // frame loop now sims + broadcasts
    };
```

Change to:

```ts
    deploy.onclick = () => startHostRun(host);
```

- [ ] **Step 6: Replace the `reconnectClient` give-up tail with `endCoop`**

In `game/main.ts`, find the give-up tail of `reconnectClient` (around line 126):

```ts
  // gave up: end the client session and return to title (method C: no host = no session)
  overlay.classList.remove("show");
  reconnecting = false;
  coopRoomCode = null;
  Net.mode = "single";
  Net.host = null;
  Net.client = null;
  hostStarted = false;
  toTitle();
}
```

Change to:

```ts
  // gave up: end the client session and return to title (method C: no host = no session)
  endCoop(); // closes the suspended link, clears the overlay, resets Net + session vars
  toTitle();
}
```

- [ ] **Step 7: Type-check**

Run: `bun run typecheck`
Expected: no errors. (`endCoop`/`startSingleRun`/`startHostRun` are now all referenced, so no unused-locals.)

- [ ] **Step 8: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 9: Manual playtest — 2 tabs (fixes leaks ①②③)**

Start dev: `bun run dev:coop` (one-time: `cd worker && bun install`). Open two browser tabs at the dev URL.

Verify each scenario, then confirm the fix:

1. **Leak ② (host Back):** Tab A → Co-op → Host co-op (note the room code). Tab B → Co-op → Join by code → enter code → connect (Tab A shows squad P2). Tab A → **Back**. Expected: Tab B's lobby shows a disconnect/"host left" state (NOT stuck on "connected — waiting"); Tab A returns to the hub.
2. **Leak ① (client Back):** Re-host on Tab A. Tab B joins. Tab B → **Back**. Expected: Tab A's squad drops back to just the host (NO ghost "P2" lingering). This is the originally-reported bug.
3. **Leak ③ (game-over restart):** Tab A hosts, Tab B joins, Tab A → Deploy → play → die (or both die) → Game Over → **restart** (returns to title). Then Tab A → **Start** (solo). Expected: the solo game runs normally — the world updates and is NOT frozen, and no "public raid" reappears in Tab B's Open Raids list. (Before the fix, the solo run stayed in stale client/host `Net.mode`.)
4. **Single-player regression:** With no co-op ever started, Tab A → Start → play. Expected: byte-for-byte normal single-player.

Record PASS/FAIL for each. Do NOT proceed to Task 6 until 1-4 pass.

- [ ] **Step 10: Commit**

```bash
git add game/main.ts
git commit -m "fix(coop): unify terminal teardown via endCoop()

Lobby Back, game-over restart, and reconnect give-up now all dispose host/client
links and reset session state, fixing ghost peers and stale-mode solo runs.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Epoch-guard the room-code join flow + write-back choke point

**Files:**
- Modify: `game/main.ts` (add `becomeClient`, `abandonClientAttempt`, `beginPublicHostFromQuickMatch` helpers inside `wireCoop`; guard the `join` flow ~765-857)

**Interfaces:**
- Consumes: `coopEpoch`/`isCoopEpochCurrent` (Task 1), `Client`, `PeerLink`, `openHostLobby` (closure), `setClientLobby` (closure), the module session vars.
- Produces (all inside `wireCoop`):
  - `becomeClient(epoch, link, code, hooks?): Client | null` — the single guarded "become a client" write-back. If the epoch is stale it closes `link` and returns `null`; otherwise sets `Net.mode = "client"`, arms `coopRoomCode`, constructs+stores the `Client`, and returns it.
  - `abandonClientAttempt(epoch): void` — NON-terminal: a client attempt failed but we stay in the flow; dispose the client link and reset transient client state (leave the lobby UI up so the player can retry).
  - `beginPublicHostFromQuickMatch(epoch): void` — NON-terminal transition: drop any in-flight client attempt, then become a public host (`openHostLobby(true)`).

- [ ] **Step 1: Add the guarded helpers inside `wireCoop`**

In `game/main.ts`, add these three helpers inside `wireCoop`, immediately after `openHostLobby` is defined (so `beginPublicHostFromQuickMatch` can call it) — around line 590. Add `coopEpoch`/`isCoopEpochCurrent` to the `./net/session` import from Task 5:

Update the import (from Task 5's single-name import):

```ts
import { bumpCoopEpoch } from "./net/session";
```

to:

```ts
import { bumpCoopEpoch, coopEpoch, isCoopEpochCurrent } from "./net/session";
```

Then add the helpers (place after `openHostLobby`'s definition closes):

```ts
  // The single guarded "become a client" write-back. Every join path (room-code, quick match,
  // manual SDP) routes here so a teardown mid-await can't resurrect a dead session: if the captured
  // epoch is stale, close the freshly-obtained link and bail instead of wiring it into Net.
  const becomeClient = (
    epoch: number,
    link: PeerLink,
    code: string | null,
    hooks?: ConstructorParameters<typeof Client>[2],
  ): Client | null => {
    if (!isCoopEpochCurrent(epoch)) {
      link.close(); // user left during the join await — drop the link so the host sees no ghost
      return null;
    }
    Net.mode = "client";
    coopRoomCode = code; // arm the reconnect watchdog (null for manual SDP: no room to rejoin)
    const client = new Client(link, undefined, hooks);
    Net.client = client;
    return client;
  };

  // NON-terminal: a client attempt failed but the player stays in the flow (lobby stays open to
  // retry). Drop the dead client link + reset transient client state without a full endCoop().
  const abandonClientAttempt = (epoch: number): void => {
    if (!isCoopEpochCurrent(epoch)) return; // a real teardown already owns Net — don't fight it
    Net.client?.dispose();
    Net.client = null;
    Net.mode = "single";
    coopRoomCode = null;
  };

  // NON-terminal transition: the quick-match join didn't pan out → drop any in-flight client link
  // and become a public host instead. (openHostLobby sets Net.mode = "host" and builds the Host.)
  const beginPublicHostFromQuickMatch = (epoch: number): void => {
    if (!isCoopEpochCurrent(epoch)) return; // teardown won — stay torn down
    Net.client?.dispose();
    Net.client = null;
    openHostLobby(true);
  };
```

- [ ] **Step 2: Capture the epoch + guard the `join` write-back**

In `game/main.ts`, find the top of `join` (around line 765):

```ts
    const join = async (): Promise<void> => {
      const code = roomInput.value.trim().toUpperCase(); // idFromName is case-sensitive
      if (!code || roomGo.disabled) return; // re-entry guard: ignore double-click / Enter spam
      roomGo.disabled = true;
      let rejected = false; // roomfull set a terminal message → don't let onClose clobber it
      lastClientLobbyState = null;
      setClientLobby({ k: "joining" });
      try {
        const link = await joinRoom(code);
        Net.mode = "client";
        coopRoomCode = code; // arm the reconnect watchdog for this room
        Net.client = new Client(link, undefined, {
          // persist our reconnect identity each Hello so a drop can rejoin the same slot
          onIdentity: (pid, nonce) => {
            try {
              sessionStorage.setItem(`q_rejoin_${code}`, JSON.stringify({ pid, nonce }));
            } catch {
              /* sessionStorage unavailable — reconnect just falls back to a fresh slot */
            }
          },
          // host turned us away: room is full. Terminal (manual connect can't get in either), so
          // do NOT open the manual fallback — surface a clear message and re-enable Join so the
          // player can try a different code.
          onRoomFull: () => {
            rejected = true;
            clearTimeout(failTimer); // roomfull can arrive before/around open → don't let the
            // NAT-timeout later clobber this terminal message with a "failed"
            coopRoomCode = null; // don't try to reconnect to a room we were refused from
            setClientLobby({
              k: "lost",
              step: "host",
              msg: "room is full — the squad is already at capacity (4).",
            });
            roomGo.disabled = false;
          },
        });
        setClientLobby({ k: "linking" });
```

Change to (capture `epoch`, route through `becomeClient`, and bail if it returned `null`):

```ts
    const join = async (): Promise<void> => {
      const code = roomInput.value.trim().toUpperCase(); // idFromName is case-sensitive
      if (!code || roomGo.disabled) return; // re-entry guard: ignore double-click / Enter spam
      roomGo.disabled = true;
      const epoch = coopEpoch(); // cancel our write-backs if the player leaves during the await
      let rejected = false; // roomfull set a terminal message → don't let onClose clobber it
      lastClientLobbyState = null;
      setClientLobby({ k: "joining" });
      try {
        const link = await joinRoom(code);
        const client = becomeClient(epoch, link, code, {
          // persist our reconnect identity each Hello so a drop can rejoin the same slot
          onIdentity: (pid, nonce) => {
            try {
              sessionStorage.setItem(`q_rejoin_${code}`, JSON.stringify({ pid, nonce }));
            } catch {
              /* sessionStorage unavailable — reconnect just falls back to a fresh slot */
            }
          },
          // host turned us away: room is full. Terminal (manual connect can't get in either), so
          // do NOT open the manual fallback — surface a clear message and re-enable Join so the
          // player can try a different code.
          onRoomFull: () => {
            if (!isCoopEpochCurrent(epoch)) return; // stale attempt — teardown owns the UI
            rejected = true;
            clearTimeout(failTimer); // roomfull can arrive before/around open → don't let the
            // NAT-timeout later clobber this terminal message with a "failed"
            coopRoomCode = null; // don't try to reconnect to a room we were refused from
            setClientLobby({
              k: "lost",
              step: "host",
              msg: "room is full — the squad is already at capacity (4).",
            });
            roomGo.disabled = false;
          },
        });
        if (!client) return; // player left during the await → becomeClient closed the link
        setClientLobby({ k: "linking" });
```

- [ ] **Step 3: Guard the `join` timeout + open/close callbacks**

In `game/main.ts`, find the `failTimer`/`onOpen`/`onClose` block (around line 806-836):

```ts
        let opened = false;
        failTimer = setTimeout(() => {
          if (opened) return;
          roomGo.disabled = false;
          setClientLobby({
            k: "failed",
            step: "link",
            msg: failMsg(
              "couldn't connect (network/NAT). Try a personal network, or manual connect below.",
            ),
          });
        }, CONFIG.net.p2pOpenTimeoutMs);
        link.onOpen(() => {
          opened = true;
          clearTimeout(failTimer);
          setClientLobby({ k: "connected" });
        });
        link.onClose(() => {
          clearTimeout(failTimer);
          if (rejected) return; // roomfull already showed the terminal "room is full"
          roomGo.disabled = false;
          setClientLobby(
            opened
              ? { k: "lost", step: "host", msg: "disconnected from host." }
              : {
                  k: "failed",
                  step: "link",
                  msg: failMsg("connection failed (network/NAT) — try manual connect below."),
                },
          );
        });
```

Change to (each callback bails when stale; the timeout also drops the dead link via `abandonClientAttempt`):

```ts
        let opened = false;
        failTimer = setTimeout(() => {
          if (opened || !isCoopEpochCurrent(epoch)) return;
          abandonClientAttempt(epoch); // close the never-opened link so the host sees no ghost
          roomGo.disabled = false;
          setClientLobby({
            k: "failed",
            step: "link",
            msg: failMsg(
              "couldn't connect (network/NAT). Try a personal network, or manual connect below.",
            ),
          });
        }, CONFIG.net.p2pOpenTimeoutMs);
        link.onOpen(() => {
          if (!isCoopEpochCurrent(epoch)) return;
          opened = true;
          clearTimeout(failTimer);
          setClientLobby({ k: "connected" });
        });
        link.onClose(() => {
          if (!isCoopEpochCurrent(epoch)) return; // teardown already closed us — don't touch the UI
          clearTimeout(failTimer);
          if (rejected) return; // roomfull already showed the terminal "room is full"
          roomGo.disabled = false;
          setClientLobby(
            opened
              ? { k: "lost", step: "host", msg: "disconnected from host." }
              : {
                  k: "failed",
                  step: "link",
                  msg: failMsg("connection failed (network/NAT) — try manual connect below."),
                },
          );
        });
```

- [ ] **Step 4: Type-check**

Run: `bun run typecheck`
Expected: no errors. (`beginPublicHostFromQuickMatch` is not yet referenced — it will be in Task 7. If `noUnusedLocals` flags it now, temporarily proceed to Task 7 before committing, OR note it. To keep the commit clean, DEFER committing this task until Task 7 is done — they share the helper. If you must commit separately, add Task 7 first.)

Practical guidance: implement Task 6 and Task 7 back-to-back, then type-check and commit together (see Task 7 Step 5). The `becomeClient`/`abandonClientAttempt` helpers are used by `join` now; `beginPublicHostFromQuickMatch` is used by `quickMatch` in Task 7.

- [ ] **Step 5: Manual playtest — race the Back button**

`bun run dev:coop`, two tabs. Tab A hosts (note code). Tab B → Join by code → enter code → click Join, then **immediately click Back** before it connects. Expected: Tab A shows NO ghost P2 appearing a moment later; Tab B is cleanly back at the hub. Repeat 3-4 times to catch the race. (This is the stale-write-back the epoch guard fixes.)

(Commit is in Task 7 Step 5 — do not commit yet.)

---

### Task 7: Epoch-guard quick match + route fallbacks through the transition helpers

**Files:**
- Modify: `game/main.ts` (`quickMatch` ~1075-1162)

**Interfaces:**
- Consumes: `becomeClient`, `beginPublicHostFromQuickMatch`, `coopEpoch`, `isCoopEpochCurrent` (Task 6).
- Produces: nothing new — completes the join-path guarding.

- [ ] **Step 1: Capture the epoch + guard the quick-match write-back**

In `game/main.ts`, find `quickMatch` (around line 1075). Replace the body from the top through the `Net.client = new Client(...)` block (lines 1075-1125) with:

```ts
  const quickMatch = async (): Promise<void> => {
    stopCoopPoll();
    el<HTMLButtonElement>("coop-quick").disabled = true; // no re-entry until we leave/return to the hub
    const epoch = coopEpoch(); // cancel our write-backs if the player leaves the hub mid-scan
    coopStatus("scanning for raids…", true);
    let rooms: RoomInfo[] = [];
    let registryOk = true;
    try {
      rooms = await listRooms();
    } catch {
      registryOk = false; // browser unreachable → fall through to hosting
    }
    if (!isCoopEpochCurrent(epoch)) return; // left the hub during the scan
    const top = selectQuickMatch(rooms).slice(0, 3);
    const pick = top.length ? top[Math.floor(Math.random() * top.length)] : undefined;
    if (!pick) {
      beginPublicHostFromQuickMatch(epoch); // nothing joinable → host a public raid
      setStatus(
        registryOk
          ? "No open raids found — hosting a public one. Others can Quick Match in."
          : "Room browser unavailable — hosting a public raid instead.",
      );
      return;
    }
    coopStatus(`joining ${pick.code}…`, true);
    let link: Awaited<ReturnType<typeof joinRoom>>;
    try {
      link = await joinRoom(pick.code);
    } catch {
      beginPublicHostFromQuickMatch(epoch); // couldn't reach it (or version mismatch) → host instead
      setStatus("Couldn't reach that raid — hosting a public one instead.");
      return;
    }
    const code = pick.code;
    const client = becomeClient(epoch, link, code, {
      onIdentity: (pid, nonce) => {
        try {
          sessionStorage.setItem(`q_rejoin_${code}`, JSON.stringify({ pid, nonce }));
        } catch {
          /* sessionStorage unavailable */
        }
      },
      onRoomFull: () => {
        if (!isCoopEpochCurrent(epoch)) return;
        clearTimeout(t); // defensive — normally already cleared on open
        beginPublicHostFromQuickMatch(epoch);
        setStatus("This raid is full — hosting a public one instead.");
      },
    });
    if (!client) return; // player left during the await → becomeClient closed the link
```

- [ ] **Step 2: Guard the quick-match timeout + open/close callbacks**

Continuing in `quickMatch`, find the remaining block (around lines 1126-1161):

```ts
    let opened = false;
    const t = window.setTimeout(() => {
      if (opened) return;
      try {
        link.close();
      } catch {
        /* ignore */
      }
      Net.client = null;
      Net.mode = "single";
      coopRoomCode = null;
      openHostLobby(true); // didn't connect in time → host instead
      setStatus(
        getTurnStatus() === "budget-reached"
          ? "Relay at capacity this month — hosting a public raid (same-network players only)."
          : "Couldn't connect in time — hosting a public one instead.",
      );
    }, CONFIG.net.quickMatchTimeoutMs);
    link.onOpen(() => {
      opened = true;
      clearTimeout(t);
      coopStatus("connected — waiting for host to deploy");
    });
    link.onClose(() => {
      if (opened) return; // post-open drops are the reconnect watchdog's job
      clearTimeout(t);
      Net.client = null;
      Net.mode = "single";
      coopRoomCode = null;
      openHostLobby(true);
      setStatus(
        getTurnStatus() === "budget-reached"
          ? "Relay at capacity this month — hosting a public raid (same-network players only)."
          : "Couldn't connect — hosting a public one instead.",
      );
    });
  };
```

Change to (route both fallbacks through `beginPublicHostFromQuickMatch`, which disposes the client link; add epoch guards):

```ts
    let opened = false;
    const t = window.setTimeout(() => {
      if (opened || !isCoopEpochCurrent(epoch)) return;
      beginPublicHostFromQuickMatch(epoch); // didn't connect in time → drop link + host instead
      setStatus(
        getTurnStatus() === "budget-reached"
          ? "Relay at capacity this month — hosting a public raid (same-network players only)."
          : "Couldn't connect in time — hosting a public one instead.",
      );
    }, CONFIG.net.quickMatchTimeoutMs);
    link.onOpen(() => {
      if (!isCoopEpochCurrent(epoch)) return;
      opened = true;
      clearTimeout(t);
      coopStatus("connected — waiting for host to deploy");
    });
    link.onClose(() => {
      if (opened || !isCoopEpochCurrent(epoch)) return; // post-open drops → reconnect watchdog's job
      clearTimeout(t);
      beginPublicHostFromQuickMatch(epoch);
      setStatus(
        getTurnStatus() === "budget-reached"
          ? "Relay at capacity this month — hosting a public raid (same-network players only)."
          : "Couldn't connect — hosting a public one instead.",
      );
    });
  };
```

- [ ] **Step 3: Type-check**

Run: `bun run typecheck`
Expected: no errors. All three helpers (`becomeClient`, `abandonClientAttempt`, `beginPublicHostFromQuickMatch`) are now referenced.

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 5: Manual playtest — quick-match fallback + race**

`bun run dev:coop`, two tabs.
1. **Fallback → host:** Tab A → Co-op → **Quick Match** with no public rooms open. Expected: Tab A becomes a public host ("hosting a public one"). Tab B → Quick Match. Expected: Tab B joins Tab A's raid (squad shows P2).
2. **Race:** Tab A hosts publicly. Tab B → Quick Match, then hit **coop-back** (hub Back) mid-connect. Expected: no ghost P2 on Tab A; no stray "public host" spun up on Tab B.

- [ ] **Step 6: Commit (Tasks 6 + 7 together)**

```bash
git add game/main.ts
git commit -m "fix(coop): epoch-guard join + quick-match write-backs

Room-code join and quick match now capture the session epoch and route every
write-back/callback through guarded helpers, so leaving mid-connect can't
resurrect a dead client or spawn a ghost peer. Quick-match fallbacks dispose the
in-flight link before becoming a public host.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Epoch-guard the manual-SDP client + host flows

**Files:**
- Modify: `game/main.ts` (manual host `go.onclick` async ~682-745; manual client `go.onclick` async ~900-970)

**Interfaces:**
- Consumes: `becomeClient`, `coopEpoch`, `isCoopEpochCurrent`, `Host.dispose` add-guard (already closes late links).
- Produces: nothing new.

- [ ] **Step 1: Guard the manual HOST offer flow**

In `game/main.ts`, find the manual host async IIFE (around line 682):

```ts
        void (async () => {
          try {
            const { link, offer, accept } = await createHostLink();
            host.add(link);
            let opened = false;
            link.onOpen(() => {
              opened = true;
              setManualState({ k: "connected", role: "host" });
              setStatus("manual peer linked ✓");
              if (!manual.open) {
                refreshSquad();
                return;
              }
            });
            link.onClose(() => {
              const step = opened ? "host" : "link";
```

Change the head to capture the epoch and refuse a stale link (belt-and-suspenders with `Host.dispose`'s add-guard), and guard `onOpen`:

```ts
        void (async () => {
          const epoch = coopEpoch(); // refuse this offer if the host session ended during the await
          try {
            const { link, offer, accept } = await createHostLink();
            if (!isCoopEpochCurrent(epoch)) {
              link.close(); // host left/tore down before the offer resolved
              return;
            }
            host.add(link); // Host.dispose() also rejects+closes if we were disposed after this check
            let opened = false;
            link.onOpen(() => {
              if (!isCoopEpochCurrent(epoch)) return;
              opened = true;
              setManualState({ k: "connected", role: "host" });
              setStatus("manual peer linked ✓");
              if (!manual.open) {
                refreshSquad();
                return;
              }
            });
            link.onClose(() => {
              if (!isCoopEpochCurrent(epoch)) return;
              const step = opened ? "host" : "link";
```

(The `onClose` body below the changed line is unchanged.)

- [ ] **Step 2: Guard the manual CLIENT reply flow**

In `game/main.ts`, find the manual client `go.onclick` (around line 900):

```ts
        go.onclick = async () => {
          const offer = inEl.value.trim();
          setManualState({ k: "codes", role: "client" });
          if (!offer) return;
          let opened = false;
          let terminal = false;
          try {
            const { link, answer } = await createClientLink(offer);
            setManualState({ k: "linking", role: "client" });
            Net.mode = "client";
            Net.client = new Client(link, undefined, {
              // manual SDP bypasses the signaling version gate → re-check on Hello
              onVersionMismatch: () => {
                terminal = true;
```

Change to route the write-back through `becomeClient` (with `code = null` — manual SDP can't reconnect) and guard the callbacks:

```ts
        go.onclick = async () => {
          const offer = inEl.value.trim();
          setManualState({ k: "codes", role: "client" });
          if (!offer) return;
          const epoch = coopEpoch(); // cancel our write-backs if the player leaves during the await
          let opened = false;
          let terminal = false;
          try {
            const { link, answer } = await createClientLink(offer);
            const client = becomeClient(epoch, link, null, {
              // manual SDP bypasses the signaling version gate → re-check on Hello
              onVersionMismatch: () => {
                if (!isCoopEpochCurrent(epoch)) return;
                terminal = true;
```

Then, immediately after the `Net.client = new Client(... )` object literal closes (the line `});` that ends the hooks object, around line 942), the original code continues:

```ts
            });
            link.onOpen(() => {
              opened = true;
              setManualState({ k: "connected", role: "client" });
              setClientLobby({ k: "connected" });
            });
            link.onClose(() => {
              if (terminal) return; // version mismatch / room full already rendered a terminal error
```

Change it to insert the `becomeClient` null-bail and guard the callbacks:

```ts
            });
            if (!client) return; // player left during the await → becomeClient closed the link
            link.onOpen(() => {
              if (!isCoopEpochCurrent(epoch)) return;
              opened = true;
              setManualState({ k: "connected", role: "client" });
              setClientLobby({ k: "connected" });
            });
            link.onClose(() => {
              if (!isCoopEpochCurrent(epoch)) return;
              if (terminal) return; // version mismatch / room full already rendered a terminal error
```

Also guard the `onRoomFull` hook inside the same `new Client` hooks (around line 928):

Find:

```ts
              // host turned us away: room is full (the client closes its own link on this event)
              onRoomFull: () => {
                terminal = true;
```

Change to:

```ts
              // host turned us away: room is full (the client closes its own link on this event)
              onRoomFull: () => {
                if (!isCoopEpochCurrent(epoch)) return;
                terminal = true;
```

- [ ] **Step 3: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 5: Manual playtest — manual SDP still connects, and Back is clean**

`bun run dev:coop` (or `bun run dev` — manual SDP needs no signaling), two tabs.
1. **Manual connect works:** Tab A → Host co-op → expand **manual connect** → copy the host code. Tab B → Join by code → expand **manual connect** → paste host code → Generate reply → copy reply → paste into Tab A → connect. Expected: both show "connected"; Tab A squad shows P2.
2. **Back during manual:** repeat, but on Tab B hit **Back** right after Generate reply. Expected: no ghost P2 on Tab A once it would have linked.

- [ ] **Step 6: Commit**

```bash
git add game/main.ts
git commit -m "fix(coop): epoch-guard manual-SDP client + host flows

Manual connect now refuses stale links after teardown and routes the client
write-back through becomeClient(), matching the room-code/quick-match paths.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 9: Epoch-guard the reconnect flow

**Files:**
- Modify: `game/main.ts` (`reconnectClient` ~99-136)

**Interfaces:**
- Consumes: `coopEpoch`/`isCoopEpochCurrent` (Task 1), `endCoop` (Task 5).
- Produces: nothing new — `reconnectClient` now bails if a teardown (e.g. lobby/tab close) happens during its backoff loop instead of rebinding onto a dead session.

- [ ] **Step 1: Capture the epoch + guard the backoff loop**

In `game/main.ts`, find the head of `reconnectClient` (around line 99):

```ts
async function reconnectClient(code: string): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  Net.client?.suspend();
  const overlay = el("reconnect");
  const sub = el("reconnect-sub");
  overlay.classList.add("show");
  const ladder = CONFIG.net.reconnect.backoffMs;
  for (let i = 0; i < ladder.length; i++) {
    sub.textContent = `attempt ${i + 1} of ${ladder.length}…`;
    const res = await rejoinRoom(code);
    if (res.status === "open") {
      Net.client?.rebind(res.link, loadRejoinToken(code));
      overlay.classList.remove("show");
      reconnecting = false;
      return;
    }
```

Change to (capture the epoch; after each await, bail if a teardown happened; on `open`, close the surplus link if stale):

```ts
async function reconnectClient(code: string): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  const epoch = coopEpoch(); // a lobby/tab close during the backoff must abort the rebind
  Net.client?.suspend();
  const overlay = el("reconnect");
  const sub = el("reconnect-sub");
  overlay.classList.add("show");
  const ladder = CONFIG.net.reconnect.backoffMs;
  for (let i = 0; i < ladder.length; i++) {
    sub.textContent = `attempt ${i + 1} of ${ladder.length}…`;
    const res = await rejoinRoom(code);
    if (!isCoopEpochCurrent(epoch)) {
      if (res.status === "open") res.link.close(); // teardown won mid-attempt — drop the fresh link
      return; // endCoop() already reset reconnecting + the overlay
    }
    if (res.status === "open") {
      Net.client?.rebind(res.link, loadRejoinToken(code));
      overlay.classList.remove("show");
      reconnecting = false;
      return;
    }
```

- [ ] **Step 2: Guard the retryable backoff `await`**

Continuing in `reconnectClient`, find the retryable tail of the loop (around line 122):

```ts
    // retryable (timeout/unreachable): the host may be briefly unreachable (NAT blip) — back off
    await delayMs(ladder[i] ?? 1000);
  }
```

Change to:

```ts
    // retryable (timeout/unreachable): the host may be briefly unreachable (NAT blip) — back off
    await delayMs(ladder[i] ?? 1000);
    if (!isCoopEpochCurrent(epoch)) return; // teardown during the backoff — stop retrying
  }
```

- [ ] **Step 3: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 5: Manual playtest — reconnect abort**

`bun run dev:coop`, two tabs. Tab A hosts, Tab B joins, Tab A deploys → both in-game. Kill Tab A's connection (close Tab A). Tab B shows the "reconnecting…" overlay. While it's retrying, on Tab B click through to leave (the give-up path takes it to title anyway). Expected: no error thrown; Tab B ends cleanly at title with no lingering client link. (This mostly exercises that the guard doesn't break the normal give-up→endCoop path.)

- [ ] **Step 6: Commit**

```bash
git add game/main.ts
git commit -m "fix(coop): abort reconnect backoff when the session tears down

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 10: `pagehide` teardown (fixes leak ④)

**Files:**
- Modify: `game/main.ts` (register a `pagehide` listener in `main()`)

**Interfaces:**
- Consumes: `endCoop` (Task 5).
- Produces: best-effort teardown when the tab is closed/navigated so the host doesn't hold a ghost peer until the ICE consent timeout.

- [ ] **Step 1: Register the listener**

In `game/main.ts`, at the END of `function main()` (right before its closing brace, after all the wiring), add:

```ts
  // Tab close / navigate away: best-effort teardown so the host sees us drop immediately (pc.close()
  // sends the DTLS close) instead of holding a ghost peer until the ICE consent timeout. pagehide is
  // the reliable signal on mobile Safari (beforeunload is not); it's best-effort — the OS may kill
  // the tab first — but combined with the reconnect grace it covers the common case.
  window.addEventListener("pagehide", () => endCoop());
```

- [ ] **Step 2: Type-check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 4: Manual playtest — leak ④ (tab close)**

`bun run dev:coop`, two tabs. Tab A hosts, Tab B joins (Tab A squad shows P2). **Close Tab B's tab entirely** (Cmd-W). Expected: Tab A's squad drops P2 promptly (within ~1s), NOT after a long ICE timeout. Then reverse: Tab B joins fresh Tab A; **close Tab A** (the host). Expected: Tab B sees the host drop / reconnect overlay promptly.

- [ ] **Step 5: Commit**

```bash
git add game/main.ts
git commit -m "fix(coop): tear down the session on pagehide (tab close)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 11: Full validation + regression sweep

**Files:** none (verification only).

- [ ] **Step 1: Type-check the whole project**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: no errors. (If Biome reports formatting, run `bun run lint:fix`, re-review the diff, and amend the relevant commit.)

- [ ] **Step 3: Full unit-test suite**

Run: `bun run test`
Expected: all pass, including the new `session.test.ts`, `client.test.ts`, and the added `Host.dispose` cases in `host.test.ts`. No existing test regressed.

- [ ] **Step 4: Build**

Run: `bun run build`
Expected: `tsc --noEmit` clean + `vite build` produces `dist/` with no errors.

- [ ] **Step 5: Consolidated 2-tab manual playtest checklist**

`bun run dev:coop`, two tabs. Confirm every scenario passes in one sitting:

- [ ] **① Client lobby Back:** host on A, join on B, B → Back → A squad drops P2 (no ghost).
- [ ] **② Host lobby Back:** host on A, join on B, A → Back → B shows host-left (not stuck "waiting").
- [ ] **③ Game-over restart → solo:** A hosts + B joins + A deploys + die + restart, then A → Start (solo) runs a live, non-frozen single-player game; no public raid relisted.
- [ ] **④ Tab close:** host on A, join on B, close B's tab → A drops P2 promptly.
- [ ] **Race (join):** B clicks Join then Back immediately → no delayed ghost on A.
- [ ] **Race (quick match):** B Quick Matches into A then hub-Back mid-connect → no ghost, no stray host.
- [ ] **Quick-match fallback:** Quick Match with no rooms → becomes public host; second tab Quick Matches in.
- [ ] **Manual SDP:** host/join over manual connect still links; Back mid-manual is clean.
- [ ] **Co-op happy path:** host + join + deploy + play a wave together (host authoritative, client interpolates) — confirms the wrappers didn't break `host.start()`.
- [ ] **Single-player regression:** fresh Start (no co-op) plays exactly as before (movement, firing, day/night, shop, death→salvage).

- [ ] **Step 6: Final confirmation**

If anything above FAILs, fix in the owning task's file, re-run `typecheck`/`lint`/`test`, and re-playtest the affected scenario before declaring done. Do not claim completion on type-checks alone — the co-op lifecycle is playtest-verified per repo convention.

---

## Self-Review

**1. Spec coverage** (against `docs/superpowers/specs/2026-07-02-coop-session-teardown-design.md`):
- Layer 0 (epoch) → Task 1 (module) + Tasks 6-9 (guards on join/quickMatch/manual/reconnect). ✅
- Layer 1 (dispose primitives) → Task 2 (Client) + Task 3 (Host + add-guard + claimTimer clear). ✅
- Layer 2 (`endCoop`, terminal) → Task 5. ✅
- Layer 2.5 (non-terminal transitions: `abandonClientAttempt`, `beginPublicHostFromQuickMatch`) → Task 6 (defined) + Tasks 6-7 (routed: P2P timeout, quick-match fallbacks). ✅
- Layer 3 (start wrappers for leak ③) → Task 5 (`startSingleRun`/`startHostRun`, byte-for-byte `startGame` untouched). ✅
- Layer 4 (pagehide) → Task 10. ✅
- The 4 leaks: ① Task 5 (closeLobby→endCoop client dispose), ② Task 5 (endCoop host dispose), ③ Task 5 (restartBtn + startSingleRun), ④ Task 10 (pagehide). ✅
- Split-ownership root cause → Task 4 (consolidate to module scope). ✅
- Deferred leave/hostleft message + no PROTOCOL_VERSION bump → Global Constraints. ✅
- Testing split (dispose+epoch unit-tested; main.ts playtest-verified) → Tasks 1-3 unit tests, Tasks 5-10 playtests. ✅

**2. Placeholder scan:** no "TBD"/"handle edge cases"/"similar to Task N"/"add validation" — every code step shows the full before/after and every command has an expected result. ✅

**3. Type consistency:** helper names are stable across tasks — `bumpCoopEpoch`/`coopEpoch`/`isCoopEpochCurrent` (Task 1), `dispose()` (Tasks 2-3), `endCoop`/`startSingleRun`/`startHostRun` (Task 5), `becomeClient`/`abandonClientAttempt`/`beginPublicHostFromQuickMatch` (Task 6). `becomeClient` returns `Client | null` and every caller bails on `null`. `ConstructorParameters<typeof Client>[2]` matches the actual `Client` hooks parameter. ✅

Known cross-task coupling: Tasks 6 and 7 share the `beginPublicHostFromQuickMatch` helper and are committed together (Task 7 Step 6) to avoid a transient `noUnusedLocals` error — this is called out explicitly in Task 6 Step 4.
