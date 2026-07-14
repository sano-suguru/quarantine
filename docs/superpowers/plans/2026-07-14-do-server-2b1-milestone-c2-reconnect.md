# DO Server 2b ① Milestone C-2 — Arena auto-reconnect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the (present-but-undriven) client reconnect loop so a transient WebSocket drop auto-reconnects and re-attaches the held body in place, instead of freezing the frame forever with no recovery.

**Architecture:** The DO already holds a dropped player's body `absent` for `graceMs` and re-attaches it on a `{t:"rejoin", pid, nonce}` message (`worker/arena.ts` `tryRejoin`); the `Client` already has `suspend`/`rebind`/`onIdentity`/`resetNet`/`lastActivityMs`, but nothing drives them. This milestone wires `main.ts` to: (1) persist `{pid, nonce}` from Hello; (2) detect a drop — **primary:** the WebSocket `onClose`/`onError` event (deterministic on a single multiplexed WS); **backstop:** a snapshot-starvation watchdog in the render loop (for a half-open socket that stays open but silent); (3) redial the arena URL with backoff, calling `Client.rebind()` to replay the rejoin token on the new link. **The client does not police the grace window — the DO does:** a reconnect landing within grace re-attaches in place; one landing after grace (body retired) falls through to a fresh slot server-side. The DO reports which happened via a new additive `hello.resumed` flag, so the client shows a silent in-place resume vs a brief "respawned at the fortress" note. All attempts failing → back to title.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Bun, Vite, Vitest, Biome, Cloudflare Durable Object (standard WebSocket API, not Hibernation).

## Global Constraints

- **`sim/` stays headless** — the one pure helper added (`reconnectDelay`) lives in `sim/net/` with no DOM/timer imports; all DOM/`setTimeout`/link-lifecycle driving stays in `game/`.
- **No `PROTOCOL_VERSION` bump** — `hello.resumed` is an **additive optional JSON field** on the reliable channel (like M-A's `banked`). The binary snapshot layout is unchanged, so the golden byte test in `snapshot.test.ts` is unaffected and stale clients still parse Hello. Leave `PROTOCOL_VERSION` at 19.
- **Reconnect is not unit-tested at the driver level** — consistent with 2a/M-A/M-B, DO+client net glue is exercised via the wrangler-dev harness + real-browser playtest, not Vitest (CLAUDE.md: only pure/deterministic code is unit-tested). The single pure piece (`reconnectDelay`) *is* TDD'd; the driver's gate is typecheck/build/lint + the `debugDrop` hook + the real-WS-drop playtest in Final Verification.
- **Feel-first** — reconnect is the riskiest slice; **not done until played** under a real WS drop (devtools offline toggle with a second client keeping the arena alive), not just `debugDrop`.
- **Derive-first preserved** — `resetNet` (run inside `rebind`) clears `prev`/`prevPhase`/`buf`, so `siegeEdgeCue(null, …)` suppresses a spurious NIGHT/DAY banner and `effects()` fires no phantom kill-burst on the first post-reconnect snapshot (the same drop-in coherence M-A/M-B rely on).

---

## Grounding facts (verified against current `main`, 2026-07-14)

- **DO side is complete:** `worker/arena.ts` `onClose` (279-292) holds a decided peer's body (`body.absent=true; peer.goneAt=Date.now(); return`) **without deleting the peer or calling `stop()`** — so the `setInterval` loop keeps running through the grace window **even if the dropped player was the last connection**, and the grace-retirement check in `step()` (105-110, `now - p.goneAt > grace` → retire; when it empties `peers`, `stop()` clears the loop + nulls state) survives a solo drop. `tryRejoin` (224-240): if a stale peer with a matching pid+nonce and a live body is found → re-attach in place (`body.absent=false; old.goneAt=0; dropPeer(old)`); else `decideFresh` (fresh slot). `sendHello` (259-269) is called on both paths and on initial join.
- **CF platform grounding (verified via the DO lifecycle doc, 2026-07-14) — the solo-reconnect premise holds:** a running `setInterval` blocks *hibernation* (keeps the DO "idle, in-memory, non-hibernateable"), but **eviction** from that state happens only after **70-140s of no incoming requests/events**. Our reconnect **grace is 20s**, comfortably inside that floor — so a solo drop (zero live WS) keeps the DO's held body in memory for the whole grace window, and a solo in-grace reconnect re-attaches in place. This holds *because* `20s ≪ 70-140s`, not because `setInterval` keeps a connectionless DO alive forever — do not raise `graceMs` near ~70s without revisiting. If CF evicts/restarts the DO anyway (rare), in-memory state is lost → reconnect finds a fresh DO → `resumed=false` → fresh spawn (graceful, handled). This premise depends on 2b② empty-arena hibernate/persist **not yet being built**.
- **Client side is present but undriven:** `Client.suspend()` (207-215: `live=false` + close + `resetNet`), `rebind(link, rejoin)` (219-229: swap link, set `hooks.rejoin`, `resetNet`, fresh activity stamps, `live=true`, re-`wire`), `onIdentity` hook (stores `{pid, nonce}`), `lastActivityMs()` (247-249: `max(lastSnapAt, lastRelAt)`), `resetNet()` (233-243), `debugDrop()` (252-258). `wire()` (108-187) replays `hooks.rejoin` as `{t:"rejoin"|"join"}` on each link `onOpen` (183-186).
- **`main.ts` today:** `startSingleRun` (101-151) builds one link via `createArenaLink(arenaUrl(code))`, constructs `Client` with **only** an `onRoomFull` hook (no `onIdentity`, no `rejoin`), and wires `link.onClose` to show "Disconnected from the arena." **only when `!arenaStarted`** — a post-start drop currently does nothing (frozen frame). The `frame()` render loop (309-366) has **no** starvation watchdog.
- **`wsLink.ts`** `createArenaLink` fires `onClose` on both the WS `close` and `error` events, idempotently (`closed` flag). `onOpen` supports multiple callbacks. `onClose(cb)` called after close fires `cb` immediately.
- **UI scaffolding exists:** `index.html:80-83` `#reconnect` (`.rc-main` "RECONNECTING" + `#reconnect-sub`) and `#downed` (75-78) are present. `#reconnect` CSS (`game/style.css:342-371`) is currently a **full-screen dimmed overlay** (`inset:0`, `background: rgba(6,8,7,0.62)`, `z-index:60`, `pointer-events:auto`) — this milestone restyles it to a **non-blocking top banner** (per the chosen UX). `#downed` (styling at 314-340: `top:18%`, `pointer-events:none`, no dim) is the mirror. No JS drives `#reconnect` yet; `#downed` is driven via `classList.toggle("show", …)` (`game.ts:1257`).
- `CONFIG.net.reconnect` (`sim/config.ts:31-36`): `snapStarvationMs:2500`, `backoffMs:[1000,2000,4000,8000]`, `graceMs:20000`, `rejoinClaimTimeoutMs:1000`. `arenaOpenTimeoutMs:15000` (24) is the **initial** cold-connect timeout (kept for startSingleRun; reconnect uses its own shorter per-attempt timeout).

## File structure

- **Task 1** — Modify: `game/net/net.ts` (add `resumed?` to `hello`), `worker/arena.ts` (`sendHello` resumed param), `game/net/client.ts` (add `onResumed` hook + fire it). Wire signal for in-place-vs-fresh.
- **Task 2** — Create: `sim/net/reconnect.ts`, `sim/net/reconnect.test.ts`. Pure backoff-delay contract (the only TDD piece).
- **Task 3** — Modify: `sim/config.ts` (add `attemptTimeoutMs`), `game/main.ts` (identity persistence + reconnect driver + watchdog + banner), `index.html` (`id` on `.rc-main`), `game/style.css` (restyle `#reconnect` to a non-blocking banner). The reconnect loop.
- **Task 4** — Modify: `sim/config.ts` (reconnect block comment), `game/net/client.ts` (two-channel/host reconnect comments). Comment triage deferred from PR1.

Order: Task 1 (signal) → Task 2 (pure helper) → Task 3 (driver, consumes both) → Task 4 (comment sweep).

---

## Task 1: Add the `hello.resumed` signal (in-place re-attach vs fresh slot)

**Files:**
- Modify: `game/net/net.ts:23-34` (add `resumed?: boolean` to the `hello` `NetMsg`)
- Modify: `worker/arena.ts:224-269` (`sendHello` takes `resumed`; `tryRejoin` passes `true` on re-attach)
- Modify: `game/net/client.ts:88-101` (add `onResumed` hook) and `:113-123` (fire it in the hello handler)

**Interfaces:**
- Produces: `hello` messages now carry `resumed?: boolean` (`true` = re-attached the held body; `false`/absent = fresh slot, incl. initial join). `Client` gains a hook `onResumed?: (resumed: boolean) => void` fired on every Hello.
- Consumes: Task 3's `main.ts` sets `onResumed` to drive the reconnect banner + respawn note.

> Testing: wire-shape change on the reliable JSON channel; no unit test (the additive field is covered by the reconnect playtest in Final Verification). Gate = `bun run typecheck` (root) + worker typecheck.

- [ ] **Step 1: Add `resumed?` to the `hello` NetMsg**

In `game/net/net.ts`, the `hello` variant (currently 24-34) gains an optional field. After the `v?: number;` field, add:

```typescript
      /** DO → client: true if this Hello re-attached the client's still-held body (rejoin within
       *  grace); false/absent = a fresh slot (initial join, or a rejoin after graceMs retired the
       *  body). Lets the client show a silent in-place resume vs a "respawned" note. Additive JSON. */
      resumed?: boolean;
```

- [ ] **Step 2: Thread `resumed` through the DO's `sendHello`**

In `worker/arena.ts`, change `sendHello` (259-269) to take a `resumed` flag:

```typescript
  private sendHello(peer: Peer, resumed = false): void {
    const s = this.state;
    if (!s) return;
    this.send(peer.ws, {
      t: "hello",
      localId: peer.pid,
      owned: s.owned,
      nonce: peer.nonce,
      v: PROTOCOL_VERSION,
      resumed,
    });
  }
```

Then in `tryRejoin` (224-240), the in-place re-attach branch calls `sendHello(peer, true)`:

```typescript
    if (old && body) {
      peer.pid = pid;
      peer.nonce = nonce;
      peer.decided = true;
      body.absent = false;
      old.goneAt = 0;
      this.dropPeer(old); // untrack the stale peer (its body is now owned by `peer`)
      this.sendHello(peer, true); // re-attached in place
    } else {
      this.decideFresh(peer); // grace expired / unknown token → fresh slot (sendHello resumed=false)
    }
```

(`decideFresh` at 208-222 keeps calling `this.sendHello(peer)` → `resumed` defaults to `false`. This covers both the initial join and the grace-exceeded fresh spawn — correct: neither is an in-place resume.)

- [ ] **Step 3: Add the `onResumed` hook to the Client and fire it**

In `game/net/client.ts`, the constructor `hooks` type (91-100) gains a hook. After the `onRoomFull?` entry, add:

```typescript
      /** fired on every Hello: true if the DO re-attached our held body (rejoin within grace),
       *  false if we got a fresh slot. main.ts uses it to drive the reconnect banner/respawn note. */
      onResumed?: (resumed: boolean) => void;
```

Then in the `hello` branch of `wire()` (113-123), fire it after `onIdentity`:

```typescript
      if (msg.t === "hello") {
        // wire-version gate for the manual-SDP path (signaling gates room-code / quick-match);
        // mismatch → stop before showing the game, surface a clear error
        if (msg.v !== undefined && msg.v !== PROTOCOL_VERSION) {
          this.live = false;
          this.hooks.onVersionMismatch?.();
          return;
        }
        this.hello = { localId: msg.localId, owned: msg.owned };
        this.hooks.onIdentity?.(msg.localId, msg.nonce ?? "");
        this.hooks.onResumed?.(msg.resumed ?? false);
        if (this.started) clientApplyHello(msg.localId, msg.owned);
      } else if (msg.t === "banked") {
```

(On the initial connect, `onResumed` fires with `false` but Task 3's handler is a no-op unless a reconnect is in progress. `clientApplyHello` on reconnect re-applies our id/ownership — needed because a grace-exceeded fresh slot can hand us a **new** `localId`.)

- [ ] **Step 4: Type-check root + worker**

Run: `bun run typecheck`
Then the worker: `cd worker && bunx tsc --noEmit -p . ; cd ..` (or the repo's worker typecheck path — the `worker` CI check uses the root-pinned `tsc` against `worker/tsconfig`).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add game/net/net.ts worker/arena.ts game/net/client.ts
git commit -m "feat(net): 2b①C-2 — hello.resumed signals in-place re-attach vs fresh slot"
```

---

## Task 2: Pure `reconnectDelay` backoff helper (TDD)

**Files:**
- Create: `sim/net/reconnect.ts`
- Create: `sim/net/reconnect.test.ts`

**Interfaces:**
- Produces: `export function reconnectDelay(attempt: number, backoffMs: readonly number[]): number | null` — the delay (ms) before reconnect `attempt` (0-based), or `null` when `attempt` is past the last configured backoff (→ give up, go to title). This is the sole authority on how many attempts happen and their spacing.
- Consumes: Task 3's `main.ts` reconnect driver.

- [ ] **Step 1: Write the failing test**

Create `sim/net/reconnect.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { reconnectDelay } from "./reconnect";

describe("reconnectDelay", () => {
  const backoff = [1000, 2000, 4000, 8000] as const;

  it("returns the per-attempt delay for in-range attempts", () => {
    expect(reconnectDelay(0, backoff)).toBe(1000);
    expect(reconnectDelay(1, backoff)).toBe(2000);
    expect(reconnectDelay(3, backoff)).toBe(8000);
  });

  it("returns null once attempts are exhausted (→ give up)", () => {
    expect(reconnectDelay(4, backoff)).toBeNull();
    expect(reconnectDelay(99, backoff)).toBeNull();
  });

  it("returns null for an empty backoff array", () => {
    expect(reconnectDelay(0, [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun run test -- reconnect`
Expected: FAIL — `Cannot find module './reconnect'` / `reconnectDelay is not a function`.

- [ ] **Step 3: Implement the helper**

Create `sim/net/reconnect.ts`:

```typescript
// Pure client reconnect timing. The DO decides in-place-vs-fresh (grace) authoritatively; this
// only governs how long / how many times the client redials before giving up to the title.

/**
 * Delay (ms) before reconnect `attempt` (0-based), or `null` when `attempt` is past the last
 * configured backoff step — the caller then stops retrying and returns to the title. Grace is NOT
 * policed here: a reconnect landing after `graceMs` simply re-attaches as a fresh slot server-side.
 */
export function reconnectDelay(attempt: number, backoffMs: readonly number[]): number | null {
  return attempt >= 0 && attempt < backoffMs.length ? (backoffMs[attempt] as number) : null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bun run test -- reconnect`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add sim/net/reconnect.ts sim/net/reconnect.test.ts
git commit -m "feat(net): 2b①C-2 — pure reconnectDelay backoff helper"
```

---

## Task 3: Drive the reconnect loop (identity persistence, driver, watchdog, banner)

**Files:**
- Modify: `sim/config.ts:31-36` (add `attemptTimeoutMs`)
- Modify: `game/main.ts` (reconnect state + `startReconnect`/`scheduleAttempt`/`tryAttempt`/`onAttemptFail`/`cancelReconnect`; `onIdentity`/`onResumed` hooks; post-start `onClose` → reconnect; watchdog in `frame()`; banner helpers)
- Modify: `index.html:81` (add `id="reconnect-main"` to `.rc-main`)
- Modify: `game/style.css:342-371` (restyle `#reconnect` to a non-blocking top banner)

**Interfaces:**
- Consumes: `reconnectDelay` (Task 2); `Client.suspend`/`rebind`/`lastActivityMs`; the `onIdentity`/`onResumed`/`onRoomFull` hooks; `CONFIG.net.reconnect.{snapStarvationMs,backoffMs,attemptTimeoutMs}`; `createArenaLink`/`arenaUrl`; `endCoop`/`toTitle`/`showLoadError`.

> Testing: driver glue (DOM + timers + link lifecycle) — no unit test (project discipline). Gate = typecheck/build/lint + `debugDrop` + the real-WS-drop playtest (Final Verification).

- [ ] **Step 1: Add `attemptTimeoutMs` to the reconnect config**

In `sim/config.ts`, inside the `reconnect` block (31-36), add a per-attempt timeout after `backoffMs`:

```typescript
    reconnect: {
      snapStarvationMs: 2500, // WS silent this long while running → reconnect (half-open backstop)
      backoffMs: [1000, 2000, 4000, 8000], // per-attempt delay; length = max attempts before title
      attemptTimeoutMs: 4000, // per-attempt open+Hello budget; a stuck dial rolls to the next backoff
      graceMs: 20000, // DO holds a dropped player's body this long for in-place re-attach
      rejoinClaimTimeoutMs: 1000, // DO waits this for the client's first rel (join/rejoin) before assuming fresh
    },
```

(Full comment rewrite of this block is Task 4; this step only adds the field. `graceMs`/`rejoinClaimTimeoutMs` comments trimmed here to stay accurate.)

- [ ] **Step 2: Add the `id` to the reconnect banner's main line**

In `index.html`, line 81, add an id:

```html
  <div class="rc-main" id="reconnect-main">RECONNECTING</div>
```

- [ ] **Step 3: Restyle `#reconnect` to a non-blocking top banner**

In `game/style.css`, replace the `#reconnect` and `#reconnect.show` rules (342-357) so it is a top banner (mirroring `#downed`), not a full-screen dimmed modal. Keep the `.rc-main`/`.rc-sub` rules (358-371) as-is:

```css
#reconnect {
  position: fixed;
  left: 0;
  right: 0;
  top: 8%;
  z-index: 60;
  display: none;
  pointer-events: none;
  text-align: center;
}
#reconnect.show {
  display: block;
}
```

(`top: 8%` sits above `#downed`'s `top: 18%` so a downed-then-dropped player doesn't overlap the two banners. `pointer-events: none` keeps it non-blocking over the frozen frame.)

- [ ] **Step 4: Add reconnect state + banner helpers + `cancelReconnect` in `main.ts`**

In `game/main.ts`, near the other module-scope session vars (e.g. beside `startingSingleRun` / `spritesLoaded` around 83-85), add the reconnect state and helpers. Ensure `CONFIG`, `Client`, `createArenaLink`, `arenaUrl`, `Net`, `getState`, `toTitle`, `showLoadError`, `el`, and `reconnectDelay` are imported (add `import { reconnectDelay } from "../sim/net/reconnect";`, `import type { PeerLink } from "./net/link";`, and confirm `toTitle` is imported from `./game`).

```typescript
// --- Arena auto-reconnect (M-C) ---------------------------------------------------------------
// A transient WS drop suspends the client and redials with backoff, replaying our {pid,nonce} so
// the DO re-attaches the held body in place (within graceMs) — else a fresh slot. Drop detection:
// PRIMARY = the WS onClose/onError (deterministic); BACKSTOP = the frame-loop starvation watchdog
// (a half-open socket that stays open but silent). The DO — not the client — decides in-place vs
// fresh via the grace window; hello.resumed reports which.
//
// `currentLink` is the single source of truth for "which link's events matter". Every link's
// onClose checks `link === currentLink` and ignores superseded links; startReconnect/onAttemptFail
// null it out BEFORE closing a link so that close's own onClose can't re-enter the state machine.
let reconnectId: { pid: number; nonce: string } | null = null; // our identity, persisted from Hello
let currentLink: PeerLink | null = null; // the live/attempt link; stale links' events are ignored
let reconnecting = false; // true from drop-detected until resume/give-up (guards re-entry + watchdog)
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // pending backoff wait
let attemptTimer: ReturnType<typeof setTimeout> | null = null; // pending per-attempt open+Hello budget
const arenaCode = (): string => new URLSearchParams(location.search).get("arena") ?? "MAIN";

function showReconnectBanner(attempt: number, max: number): void {
  el("reconnect-main").textContent = "RECONNECTING";
  el("reconnect-sub").textContent = `attempt ${attempt} / ${max}`;
  el("reconnect").classList.add("show");
}
function hideReconnectBanner(): void {
  el("reconnect").classList.remove("show");
}
function flashRespawnNote(): void {
  // grace exceeded → we came back as a fresh body at the fortress. Brief neutral note, then hide.
  el("reconnect-main").textContent = "RECONNECTED";
  el("reconnect-sub").textContent = "respawned at the fortress";
  el("reconnect").classList.add("show");
  setTimeout(hideReconnectBanner, 2500);
}

/** Cancel any in-flight reconnect (timers + flag). Called on teardown (endCoop) and on success. */
function cancelReconnect(): void {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  if (attemptTimer !== null) clearTimeout(attemptTimer);
  reconnectTimer = null;
  attemptTimer = null;
  reconnecting = false;
  reconnectAttempt = 0;
}
```

- [ ] **Step 5: Add the reconnect driver in `main.ts`**

Below the helpers from Step 4, add the driver. The `currentLink` identity guard is what keeps a
second drop (or `suspend()` synchronously closing the dropped link) from re-entering the state
machine and spawning parallel backoff loops — read the inline notes carefully.

```typescript
/** Wire a link's close so ONLY the current link's death acts: an attempt link dying → next backoff;
 *  a live (already-resumed) link dying → begin a new reconnect. Superseded links are ignored.
 *  INVARIANT: only ever call this on a FRESH link (createArenaLink result). wsLink.onClose fires the
 *  callback synchronously if the link is already closed — calling this on a closed link would
 *  re-enter the state machine. (Current callers pass only just-created links, so this holds.) */
function wireLinkClose(link: PeerLink): void {
  link.onClose(() => {
    if (link !== currentLink) return; // an old/superseded link closing → ignore
    if (reconnecting) onAttemptFail(link); // this attempt's link died → next backoff
    else startReconnect(); // a live link dropped → begin reconnect
  });
}

/** A drop was detected while playing. Suspend the client, show the banner, start the backoff loop.
 *  Idempotent — a second trigger (onClose + watchdog) while already reconnecting is ignored. */
function startReconnect(): void {
  if (reconnecting || !Net.client || !reconnectId) return;
  reconnecting = true;
  reconnectAttempt = 0;
  currentLink = null; // detach FIRST: the dropped link's onClose (fired by suspend) must not re-enter
  if (attemptTimer !== null) {
    clearTimeout(attemptTimer);
    attemptTimer = null;
  }
  Net.client.suspend(); // live=false, close the dead/half-open link, drop stale buffers
  scheduleAttempt();
}

/** Wait this attempt's backoff, then dial. Past the last backoff step → give up to the title. */
function scheduleAttempt(): void {
  const delay = reconnectDelay(reconnectAttempt, CONFIG.net.reconnect.backoffMs);
  if (delay === null) {
    // exhausted every attempt → the arena is unreachable. Tear down and return to the title so the
    // player can re-Start (endCoop nulls currentLink + disposes the client). No stacked overlay.
    cancelReconnect();
    hideReconnectBanner();
    endCoop();
    toTitle();
    return;
  }
  showReconnectBanner(reconnectAttempt + 1, CONFIG.net.reconnect.backoffMs.length);
  reconnectTimer = setTimeout(tryAttempt, delay);
}

/** One reconnect attempt: dial a fresh link (now `currentLink`), rebind (replays our rejoin token on
 *  open), and arm a per-attempt timeout. Success → onResumed (Step 6); failure → the link closing
 *  (wireLinkClose → onAttemptFail) or the timeout firing. */
function tryAttempt(): void {
  reconnectTimer = null;
  if (!Net.client || !reconnectId) return;
  const link = createArenaLink(arenaUrl(arenaCode()));
  currentLink = link;
  wireLinkClose(link);
  attemptTimer = setTimeout(() => {
    attemptTimer = null;
    if (link === currentLink && reconnecting) onAttemptFail(link); // opened-but-no-Hello / stuck dial
  }, CONFIG.net.reconnect.attemptTimeoutMs);
  Net.client.rebind(link, reconnectId); // wires the link + replays {t:"rejoin",...} on open
}

/** This attempt failed (link closed or timed out). Detach + close it, then schedule the next. Guarded
 *  so the close-and-timeout double-fire (or a stale link) can't advance the loop twice. */
function onAttemptFail(link: PeerLink): void {
  if (link !== currentLink || !reconnecting) return;
  currentLink = null; // detach BEFORE closing so this close's onClose no-ops
  if (attemptTimer !== null) {
    clearTimeout(attemptTimer);
    attemptTimer = null;
  }
  try {
    link.close();
  } catch {
    /* already closing */
  }
  reconnectAttempt++;
  scheduleAttempt();
}
```

- [ ] **Step 6: Wire the `onIdentity`/`onResumed` hooks + `currentLink` + post-start `onClose` in `startSingleRun`**

In `game/main.ts` `startSingleRun` (101-151), (a) route the initial link's close through the same
state machine once the game has started, (b) record it as `currentLink`, and (c) pass the new hooks
to the `Client`.

The `link.onClose` block (134-139) becomes (note: the initial link keeps its pre-start "Disconnected"
branch; after start it uses the same `currentLink`/`reconnecting` routing as `wireLinkClose`):

```typescript
  link.onClose(() => {
    if (link !== currentLink) return; // superseded (a stale link) → ignore
    if (!arenaStarted) {
      clearTimeout(connectTimer);
      showLoadError("Disconnected from the arena.");
      return;
    }
    if (reconnecting) onAttemptFail(link);
    else startReconnect(); // post-start drop → auto-reconnect (primary trigger)
  });
  currentLink = link; // the initial link is the first "current" link
```

The `Client` construction (140-150) gains `onIdentity` + `onResumed`:

```typescript
  Net.client = new Client(
    link,
    () => {
      arenaStarted = true;
      clearTimeout(connectTimer);
      hide("loading");
    },
    {
      onIdentity: (pid, nonce) => {
        reconnectId = { pid, nonce }; // persist for rebind (updated on a fresh-slot reconnect too)
      },
      onResumed: (resumed) => {
        if (!reconnecting) return; // initial connect → not a reconnect; ignore
        // success: clear timers + `reconnecting`. currentLink STAYS = the winning link (it is now
        // the live gameplay link); a future drop of it routes through wireLinkClose → startReconnect.
        cancelReconnect();
        if (resumed) hideReconnectBanner(); // re-attached in place → silent resume
        else flashRespawnNote(); // grace exceeded → fresh body at the fortress
      },
      onRoomFull: () => showLoadError("This arena is full (12 players). Try again later."),
    },
  );
```

- [ ] **Step 7: Add the starvation watchdog to the render loop**

In `game/main.ts` `frame()`, inside the `if (Net.mode === "client")` block (after `Net.client?.render(...)` at ~329, before the `sysFx` block), add the backstop watchdog:

```typescript
      // Backstop drop detection: a half-open WS can stay open but silent (no onClose). If no
      // snap AND no rel has arrived for snapStarvationMs while running, treat the link as dead.
      // (A clean close fires onClose → startReconnect directly; this only catches the silent case.)
      if (st.running && Net.client && !reconnecting) {
        const idle = performance.now() - Net.client.lastActivityMs();
        if (idle > CONFIG.net.reconnect.snapStarvationMs) startReconnect();
      }
```

- [ ] **Step 8: Cancel reconnect on teardown**

In `game/main.ts` `endCoop` (76-79), cancel any in-flight reconnect and clear the banner + identity so a restart/tab-close doesn't leave a dangling loop:

```typescript
function endCoop(): void {
  cancelReconnect();
  hideReconnectBanner();
  reconnectId = null;
  currentLink = null;
  Net.client?.dispose();
  Net.client = null;
}
```

- [ ] **Step 9: Type-check, lint, build**

Run: `bun run typecheck && bun run lint && bun run build`
Expected: PASS.

- [ ] **Step 10: Smoke the in-grace path (devtools Offline)**

> Rubber-duck fix: `Net` is a module-local import, **not** exposed on `window`, so a console `Net.client.debugDrop()` would throw `Net is not defined`. Use the real transport drop instead (the existing `debugDrop()` hook stays as a code-level test affordance but is not wired to the console/UI in this milestone — leave it).

Run: `bun run dev:coop`, open the game (`?arena=MAIN`), Start, and once playing toggle devtools **Network → Offline** for ~3s, then back Online. A solo client is fine here: per the CF lifecycle grounding, the DO survives the 20s grace (≪ the 70-140s eviction floor), so it re-holds your body.
Expected: the RECONNECTING banner shows briefly (non-blocking, over the frozen frame), then the game resumes **in place** (body position/hp/gear unchanged) within a few seconds — confirming onClose → suspend → backoff → rebind → in-grace re-attach → silent resume. No spurious NIGHT/DAY banner, no phantom kill-burst.

- [ ] **Step 11: Commit**

```bash
git add sim/config.ts game/main.ts index.html game/style.css
git commit -m "feat(net): 2b①C-2 — drive arena auto-reconnect (onClose + watchdog, backoff rebind, banner)"
```

---

## Task 4: Reconnect comment triage (deferred from PR1)

**Files:**
- Modify: `sim/config.ts:26-30` (reconnect block header — WebRTC two-channel → single-WS reality)
- Modify: `game/net/client.ts` (the `live`/`lastActivityMs` two-channel comments + `suspend`/`rebind`/`onIdentity`/`debugDrop` "host"/"P2P" language)

**Interfaces:** none — comment-only. Gate = `bun run typecheck && bun run lint && bun run build`.

- [ ] **Step 1: Rewrite the `sim/config.ts` reconnect header**

In `sim/config.ts`, the comment above the `reconnect` block (26-30) currently describes WebRTC's two channels + a "host". Replace with:

```typescript
    // Client auto-reconnect (M-C). On one multiplexed WebSocket, snap and rel die together, so a
    // drop is a single "WS silent" condition: a clean close fires onClose (primary trigger), and a
    // half-open socket is caught by the frame-loop starvation watchdog (snapStarvationMs). The DO
    // holds a dropped player's body "absent" for graceMs so a quick rejoin re-attaches in place (no
    // respawn); past graceMs the body is retired → the reconnect lands as a fresh spawn.
```

- [ ] **Step 2: Rewrite the `client.ts` two-channel + host reconnect comments**

In `game/net/client.ts`:

- The `live`/`lastSnapAt`/`lastRelAt` field comment (81-86, currently "reconnect (P4): … a true drop = BOTH go quiet") →

```typescript
  // Reconnect (M-C): `live` gates send/render/callbacks while suspended between links.
  // lastSnapAt/lastRelAt feed lastActivityMs(), the half-open-socket backstop in main.ts's loop
  // (a clean close is caught by the link's onClose directly). On one WS, snap+rel die together.
```

- The `lastActivityMs()` doc (245-249, "Most-recent activity on EITHER channel … both have been silent") →

```typescript
  /** Most-recent activity on the WS (snap or rel). main.ts's watchdog reconnects when this goes
   *  stale past snapStarvationMs — the backstop for a half-open socket that never fires onClose. */
```

- The `debugDrop()` doc (251) "force-drop the P2P link" → "force-drop the arena WebSocket".
- The `wire()` doc (105-107) "rebind() on a reconnected link — so a dropped client resumes the SAME Client instance (never re-running the destructive startClientGame)" is accurate; leave it. The `onIdentity`/`rejoin` hook docs (91-98) say "P2P open"/"host" — change "P2P open" → "arena (re)connect" and "host" → "DO". The `onVersionMismatch`/`onRoomFull` docs (96-99) mention "host … manual-SDP" / "host + 3" — change "host" → "DO" and "host + 3" → "at capacity".

(Confirm the exact current wording at each line before editing; the intent is: no "host"/"P2P"/"two channels" language remains in the reconnect-related comments.)

- [ ] **Step 3: Gate**

Run: `bun run typecheck && bun run lint && bun run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add sim/config.ts game/net/client.ts
git commit -m "chore(net): 2b①C-2 — reconnect comment triage (single-WS reality)"
```

---

## Final verification

- [ ] **Full gate:** `bun run typecheck && bun run test && bun run lint && bun run build`
- [ ] **Worker type-check:** the `worker` CI check (root-pinned `tsc` against `worker/tsconfig`) passes.
- [ ] **Playtest — the M-C feel gate (reconnect under a REAL WS drop, not just `debugDrop`):** `bun run dev:coop`.
  - **In-grace, in-place resume (the core case):** open **two** clients on `?arena=MAIN` (the second keeps the DO alive when the first drops). On client A, use devtools **Network → Offline** (or throttle to Offline) for ~3-5s while playing, then back Online. Expect: RECONNECTING banner (non-blocking, over the frozen frame) → within grace the body **re-attaches in place** (same position/hp/gear) → banner vanishes silently. No spurious NIGHT/DAY banner, no phantom kill-burst on the first snapshot back.
  - **Grace-exceeded → fresh spawn:** repeat but stay Offline **>20s** (client B keeps the arena cycling). Back Online → the reconnect lands after the body was retired → you spawn **fresh at the fortress** and see the brief "RECONNECTED · respawned at the fortress" note. Run-scoped progress (money/upgrades/queued deployables) is reset (expected; banked SALVAGE meta persists).
  - **Give-up → title:** single client only; **stop the worker** (Ctrl-C the wrangler side of `dev:coop`) mid-play. Expect: RECONNECTING banner cycling attempts, then after the last backoff → back to the title with "Disconnected from the arena." (no frozen limbo).
  - **Half-open backstop:** confirm the watchdog path by observing that even if the OS/devtools drop doesn't fire a clean close, the banner still appears within ~`snapStarvationMs` (2.5s) of the snap stream stalling.
  - **Feel:** the banner is unobtrusive; recovery is quick and doesn't jar; no double-trigger fl; no input/audio glitch on resume.

## Notes / open items for the rubber-duck

- **Backoff vs grace (the user's "実測整合"):** resolved by design — the client does **not** fit within grace; the DO decides in-place-vs-fresh at the moment it processes the rejoin (`graceMs` from `goneAt`). So `backoffMs` total (15s of delays + up to 4×`attemptTimeoutMs`) may exceed grace harmlessly; a late success is just a fresh spawn with the note. Confirm this reads right in playtest.
- **First-attempt delay:** `reconnectDelay(0)` = `backoffMs[0]` = 1000ms, so even a clean close waits ~1s before the first redial (debounces WS flapping). If playtest finds this sluggish, prepend an immediate attempt — flagged, not pre-decided.
- **Solo-drop arena liveness:** verified in grounding that `onClose` keeps the peer entry + doesn't `stop()`, so a lone dropper's arena survives the grace window. Re-confirm in playtest that a solo Offline→Online within grace re-attaches (arena didn't hibernate/reset — 2b② persistence not yet built).
- **`attemptTimer` vs a slow-but-alive Hello:** a 4s `attemptTimeoutMs` closes an attempt whose Hello is merely slow; the DO's `onClose` then re-holds the body (fresh `goneAt`) so the next attempt still finds it. Confirm no thrash on a laggy link.
