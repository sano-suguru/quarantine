# Co-op Lobby Entry-Control Visibility & Single Connection Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the co-op JOIN lobby's entry controls (room-code input + JOIN button, manual-SDP body) a pure function of lobby state so nothing is ever "dead but visible", and guarantee only one client connection flow is live at a time.

**Architecture:** Two new `wireCoop`-scope helpers in `game/main.ts`: `syncEntryVisibility()` becomes the single writer of `#lobby-room-join` and the manual body's `display`, driven from the existing state funnels; `resetJoinEntry()` abandons any in-flight room-code attempt (via the session epoch) when the manual fallback opens or the lobby is re-entered. Two companion correctness fixes make the epoch-based arbitration actually hold (guard the room-code `catch`; close the signaling socket on link-close).

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`, `noUnusedLocals/Params`, `verbatimModuleSyntax`), Bun scripts, Biome, WebRTC. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-02-lobby-entry-visibility-design.md` (approved, 2× rubber-duck reviewed).

## Global Constraints

- **Single-player must stay byte-for-byte unchanged.** None of these changes touch the SP path.
- **Host authoritative paths unchanged.** Host manual SDP stays a one-shot, single-peer flow.
- `game/main.ts` and `game/net/*` are **playtest-gated and excluded from unit coverage** — the automated gate for every task is `bun run typecheck` + `bun run lint`; the final acceptance gate is the 2-tab playtest matrix in Task 5. Do **not** claim the feature done on typecheck alone.
- Biome: 2-space indent, double quotes, semicolons, trailing commas, 100-col width. `import type` required for type-only imports.
- Every commit ends with the trailer: `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- Branch: `feat/multiplayer-waiting-ux` (already checked out).

---

## File Structure

- `game/net/signaling.ts` — **modify.** `joinRoom()` closes its relay WebSocket on link-close as well as link-open. Self-contained; releases the room slot when a join is abandoned/fails before P2P open.
- `index.html` — **modify.** Add `id="lobby-manual-body"` to the single `.lobby-wrap` inside `#lobby-manual` so main.ts can toggle it.
- `game/main.ts` (`wireCoop` scope) — **modify.** Add hoisted state `lobbyKind`, `lastManualState`, element handle `manualBody`; add `syncEntryVisibility()` and `resetJoinEntry()`; wire them into the state funnels and toggle handlers; remove the two ad-hoc `roomJoin.style.display` writes; add the epoch guard to the room-code `catch`.

Task order isolates the two independent companion fixes (Tasks 1–2) first, then lands the visibility invariant I1 (Task 3), then the single-flow invariant I2 (Task 4), then playtest (Task 5). Each of Tasks 1–4 is independently type-checkable and shippable.

---

## Task 1: Release the relay slot when a room-code join is abandoned before P2P open

**Files:**
- Modify: `game/net/signaling.ts:145-155` (inside `joinRoom()`)

**Interfaces:**
- Consumes: `PeerLink.onOpen(cb)` / `onClose(cb)` (both push into callback arrays — multiple handlers allowed; `link.close()` → `pc.close()` fires `closeCbs`).
- Produces: no signature change. Behavior: the signaling `ws` is now closed on link-close, not only link-open.

**Why:** Today `joinRoom()` closes its WebSocket only via `link.onOpen(() => ws.close())`. If the attempt is abandoned (Task 4's arbitration) or the NAT `failTimer` fires **before** the P2P link opens, disposing the `PeerLink` never closes the still-open signaling socket, so the worker keeps counting the client as a live room occupant (`worker/room.ts` removes clients only on WS close) — leaking one of the 3 client slots. This also repairs a pre-existing latent leak on the NAT-timeout path.

- [ ] **Step 1: Add the link-close handler**

In `game/net/signaling.ts`, inside the `if (m.t === "offer")` async block, immediately after the existing `link.onOpen(() => ws.close());` line, add an `onClose` handler:

```ts
          link.onOpen(() => ws.close()); // signaling no longer needed once P2P is up
          link.onClose(() => ws.close()); // abandoned/failed before open: release the relay slot
          settled = true;
```

(The `ws.close()` inside `PeerLink` is idempotent-safe: `close()` is wrapped in `try/catch` at the call sites, and calling `WebSocket.close()` twice is harmless.)

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: both pass, no new errors.

- [ ] **Step 3: Commit**

```bash
git add game/net/signaling.ts
git commit -m "fix(net): close signaling socket on link-close to release relay slot

joinRoom() closed its relay WebSocket only on link.onOpen, so abandoning or
timing out a join before P2P open left the socket open and the worker kept
counting the client as a room occupant (leaking one of the 3 client slots).
Close it on link.onClose too; also fixes a pre-existing NAT-timeout leak.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Guard the room-code `catch` against a stale (abandoned) attempt

**Files:**
- Modify: `game/main.ts:941-961` (the `catch` of the `join()` closure inside `openJoinLobby`)

**Interfaces:**
- Consumes: `isCoopEpochCurrent(epoch: number): boolean` (already imported and used by the sibling callbacks) and the `epoch` captured at `const epoch = coopEpoch();` (~line 860).
- Produces: no signature change. Behavior: a late `joinRoom()` rejection no longer writes lobby state after the epoch has been bumped (i.e. after the manual fallback took over or the lobby was left/re-entered).

**Why:** The `onRoomFull`, `failTimer`, `link.onOpen`, and `link.onClose` callbacks each early-return on `!isCoopEpochCurrent(epoch)`, but the `catch` does not. Task 4 bumps the epoch to abandon a room-code attempt when manual opens; without this guard, a `joinRoom()` that rejects *after* that switch would call `setClientLobby({ failed | lost })` and clobber the manual flow. The resolve path is already safe (`becomeClient(epoch, …)` returns `null` and closes the link on a stale epoch).

- [ ] **Step 1: Add the epoch guard as the first line of `catch`**

Change the start of the `catch` block from:

```ts
      } catch (err) {
        roomGo.disabled = false;
        const msg = err instanceof Error ? err.message : String(err);
```

to:

```ts
      } catch (err) {
        if (!isCoopEpochCurrent(epoch)) return; // manual took over / lobby left — don't clobber it
        roomGo.disabled = false;
        const msg = err instanceof Error ? err.message : String(err);
```

- [ ] **Step 2: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add game/main.ts
git commit -m "fix(coop): epoch-guard the room-code join() catch

The onRoomFull/failTimer/onOpen/onClose callbacks all early-return on a stale
epoch, but the join() catch did not — a late joinRoom() rejection could write
setClientLobby({failed|lost}) over a manual flow that has since taken over.
Guard the catch the same way, prerequisite for abandon-on-open arbitration.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: `syncEntryVisibility()` as the sole writer of entry-control visibility (I1)

**Files:**
- Modify: `index.html:191` (add `id="lobby-manual-body"`)
- Modify: `game/main.ts` — element grab (~488), hoisted state (~498), `syncEntryVisibility()` (new), `openLobby` (~602-616), `setClientLobby` (~575-600), host `setManualState` (~701-704) + host `manual.ontoggle` (~705-713), client `setManualState` (~973-976) + client `manual.ontoggle` (~977-978)

**Interfaces:**
- Consumes: existing handles `roomJoin` (`el("lobby-room-join")`), `manual` (`HTMLDetailsElement`); existing `lastClientLobbyState: ClientLobby | null`; existing `ManualLobbyDisplayState` type (already imported).
- Produces:
  - `manualBody: HTMLElement` — `el("lobby-manual-body")`.
  - `let lobbyKind: "host" | "join"` — set in `openLobby`.
  - `let lastManualState: ManualLobbyDisplayState | null` — set by **both** `setManualState` funnels; owned by them exclusively.
  - `const syncEntryVisibility: () => void` — the sole writer of `roomJoin.style.display` and `manualBody.style.display`.

**Why:** Entry-control visibility is currently scattered (`openLobby` sets `roomJoin`; the client `manual.ontoggle` sets `roomJoin`; nothing hides them on connect). Centralize into one state-derived writer so no control is ever dead-but-visible.

- [ ] **Step 1: Add the `id` to the manual body in index.html**

Change `index.html:191` from:

```html
    <div class="lobby-wrap" style="margin-top:10px;">
```

to:

```html
    <div id="lobby-manual-body" class="lobby-wrap" style="margin-top:10px;">
```

- [ ] **Step 2: Grab the `manualBody` handle**

In `game/main.ts`, right after `const manual = el<HTMLDetailsElement>("lobby-manual");` (~488), add:

```ts
  const manualBody = el("lobby-manual-body"); // the manual SDP entry controls (hidden once connected)
```

- [ ] **Step 3: Add hoisted state**

Immediately after `let lastClientLobbyState: ClientLobby | null = null;` (~498), add:

```ts
  let lobbyKind: "host" | "join" = "join"; // set in openLobby(); gates the room-code entry row
  let lastManualState: ManualLobbyDisplayState | null = null; // owned by the setManualState funnels
```

- [ ] **Step 4: Add `syncEntryVisibility()`**

Insert this helper just above `const setClientLobby = (s: ClientLobby): void => {` (~575):

```ts
  // Sole writer of the entry controls' visibility (I1): a pure function of lobby state. The room-code
  // row shows only in Join mode, only while manual is closed, and only when idle or in a retryable
  // state (null / failed / lost) — hidden while actively connecting or connected. The manual body's
  // entry controls are spent once a manual peer/link is connected.
  const syncEntryVisibility = (): void => {
    const k = lastClientLobbyState?.k;
    const busy = k === "joining" || k === "linking" || k === "connected";
    roomJoin.style.display = lobbyKind === "join" && !manual.open && !busy ? "flex" : "none";
    manualBody.style.display = lastManualState?.k === "connected" ? "none" : "";
  };
```

- [ ] **Step 5: Drive it from `setClientLobby`**

Append a `syncEntryVisibility()` call as the **last** statement of `setClientLobby`, so every client transition re-derives visibility. This is what makes the `failed` case (which sets `manual.open = true` programmatically) hide `#lobby-room-join` synchronously rather than relying on the async `toggle` event. Change the end of `setClientLobby`:

```ts
      default:
        assertNever(s);
    }
    syncEntryVisibility();
  };
```

- [ ] **Step 6: Make `openLobby` set `lobbyKind` + reset `lastManualState` and delegate to sync**

In `openLobby` (~602-616): remove the direct `roomJoin.style.display` write (line 607) and, after `manual.ontoggle = null;`, set `lobbyKind`, reset `lastManualState`, and call sync. Change:

```ts
  const openLobby = (kind: "host" | "join"): void => {
    hide("start");
    hide("coop");
    show("lobby");
    roomHost.style.display = kind === "host" ? "flex" : "none";
    roomJoin.style.display = kind === "join" ? "flex" : "none";
    deploy.style.display = "none";
    squad.replaceChildren();
    wait.replaceChildren();
    setStatus("");
    out.value = "";
    inEl.value = "";
    manual.open = false;
    manual.ontoggle = null;
  };
```

to:

```ts
  const openLobby = (kind: "host" | "join"): void => {
    hide("start");
    hide("coop");
    show("lobby");
    roomHost.style.display = kind === "host" ? "flex" : "none";
    deploy.style.display = "none";
    squad.replaceChildren();
    wait.replaceChildren();
    setStatus("");
    out.value = "";
    inEl.value = "";
    manual.open = false;
    manual.ontoggle = null;
    lobbyKind = kind;
    lastManualState = null; // manual body starts shown; setManualState will hide it on connect
    syncEntryVisibility(); // sole writer of roomJoin + manualBody visibility (replaces the old direct write)
  };
```

(`roomHost` is intentionally still written directly — it is out of scope for `syncEntryVisibility`, which owns only `roomJoin` + `manualBody`.)

- [ ] **Step 7: Have both `setManualState` funnels own `lastManualState` + sync**

Client `setManualState` (~973-976) — change:

```ts
    const setManualState = (state: ManualLobbyDisplayState): void => {
      manualState = state;
      if (manual.open) renderLobbyWait(manualLobbyWaitModel(manualState));
    };
```

to:

```ts
    const setManualState = (state: ManualLobbyDisplayState): void => {
      manualState = state;
      lastManualState = state; // sole owner of lastManualState (drives manual-body visibility)
      if (manual.open) renderLobbyWait(manualLobbyWaitModel(manualState));
      syncEntryVisibility();
    };
```

Host `setManualState` (~701-704) — apply the identical change:

```ts
    const setManualState = (state: ManualLobbyDisplayState): void => {
      manualState = state;
      lastManualState = state; // sole owner of lastManualState (drives manual-body visibility)
      if (manual.open) renderLobbyWait(manualLobbyWaitModel(manualState));
      syncEntryVisibility();
    };
```

- [ ] **Step 8: Replace the client `manual.ontoggle`'s ad-hoc `roomJoin` write with a sync call**

Client `manual.ontoggle` (~977-978) — remove the direct `roomJoin.style.display` line and call sync instead. Change:

```ts
    manual.ontoggle = (): void => {
      roomJoin.style.display = manual.open ? "none" : "flex";
      guide.textContent = manual.open
```

to:

```ts
    manual.ontoggle = (): void => {
      syncEntryVisibility(); // roomJoin tracks manual.open via the sole writer
      guide.textContent = manual.open
```

- [ ] **Step 9: Add a sync call to the host `manual.ontoggle`**

Host `manual.ontoggle` (~705-713) sets `roomHost.style.display` (keep that — it owns `roomHost`) but must also re-derive `manualBody`/`roomJoin` visibility. Add a `syncEntryVisibility()` call right after the `roomHost.style.display` write. Change:

```ts
    manual.ontoggle = (): void => {
      roomHost.style.display = manual.open ? "none" : "flex";
      guide.textContent = manual.open
```

to:

```ts
    manual.ontoggle = (): void => {
      roomHost.style.display = manual.open ? "none" : "flex";
      syncEntryVisibility(); // keep manualBody/roomJoin derived from state (host: roomJoin stays hidden)
      guide.textContent = manual.open
```

- [ ] **Step 10: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: both pass. In particular, `lobbyKind`, `lastManualState`, and `manualBody` are all now read by `syncEntryVisibility()` (no `noUnusedLocals` error), and no stray `roomJoin.style.display` writes remain outside `syncEntryVisibility`.

- [ ] **Step 11: Verify the sole-writer invariant**

Run: `grep -n "roomJoin.style.display\|manualBody.style.display" game/main.ts`
Expected: exactly the two lines **inside** `syncEntryVisibility()` and nowhere else.

- [ ] **Step 12: Commit**

```bash
git add index.html game/main.ts
git commit -m "refactor(coop): single state-derived writer for lobby entry visibility (I1)

Route #lobby-room-join and the manual SDP body (#lobby-manual-body) through one
syncEntryVisibility() helper driven by lobby state, replacing the scattered
roomJoin.style.display writes in openLobby and the client manual.ontoggle.
Entry controls now hide once connecting/connected instead of lingering as
'dead but visible' (the pressable-but-inert JOIN button).

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: `resetJoinEntry()` — one live connection flow at a time (I2)

**Files:**
- Modify: `game/main.ts` — `resetJoinEntry()` (new, above `openJoinLobby` ~838), `openJoinLobby` (~838-849), client `manual.ontoggle` open branch (~991-996)

**Interfaces:**
- Consumes: `bumpCoopEpoch()` (from `game/net/session.ts`, already imported), `Net` (`.client`/`.mode`), `coopRoomCode`, `lastClientLobbyState`, `roomGo`, and `syncEntryVisibility()` from Task 3.
- Produces: `const resetJoinEntry: () => void` — abandons any in-flight room-code attempt and resets entry to idle.

**Why:** The room-code and manual client paths can otherwise run concurrently. Opening the manual fallback (or re-entering the lobby) must abandon the room-code attempt so a late resolve/reject can't resurrect it or leak a second `Net.client`. The abandon rides the session epoch — the codebase's only cross-`await` cancellation primitive.

- [ ] **Step 1: Add `resetJoinEntry()`**

Insert just above `const openJoinLobby = (prefill?: string): void => {` (~838):

```ts
  // Abandon any in-flight room-code attempt and reset the join entry to idle (I2: one live flow).
  // Rides the session epoch — the only cross-await cancellation primitive — so a late joinRoom()
  // resolve (becomeClient returns null) or reject (guarded catch) can't resurrect the abandoned
  // attempt. Idempotent and safe on fresh entry (no in-flight flow to invalidate).
  const resetJoinEntry = (): void => {
    bumpCoopEpoch();
    Net.client?.dispose();
    Net.client = null;
    Net.mode = "single";
    coopRoomCode = null; // disarm the reconnect watchdog for the abandoned room
    lastClientLobbyState = null;
    roomGo.disabled = false; // a fresh entry / retry is allowed again
  };
```

- [ ] **Step 2: Call it first in `openJoinLobby`, before `openLobby`**

In `openJoinLobby` (~838-849), replace the inline resets (`roomGo.disabled = false;` and `lastClientLobbyState = null;`) with a single `resetJoinEntry()` call placed **before** `openLobby("join")`. Ordering is load-bearing: `endCoop()` does not clear `lastClientLobbyState`, so a prior `connected` value survives a Back; `openLobby` calls `syncEntryVisibility()`, which would read that stale `connected` as `busy` and hide the fresh JOIN row. Resetting first guarantees a clean idle state.

Change:

```ts
  const openJoinLobby = (prefill?: string): void => {
    openLobby("join");
    role.textContent = "Joining";
    guide.textContent = "Enter the host's room code to connect.";
    roomInput.value = prefill ?? "";
    roomInput.focus();
    // Re-enable the Join button on every fresh entry — its re-entry guard (roomGo.disabled) is left
    // set after a SUCCESSFUL connect, and leaving via Back doesn't clear it, so a second visit's
    // click would otherwise be swallowed. This is the single re-enable point for the guard, mirroring
    // openCoopHub for the quick-match button.
    roomGo.disabled = false;
    lastClientLobbyState = null;
```

to:

```ts
  const openJoinLobby = (prefill?: string): void => {
    // Reset BEFORE openLobby: endCoop() doesn't clear lastClientLobbyState, so a prior "connected"
    // would survive a Back and make openLobby's syncEntryVisibility() hide the fresh JOIN row.
    // resetJoinEntry also re-enables roomGo (its guard is left set after a successful connect) and
    // abandons any in-flight attempt (idempotent no-op on a truly fresh entry).
    resetJoinEntry();
    openLobby("join");
    role.textContent = "Joining";
    guide.textContent = "Enter the host's room code to connect.";
    roomInput.value = prefill ?? "";
    roomInput.focus();
```

- [ ] **Step 3: Abandon-on-open in the client `manual.ontoggle` (guarded to live flows only)**

In the client `manual.ontoggle`, the open branch begins after the early `if (!manual.open) { … return; }`. Add the guarded abandon at the **top of the open branch**, immediately before the existing `clearTimeout(failTimer);`. The guard is required so the `failed` fallback — which sets `manual.open = true` programmatically and fires this same handler — is **not** reset to blank idle (only `joining`/`linking`/`connected` represent a live attempt worth abandoning).

Change (~991-992):

```ts
        return;
      }
      clearTimeout(failTimer);
```

to:

```ts
        return;
      }
      // abandon-on-open (I2): switching to manual kills a *live* room-code attempt so a late
      // resolve/reject can't resurrect it. Guarded to live states only — failed/lost/null are
      // already settled, and unconditionally resetting would erase the failed fallback's state.
      const liveK = lastClientLobbyState?.k;
      if (liveK === "joining" || liveK === "linking" || liveK === "connected") resetJoinEntry();
      clearTimeout(failTimer);
```

- [ ] **Step 4: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: both pass. `resetJoinEntry` is referenced by `openJoinLobby` and the client `manual.ontoggle` (no `noUnusedLocals`).

- [ ] **Step 5: Sanity-check the epoch import + `Net`/`coopRoomCode` symbols**

Run: `grep -n "bumpCoopEpoch\|coopRoomCode" game/main.ts | head`
Expected: `bumpCoopEpoch` is imported (top-of-file import from `./net/session`) and used in `resetJoinEntry`; `coopRoomCode` is the existing mutable lobby-scope binding (also assigned in `becomeClient`/`abandonClientAttempt`).

- [ ] **Step 6: Commit**

```bash
git add game/main.ts
git commit -m "fix(coop): single live join flow via resetJoinEntry (I2)

Opening the manual fallback (or re-entering the join lobby) now abandons any
in-flight room-code attempt through the session epoch + disposes Net.client,
so a late joinRoom() resolve/reject can't leak a ghost peer or a second client.
openJoinLobby resets before openLobby so a stale 'connected' can't hide the
fresh JOIN row; the manual.ontoggle abandon is guarded to live states so the
failed-NAT fallback keeps its state.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Playtest acceptance (2-tab manual verification)

**Files:** none (verification only).

**Why:** `game/main.ts` + `game/net/*` are playtest-gated. Typecheck/lint cannot prove lobby flow/feel — this matrix is the acceptance gate. Run two browser tabs (A = host, B = client) against `bun run dev:coop` (room-code path needs the signaling relay; one-time `cd worker && bun install`).

- [ ] **Step 1: Start the dev server + relay**

Run: `bun run dev:coop`
Expected: Vite on http://localhost:5173 and the wrangler signaling relay both start. Open two tabs. Enable `?netlog` on both to watch ICE/flow diagnostics.

- [ ] **Step 2: Walk the matrix** (each row must pass; A hosts, B joins)

1. **Join → connected:** B joins by code → on connect, the JOIN row (input + button) disappears; only the progress/waiting card + Back remain. A shows P2.
2. **Re-join after Back:** B connected → Back → re-open Join → the JOIN row is present and clickable; re-join succeeds (the earlier swallowed-click bug stays fixed).
3. **Open manual while still connecting:** B clicks JOIN, then opens "Connect manually" while `linking` → the room-code attempt is abandoned: **no ghost P2 on A**, and the relay room slot is released (re-check: a fresh third tab can still join; no false "room is full"). Manual body shows cleanly.
4. **Late resolve/reject after abandon:** repeat step 3 but with a slow/failing relay so `joinRoom()` resolves or rejects *after* manual opened → **no** spurious "connected"/"failed" over the manual flow; **no** second `Net.client` (check `netlog`).
5. **Close manual with no manual connect:** after step 3/4, close the `<details>` → the JOIN row reappears (idle) and re-join works.
6. **Manual connect → drop:** B connects via manual SDP → the manual body (textareas/buttons) hides, only the connected card shows; then drop the link → the manual body reappears for retry (error state).
7. **NAT failure fallback:** force the room-code P2P to time out (e.g. block P2P) → the manual fallback auto-opens, the JOIN row is hidden behind it with no flicker, and the failed message/card is visible (not blanked to idle).
8. **Host manual:** A opens manual → connects a manual peer → A's manual body hides (connected card only); A Back → open Join → clean idle entry (no stale host toggle leak, JOIN row shown).
9. **Single-player unaffected:** from the title, Start a single-player run → identical to before (no lobby/co-op code runs).

- [ ] **Step 3: Record the result**

If every row passes, the feature is accepted. If any row fails, capture the failing row + `netlog` output and return to `superpowers:systematic-debugging` before editing — do not patch blind.

- [ ] **Step 4: Whole-branch completion**

Once the matrix passes, the `feat/multiplayer-waiting-ux` branch (Phase-1 roster/re-join fixes + this Phase-2 work) is ready — proceed to `superpowers:finishing-a-development-branch` for merge/PR/cleanup.

---

## Self-Review

**Spec coverage:**
- I1 (visibility = f(state), sole writer) → Task 3 (`syncEntryVisibility`, all callers, both ad-hoc writes removed).
- I2 (single flow, abandon-on-open) → Task 4 (`resetJoinEntry`, guarded ontoggle, openJoinLobby ordering).
- Companion fix: epoch-guard `catch` → Task 2.
- Companion fix: signaling socket close on link-close → Task 1.
- index.html `id` → Task 3 Step 1.
- State→visibility table & host-lobby rule → realized by Task 3 Steps 4/6/9 (lobbyKind gates roomJoin; host roomJoin stays hidden; manualBody keyed on `lastManualState`).
- Playtest matrix (9 cases incl. rubber-duck edges) → Task 5.
- Non-goals honored: no CSS change, no framework, host manual stays one-shot, SP untouched.

**Placeholder scan:** none — every code step shows the exact before/after; every command has expected output.

**Type consistency:** `syncEntryVisibility` / `resetJoinEntry` names used identically across tasks; `lobbyKind: "host" | "join"`, `lastManualState: ManualLobbyDisplayState | null`, `manualBody: HTMLElement` consistent; `lastClientLobbyState.k` values (`joining`/`linking`/`connected`/`failed`/`lost`) match `ClientLobby`; `ManualLobbyDisplayState.k === "connected"` matches its usage at the connect sites.
