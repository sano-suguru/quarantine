# Remove the manual SDP copy-paste fallback

**Status:** Approved (design)
**Date:** 2026-07-02
**Branch:** `feat/multiplayer-waiting-ux`

## Problem

Co-op has two ways to connect a client: the room-code auto-connect path (over the
signaling relay) and a legacy **manual SDP copy-paste fallback** — a `<details>`
panel where players hand-exchange base64 SDP codes via textareas. The manual path
is obsolete: it is clumsy UX, it doubles the lobby's state machine (every client
event has to reason about "is manual open?"), and it was the root of the
just-fixed dual-flow arbitration bug. We are removing it entirely. Room-code
auto-connect (STUN + Worker-minted TURN) is the single supported client path.

## Goals

- Delete the manual SDP UI and all its wiring.
- Collapse the lobby state machine to a single client connection flow (room-code).
- Keep single-player and host-authoritative behavior byte-for-byte unchanged.
- Keep the shared transport primitives that the room-code path depends on.

## Non-goals

- No change to the room-code / signaling / TURN paths themselves.
- No change to host lobby behavior beyond removing the manual toggle.
- No new fallback mechanism — a failed room-code connect just surfaces a clear
  message and re-enables Join to retry.

## What gets removed

### `index.html`
- The entire `#lobby-manual` `<details>` block (`<summary>No server? Connect
  manually</summary>` + `#lobby-manual-body` with `#lobby-in`, `#lobby-out`,
  `#lobby-go`, `#lobby-copy`, `#lobby-recv`, `#lobby-send`, labels).

### `game/main.ts`
- Element handles: `manual`, `manualBody`, `out`, `inEl`, `go`, `sendBlock`,
  `sendLabel`, `recvLabel`, and the `lobby-copy` click handler.
- Both `setManualState` funnels and both `manual.ontoggle` handlers (host + client).
- The manual-fallback `createHostLink` / `createClientLink` call sites and their
  imports.
- Module-scope `pendingClientManualState` (+ its `endCoop` reset) and the
  lobby-scope `lastManualState`.
- The imports of `clientManualFallbackState`, `clientManualFallbackWaitModel`,
  `ManualLobbyDisplayState`, `manualLobbyWaitModel` from `./lobbyWait`.
- The `failed` client-lobby case's "open the manual fallback" side-effect
  (`pendingClientManualState = …; manual.open = true; renderLobbyWait(clientManualFallbackWaitModel)`).
  `failed` becomes: show the message, re-enable Join. (`lost` already behaves this way.)
- Manual-referencing copy in status/guide/fail messages
  ("try manual connect below", "use manual connect below", etc.) reworded to the
  no-fallback messaging (see below).

### `game/lobbyWait.ts`
- `ManualLobbyDisplayState`, `manualLobbyWaitModel`, `clientManualFallbackState`,
  `clientManualFallbackWaitModel`, `manualSteps`, `manualSlots`.
- The `showManualFallback` field on `LobbyWaitModel` (consumed nowhere in the
  renderer — verified `renderLobbyWait` reads only tone/steps/headline/detail/slots)
  and every builder that sets it.
- The `"manual-host"` / `"manual-client"` role variants on the wait-slot role union.

### `game/lobbyWait.test.ts`
- Every manual-model test case (the `manualLobbyWaitModel` /
  `clientManualFallback*` describe blocks).

## What stays (and why)

- **`game/net/transport.ts` `createHostLink` / `createClientLink`.** These are the
  non-trickle SDP link builders that the **room-code** path uses internally
  (`signaling.ts` calls them under the hood). They are NOT manual-only. They remain
  untouched.
- **`syncEntryVisibility()` (I1), simplified.** Still the sole writer of the
  room-code entry row's visibility. With manual gone it drops the `manualBody` line
  and the `!manual.open` term:
  `roomJoin.style.display = lobbyKind === "join" && !busy ? "flex" : "none";`
  where `busy = k === "joining" || k === "linking" || k === "connected"`.
- **`resetJoinEntry()` / `joinAbort` / cancellable `joinRoom(code, signal?)` (I2
  primitives).** Still needed to abandon an in-flight room-code attempt on Back /
  fresh lobby entry. Only the manual-open abandon *call site* is deleted; the helper
  and the abort plumbing stay.

## Failure messaging (decision)

With no fallback, a failed room-code connect surfaces a clear, actionable message
and re-enables Join for a retry:

- **Room full:** unchanged — "room is full" + re-enable Join (try another code).
- **Connect failed / NAT / timeout:** "couldn't connect (network/NAT) — check the
  code, or try a personal device/network." (drops "or manual connect below").
- **Version mismatch:** "host is on a different version — update to play together"
  (unchanged; already terminal).
- **Opened-then-dropped (`lost`):** "disconnected from host." (unchanged).

The client `failed` state stops opening the manual panel; it just renders the
message via `setClientLobby({ k: "failed", … })` and leaves Join enabled.

## Host lobby

The host `manual.ontoggle` was the only place that toggled `roomHost` visibility
on manual open/close. With manual gone, `roomHost` is set once by `openLobby`
(`kind === "host" ? "flex" : "none"`) and never hidden — no toggle needed. Remove
the host manual block entirely; `openLobby`'s existing write is sufficient.

## Testing

- **Automated (gates):** `bun run typecheck` + `bun run lint` +
  `bun run test` (lobbyWait tests updated) + `bun run build`. `noUnusedLocals` /
  `noUnusedParameters` will catch any orphaned symbol left behind — treat a clean
  typecheck as proof the removal is complete.
- **Playtest (2 tabs, `bun run dev:coop`):** room-code host↔join still connects;
  Back re-entry still works; a bad code shows the reworded failure message with no
  manual panel anywhere in the lobby (host or join).

## Risk

Low — this is a deletion. The single risk is leaving a dangling reference to a
removed symbol, which the strict typecheck (`noUnusedLocals`) surfaces immediately.
The kept primitives (transport links, syncEntryVisibility, resetJoinEntry) are
exercised by the unchanged room-code path.
