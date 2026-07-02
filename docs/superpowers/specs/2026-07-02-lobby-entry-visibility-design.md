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
- `openJoinLobby` — **replaces** the current inline `lastClientLobbyState = null` +
  `roomGo.disabled = false`. (Fresh entry has no in-flight flow, so the abandon half is a harmless
  idempotent no-op.)
- The **client** `manual.ontoggle` **open** branch, at its top (before the `manualReady` build) —
  this is the *abandon-on-open* arbitration. Because the room-code attempt is now dead whenever
  manual is open, `syncEntryVisibility` never has to reason about a concurrent room-code connect.

Not used by the **host** `manual.ontoggle` (a different handler): the host has no room-code
"attempt" to abandon; opening manual there just prepares an additional peer offer.

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
| Manual opened (room-code abandoned)     | null (reset)             | true        | hidden             | shown       |
| Manual peer/link connected              | null                     | true        | hidden             | **hidden**  |
| Manual dropped → error (retry)          | null                     | true        | hidden             | shown       |

Host lobby: `lobbyKind === "host"` ⇒ `#lobby-room-join` always hidden; `manualBody` hides on host
manual `connected` (one-shot).

## Affected files

- `game/main.ts` — add `lobbyKind`, `lastManualState`, `resetJoinEntry()`, `syncEntryVisibility()`;
  wire the callers; remove the two replaced ad-hoc `roomJoin.style.display` writes; `manualBody`
  handle. ~25–30 lines net.
- `index.html` — add `id="lobby-manual-body"` to the `.lobby-wrap` inside `#lobby-manual`.
- No CSS change.

## Testing / validation

`game/main.ts` is playtest-verified and excluded from unit coverage — validation is typecheck +
lint + a 2-tab manual playtest. Playtest matrix (incl. rubber-duck edge cases):

1. Join by code → connected: JOIN row disappears; only the progress card + Back remain.
2. Connected → Back → re-open Join → JOIN row present and clickable (the earlier re-join bug).
3. Join by code, open manual **while still connecting**: room-code attempt is abandoned (no ghost
   on host), manual flow builds cleanly.
4. Join by code, open manual, then the (abandoned) room-code link resolves late: **no** spurious
   "connected", **no** second `Net.client`.
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
