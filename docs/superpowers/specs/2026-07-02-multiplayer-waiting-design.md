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
2. Squad — players can join.
3. Deploy — host can start.
4. Raid — game begins.

Client flow:

1. Room — room found.
2. Link — P2P open.
3. Host — waiting for host deploy.
4. Raid — automatic start on first snapshot.

## State Presentation

- **Connecting**: current node pulses while the operation is active.
- **Connected/waiting**: previous nodes show checks; the wait node glows without a spinner.
- **Host action needed**: only host sees the primary Deploy button; clients see no primary action.
- **Squad status**: chips read as slots (`You`, `Host`, `P2`, empty slots) instead of a loose list.
- **Failure**: the failed node turns warning/error color, and manual fallback appears below the
  relevant status area.
- **Automatic start**: client Raid node stays visible as the future step so clients do not search for
  a start button.

## Implementation Shape

Add lobby-only rendering helpers in `game/main.ts` near the existing `wireCoop()` lobby code:

- Build a small display model from existing host/client lobby states.
- Render stepper nodes with stable keys through the existing `renderList()` pattern where useful.
- Update the model from existing state transitions:
  - host lobby open, public/private changes, squad refresh, deploy-ready state;
  - client `joining`, `linking`, `connected`, `failed`, and `lost`;
  - manual SDP offer/reply states.
- Keep `setStatus()` for concise supporting copy, but do not rely on it as the primary waiting UI.

Add CSS in `game/style.css` for the stepper, progress line, completed/current/error states, and slot
chips. Keep the visual language consistent with current toxic green, amber warning, dark panels, and
existing lobby sizing.

## Validation

- Type-check the project.
- Inspect the lobby paths manually enough to confirm the visual states are wired:
  - host room open;
  - client relay/linking;
  - client connected waiting for host deploy;
  - connection failure/manual fallback.

