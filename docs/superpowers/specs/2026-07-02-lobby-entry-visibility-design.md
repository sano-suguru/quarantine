# Co-op lobby entry-control visibility & single connection flow

Date: 2026-07-02
Status: Approved (brainstorming) — pending spec review

## Problem

In the co-op JOIN lobby, the entry-input controls stay visible and interactive-looking
**after their purpose is served**:

- The room-code input (`#lobby-room-input`) + **JOIN** button (`#lobby-room-go`) remain on
  screen after the client has connected and is "waiting for host to deploy". The JOIN button
  in particular stays bright green but is functionally `disabled` (there is no `:disabled` CSS),
  so it *looks* pressable but does nothing — the exact "why is this button pressable?" confusion.
- The manual-SDP `<details id="lobby-manual">` textareas + buttons likewise stay live after a
  manual peer/link has connected.

A closely related defect (already fixed separately) was that after a successful connect + Back,
the `roomGo.disabled` re-entry guard was left set, silently swallowing a re-join click. That fix
re-enabled the button in `openJoinLobby`; this spec supersedes and generalizes it.

### Root cause

The lobby's **wait card** is state-driven through single funnels:

- `setClientLobby({ k })`, `k ∈ { joining, linking, connected, failed, lost }`
- `setManualState({ k })`, `k ∈ { codes, linking, connected, error }`

…but the **entry controls' visibility** is managed by *scattered, ad-hoc* logic that is decoupled
from that state:

- `openLobby(kind)` sets `roomJoin.style.display` (join vs host).
- The join-variant `manual.ontoggle` sets `roomJoin.style.display = manual.open ? "none" : "flex"`.
- **Nothing** hides the entry controls on `joining` / `linking` / `connected`, so they persist as
  "dead but visible".

A second, deeper issue surfaced during design review (rubber-duck): the JOIN lobby has **two
connection entry paths** (room-code and manual SDP) that can run **concurrently**. Opening the
manual `<details>` mid room-code attempt only does `clearTimeout(failTimer)` today — it does **not**
invalidate the pending `joinRoom()` / `link.onOpen` / `link.onClose` path. So a room-code link can
open *after* the user switched to manual, spuriously firing `setClientLobby({ connected })` and/or
letting a second `becomeClient()` overwrite `Net.client`, leaking the first link (a ghost peer on
the host). Visibility-only centralization cannot fix that — it needs **flow arbitration**.

## Goals

1. **Entry-control visibility is a pure function of lobby state**, written by exactly one place per
   control. No control is ever "dead but visible".
2. **At most one connection flow is live at a time.** Switching to the manual fallback abandons any
   in-flight/established room-code attempt (chosen policy: *abandon-on-open*).
3. No behavior change to single-player. No change to the host's authoritative paths.

## Non-goals

- No lobby UI framework / full state-machine rewrite (`game/main.ts` is playtest-gated; keep the
  change surgical).
- Host manual SDP stays a **one-shot, single-peer** flow (unchanged). Multi-peer manual add is out
  of scope.
- No CSS `:disabled` styling work — the controls are *removed* in states where they'd be dead, so a
  disabled visual is unnecessary.

## Design

### Invariants

- **I1 (visibility = f(state)):** `#lobby-room-join` and the manual body's `style.display` are each
  written by exactly one function, `syncEntryVisibility()`, deriving from the current lobby state.
- **I2 (single flow):** room-code and manual client attempts never run concurrently — entering
  manual abandons the room-code attempt via the session epoch.

### New wireCoop-scope state

```ts
let lobbyKind: "host" | "join" = "join";              // set in openLobby()
let lastManualState: ManualLobbyDisplayState | null = null; // set by both setManualState funnels
// (lastClientLobbyState already exists)
```

### `resetJoinEntry()` — abandon in-flight room-code attempt + reset entry to idle (I2)

```ts
const resetJoinEntry = (): void => {
  bumpCoopEpoch();          // invalidate the in-flight join()'s epoch-guarded awaits/callbacks so a
                            // late joinRoom()/onOpen can't resurrect the abandoned attempt
  Net.client?.dispose();    // drop any link becomeClient() already wired (host sees the drop)
  Net.client = null;
  Net.mode = "single";
  coopRoomCode = null;      // disarm the reconnect watchdog for the abandoned room
  lastClientLobbyState = null;
  roomGo.disabled = false;  // fresh entry / retry is allowed again
};
```

Rationale: the session **epoch** (`game/net/session.ts`) is this codebase's *only* cross-`await`
cancellation primitive — every lobby/join flow captures `coopEpoch()` and re-checks
`isCoopEpochCurrent()`. Bumping it is the consistent way to make an external actor (the manual
toggle, or a fresh lobby entry) invalidate an in-flight attempt. Disposing `Net.client` covers the
case where `becomeClient()` already wired a link before the abandon.

**Callers:**
- `openJoinLobby` — called as its **first statement, before `openLobby("join")`**, replacing the
  current inline `lastClientLobbyState = null` + `roomGo.disabled = false`. Ordering matters:
  `endCoop()` does **not** clear `lastClientLobbyState` (it is `wireCoop`-local), so a prior
  `connected` value survives a Back. If `openLobby` (which calls `syncEntryVisibility`) ran while
  `lastClientLobbyState` was still stale-`connected`, `busy` would be true and the fresh JOIN row
  would render hidden. Resetting **before** `openLobby` guarantees `syncEntryVisibility` derives from
  a clean idle state. (Fresh entry has no in-flight flow, so the abandon half is a harmless idempotent
  no-op.)
- The **client** `manual.ontoggle` **open** branch, at its top (before the `manualReady` build) —
  this is the *abandon-on-open* arbitration, **guarded** to fire only when a room-code attempt is
  actually live:

  ```ts
  const k = lastClientLobbyState?.k;
  if (manual.open && (k === "joining" || k === "linking" || k === "connected")) resetJoinEntry();
  ```

  The guard is required: the `failed` fallback opens `<details>` *programmatically*
  (`manual.open = true`), which fires this same `ontoggle`. An unconditional `resetJoinEntry()` would
  then null out the `failed` state and turn the auto-opened fallback into a blank idle entry. Only
  `joining`/`linking`/`connected` represent a live attempt worth abandoning; `failed`/`lost`/`null`
  are already settled (nothing in flight). Because the room-code attempt is dead whenever manual is
  open with a live flow, `syncEntryVisibility` never has to reason about a concurrent room-code
  connect.

Not used by the **host** `manual.ontoggle` (a different handler): the host has no room-code
"attempt" to abandon; opening manual there just prepares an additional peer offer.

### Companion fixes (required for I2 to actually hold)

Arbitration via the epoch only works if **every** post-`await` write-back in the room-code `join()`
respects the epoch, and if abandoning actually releases the relay slot. Two spots don't today:

1. **Un-guarded `catch` in `join()`** (`game/main.ts` ~941-960). The `onRoomFull`, `failTimer`,
   `link.onOpen`, and `link.onClose` callbacks all early-return on `!isCoopEpochCurrent(epoch)`, but
   the `catch` does not — a `joinRoom()` that **rejects late** (after manual was opened and the epoch
   bumped) would still call `setClientLobby({ failed | lost })`, clobbering the manual flow. Add the
   guard as the first line of the `catch`:

   ```ts
   } catch (err) {
     if (!isCoopEpochCurrent(epoch)) return; // manual took over / lobby left — don't clobber it
     roomGo.disabled = false;
     ...
   }
   ```

   (The resolve path is already safe: `becomeClient(epoch, …)` closes the link and returns `null`
   when the epoch is stale.)

2. **Signaling socket leak in `joinRoom()`** (`game/net/signaling.ts` ~145-155). The relay WebSocket
   is closed **only** on `link.onOpen(() => ws.close())`. If the attempt is abandoned (or the NAT
   `failTimer` fires) **before** the P2P link opens, disposing/closing the `PeerLink` never closes
   the still-open signaling socket, so the worker keeps counting the client as a live room occupant
   (`worker/room.ts` removes clients only on WS close) — leaking one of the 3 client slots and
   risking a false "room is full". Close the socket on link-close too (both callbacks are supported —
   `onOpen`/`onClose` push into arrays, and `link.close()` → `pc.close()` fires `closeCbs`):

   ```ts
   link.onOpen(() => ws.close());   // P2P up: signaling no longer needed
   link.onClose(() => ws.close());  // abandoned/failed before open: release the relay slot
   ```

   This also repairs a **pre-existing latent leak** on the NAT-timeout path, independent of this
   feature.

### `syncEntryVisibility()` — the sole writer of both controls' visibility (I1)

```ts
const syncEntryVisibility = (): void => {
  const k = lastClientLobbyState?.k;
  const busy = k === "joining" || k === "linking" || k === "connected";
  // room-code entry row: only in Join mode, only when manual is closed, and only while idle or
  // in a retryable state (null / failed / lost) — hidden while actively connecting or connected.
  roomJoin.style.display = lobbyKind === "join" && !manual.open && !busy ? "flex" : "none";
  // manual body: its entry controls are spent once a manual peer/link is connected.
  manualBody.style.display = lastManualState?.k === "connected" ? "none" : "";
};
```

`manualBody` = the single `.lobby-wrap` inside `#lobby-manual` (gets a new id `lobby-manual-body`).
Toggling the whole wrap preserves the client flow's existing internal `#lobby-send` show/hide logic
(we never touch it here).

**Callers (every place state can change):**
- `openLobby` — after setting `lobbyKind` (and after resetting `manual.open=false`,
  `lastManualState=null`, `manualBody.style.display=""`).
- `setClientLobby` — appended at its end, so **every** client transition re-derives visibility.
  This is what satisfies rubber-duck #2: the `failed` case sets `manual.open = true`
  *programmatically*, then the trailing `syncEntryVisibility()` hides `#lobby-room-join`
  **synchronously** — we do **not** rely on the async `toggle` event as the source of truth.
- both `setManualState` funnels — after updating `lastManualState`. `setManualState` is the **sole
  owner** of `lastManualState`; the direct `renderLobbyWait(manualLobbyWaitModel(...))` calls inside
  `manual.ontoggle` are display-only and never render the `connected` state, so they don't need to
  touch `lastManualState`.
- both `manual.ontoggle` handlers — after toggling (so `#lobby-room-join` tracks `manual.open`).

### Replaced ad-hoc writes

- `openLobby`'s direct `roomJoin.style.display = kind === "join" ? "flex" : "none"` → removed;
  `syncEntryVisibility()` (gated by `lobbyKind`) is now the sole writer.
- The join `manual.ontoggle`'s `roomJoin.style.display = manual.open ? "none" : "flex"` → removed;
  replaced by `resetJoinEntry()` (on open) + `syncEntryVisibility()`.

## State → visibility table (client Join lobby)

| Lobby situation                         | `lastClientLobbyState.k` | manual.open | `#lobby-room-join` | manual body |
| --------------------------------------- | ------------------------ | ----------- | ------------------ | ----------- |
| Fresh entry / idle                      | null                     | false       | shown              | shown       |
| Awaiting relay answer                   | joining                  | false       | hidden             | shown       |
| Establishing P2P                        | linking                  | false       | hidden             | shown       |
| Connected, waiting for host             | connected                | false       | hidden             | shown       |
| P2P failed (auto-opens manual fallback) | failed                   | true        | hidden             | shown       |
| Dropped / roomfull / version / hostgone | lost                     | false       | shown (retry)      | shown       |
| Manual opened, live room-code abandoned | null (reset)             | true        | hidden             | shown       |
| Manual peer/link connected              | connected                | true        | hidden             | **hidden**  |
| Manual dropped → error (retry)          | lost                     | true        | hidden             | shown       |

Note the manual rows: the client manual flow also drives `setClientLobby` — success calls
`setClientLobby({ connected })` and a drop calls `setClientLobby({ lost })` (`game/main.ts`
~1050-1070) — so `lastClientLobbyState.k` is `connected`/`lost`, **not** `null`, on those rows. It
doesn't affect `#lobby-room-join` (hidden regardless because `manual.open` is true) or the manual
body (keyed on `lastManualState.k`); the column is filled in for accuracy. The `null (reset)` row is
the guarded abandon-on-open case, which only fires from a live `joining`/`linking`/`connected`
room-code attempt.

Host lobby: `lobbyKind === "host"` ⇒ `#lobby-room-join` always hidden; `manualBody` hides on host
manual `connected` (one-shot).

## Affected files

- `game/main.ts` — add `lobbyKind`, `lastManualState`, `resetJoinEntry()`, `syncEntryVisibility()`;
  wire the callers; remove the two replaced ad-hoc `roomJoin.style.display` writes; `manualBody`
  handle; add the epoch guard to the `join()` `catch`. ~30 lines net.
- `game/net/signaling.ts` — close the relay WebSocket on `link.onClose` too (release the room slot
  when a join is abandoned/fails before P2P open). ~1 line.
- `index.html` — add `id="lobby-manual-body"` to the `.lobby-wrap` inside `#lobby-manual`.
- No CSS change.

## Testing / validation

`game/main.ts` is playtest-verified and excluded from unit coverage — validation is typecheck +
lint + a 2-tab manual playtest. Playtest matrix (incl. rubber-duck edge cases):

1. Join by code → connected: JOIN row disappears; only the progress card + Back remain.
2. Connected → Back → re-open Join → JOIN row present and clickable (the earlier re-join bug).
3. Join by code, open manual **while still connecting**: room-code attempt is abandoned (no ghost
   on host **and** the relay room slot is released — re-check the worker's client count), manual flow
   builds cleanly.
4. Join by code, open manual, then the (abandoned) room-code link resolves **or rejects** late:
   **no** spurious "connected"/"failed" over the manual flow, **no** second `Net.client`.
5. Close manual after step 3/4 (no manual connect): JOIN row reappears (idle), re-join works.
6. Manual connect succeeds → manual body hides (only the connected card shows); then drop → error:
   manual body reappears for retry.
7. `failed` (NAT) path: manual fallback auto-opens; JOIN row hidden behind it with no flicker.
8. Host lobby → open manual → connect a manual peer → manual body hides; Back → Join lobby shows a
   clean idle entry (no stale host toggle leak).
9. Single-player Start unaffected (byte-for-byte).

## Risks

- `game/main.ts` is playtest-gated: typecheck/lint cannot prove feel/flow — the playtest matrix is
  the gate.
- `bumpCoopEpoch()` is documented "once per teardown"; here it is also used for the non-terminal
  *abandon-on-open* mode switch. This is a deliberate, in-spirit use (invalidate in-flight flows);
  it is idempotent and safe on fresh entry (no in-flight flow to invalidate). Documented at the
  call site.
