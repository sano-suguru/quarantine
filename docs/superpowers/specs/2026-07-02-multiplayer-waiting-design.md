# Multiplayer Waiting UX Design

## Problem

Co-op lobby waiting states are currently surfaced mostly as short status text. Players can miss
whether they are connecting, connected, waiting for the host, waiting for squadmates, or expected to
press Deploy. The fix should make waiting understandable through layout and state, not louder copy.

## Goals

- Make lobby progress read left-to-right as a short visual stepper.
- Show exactly one current step, with completed steps checked off.
- Make the next responsible actor obvious: host, client, network link, or automatic game start.
- Preserve the existing host-authoritative network flow and single-player behavior.
- Keep manual connection as the fallback, but tie errors to the failed step.

## Non-goals

- No change to signaling, P2P handshake, snapshot timing, or deploy semantics.
- No matchmaking behavior changes.
- No new game state or simulation behavior.

## UX Model

The lobby gets a role-aware stepper above the squad/status area. It uses circles connected by a
progress line, completed checks, and one highlighted current node. Supporting text explains the
current wait reason, but the flow itself is visual.

Host flow:

1. Room — room code exists.
2. Squad — players can join; this is an occupancy indicator, not a gate.
3. Deploy — host can start immediately, even with no peers.
4. Raid — game begins.

Client flow:

1. Room — room found.
2. Link — P2P open.
3. Host — waiting for host deploy.
4. Raid — automatic start on first snapshot.

Manual SDP flow uses different labels because there is no signaling room:

1. Codes — offer/reply exchange.
2. Link — P2P open.
3. Host — waiting for host deploy.
4. Raid — automatic start on first snapshot.

When manual mode is open, the stepper either switches to this manual label set or stays visually
secondary to the manual panel. It must not show "Room found" for a room-less code exchange.

## State Presentation

- **Connecting**: current node pulses while the operation is active.
- **Connected/waiting**: previous nodes show checks; the wait node glows without a spinner.
- **Host action needed**: only host sees the primary Deploy button; clients see no primary action.
  The host's current actionable step is Deploy from the moment the room opens. The squad slots show
  who has joined, but they must not imply the host is blocked from starting solo.
- **Squad status**: chips read as slots (`You`, `Host`, `P2`, empty slots) instead of a loose list.
  Host-side slots can be live because the host has `connectedPids()`. Client-side slots are limited
  before deploy; do not imply a live roster the client cannot observe.
- **Recoverable connection failure**: the failed node turns warning/error color, and manual fallback
  appears below the relevant status area.
- **Terminal lost/refused states**: do not open manual fallback for room-full, version mismatch, or
  post-open disconnect. Those states remain terminal messages, matching the existing `failed` versus
  `lost` split.
- **Automatic start**: client Raid node stays visible as the future step so clients do not search for
  a start button.

Failure-to-node mapping:

- `joining` failure: mark Room warning and show manual fallback.
- `linking` timeout/close before open: mark Link warning and show manual fallback.
- `connected` then waiting: mark Host current, no spinner.
- `lost` after open: mark Host or Link as terminal based on copy, but do not show manual fallback.
- `roomFull` / version mismatch: mark the current/terminal node warning, re-enable retry where
  existing code does, and do not offer manual fallback.

## Implementation Shape

Add lobby-only rendering helpers in `game/main.ts` near the existing `wireCoop()` lobby code:

- Build a small display model from existing host/client lobby states.
- Render fixed stepper nodes with role-prefixed keys or static markup so host/client/manual labels
  cannot reuse stale DOM. Use `renderList()` only where it helps for dynamic squad chips.
- Update the model from existing state transitions:
  - host lobby open, public/private changes, squad refresh, deploy-ready state;
  - client `joining`, `linking`, `connected`, `failed`, and `lost`;
  - manual SDP offer/reply states.
- Keep `setClientLobby()` as the single owner of opening manual fallback. The visual model may color
  failed steps, but it must not independently decide that manual should open.
- Keep `setStatus()` for concise supporting copy, but do not rely on it as the primary waiting UI.

Add CSS in `game/style.css` for the stepper, progress line, completed/current/error states, and slot
chips. Keep the visual language consistent with current toxic green, amber warning, dark panels, and
existing lobby sizing.

## Validation

- Type-check the project.
- Inspect the lobby paths manually enough to confirm the visual states are wired:
  - host room open;
  - host deploy available with zero peers;
  - client relay/linking;
  - client connected waiting for host deploy;
  - recoverable connection failure/manual fallback;
  - room-full/version-mismatch/lost states do not open manual fallback;
  - manual SDP code-exchange path does not show a misleading room step.
