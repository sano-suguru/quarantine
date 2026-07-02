# Multiplayer Waiting UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unclear one-line co-op lobby waiting feedback with a role-aware visual stepper, wait-reason card, and slot-style squad display.

**Architecture:** Add a pure lobby waiting display-model module with tests, then render that model from the existing `wireCoop()` lobby owner. Keep networking and game flow unchanged: `setClientLobby()` remains the owner of client lobby lifecycle and manual fallback side effects, while the visual model only describes what to show.

**Tech Stack:** TypeScript, vanilla DOM, Vite, Vitest, Biome, Bun.

## Global Constraints

- No change to signaling, P2P handshake, snapshot timing, or deploy semantics.
- No matchmaking behavior changes.
- No new game state or simulation behavior.
- Preserve host-authoritative co-op behavior and single-player behavior.
- Host can deploy immediately with zero peers; Squad is an occupancy indicator, not a gate.
- Manual fallback opens only for recoverable `failed` states, never for `lost`, room-full, version mismatch, or post-open disconnect.
- Manual SDP has no room; do not show "Room found" while manual mode is open.
- Client pre-deploy roster is not live; do not imply the client can observe all squad slots before deploy.
- Use Bun commands: `bun run typecheck`, `bun run test -- <file>`, `bun run lint`.
- Include the standard commit trailer in implementation commits:
  `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

---

## File Structure

- Create `game/lobbyWait.ts`
  - Owns pure display-model types and functions for host, client room-code, and manual SDP lobby waiting states.
  - Has no DOM, net, or game imports.
- Create `game/lobbyWait.test.ts`
  - Verifies the edge cases that would be easy to regress while wiring UI: host zero-peer deploy, failed versus lost, manual labels, and client roster limitations.
- Modify `index.html`
  - Adds one lobby wait container between room-code controls and squad chips: `<div id="lobby-wait" ...>`.
- Modify `game/main.ts`
  - Renders `LobbyWaitModel` into the new container.
  - Updates existing host/client/manual lobby transition points to call the renderer.
  - Keeps `setClientLobby()` as the only code path that opens `manual.open`.
- Modify `game/style.css`
  - Adds visual stepper, current/done/busy/error/info states, wait card, and slot chip styles.
  - Updates squad chips to support empty slots without changing in-game player colors.

---

### Task 1: Pure Lobby Waiting Display Model

**Files:**
- Create: `game/lobbyWait.ts`
- Create: `game/lobbyWait.test.ts`

**Interfaces:**
- Consumes: no project-local runtime code.
- Produces:
  - `type LobbyWaitStepId = "room" | "squad" | "deploy" | "raid" | "link" | "host" | "codes"`
  - `type LobbyWaitStepState = "done" | "current" | "future" | "busy" | "error" | "info"`
  - `interface LobbyWaitStep`
  - `interface LobbyWaitSlot`
  - `interface LobbyWaitModel`
  - `type ClientLobbyDisplayState`
  - `type ManualLobbyDisplayState`
  - `function hostLobbyWaitModel(input: HostLobbyWaitInput): LobbyWaitModel`
  - `function clientLobbyWaitModel(state: ClientLobbyDisplayState): LobbyWaitModel`
  - `function manualLobbyWaitModel(state: ManualLobbyDisplayState): LobbyWaitModel`

- [ ] **Step 1: Write the failing tests**

Create `game/lobbyWait.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  clientLobbyWaitModel,
  hostLobbyWaitModel,
  manualLobbyWaitModel,
} from "./lobbyWait";

describe("hostLobbyWaitModel", () => {
  it("shows Deploy as actionable immediately when hosting with zero peers", () => {
    const model = hostLobbyWaitModel({ isPublic: false, peerPids: [] });

    expect(model.steps.map((s) => [s.id, s.state])).toEqual([
      ["room", "done"],
      ["squad", "info"],
      ["deploy", "current"],
      ["raid", "future"],
    ]);
    expect(model.headline).toBe("Room is ready. Deploy solo or invite players.");
    expect(model.slots.map((s) => [s.label, s.state])).toEqual([
      ["You (host)", "filled"],
      ["Open slot", "empty"],
      ["Open slot", "empty"],
      ["Open slot", "empty"],
    ]);
    expect(model.primaryAction).toBe("Deploy raid");
  });

  it("shows connected peers as filled host-side slots without making Squad a gate", () => {
    const model = hostLobbyWaitModel({ isPublic: true, peerPids: [1, 2] });

    expect(model.steps.find((s) => s.id === "squad")?.state).toBe("info");
    expect(model.steps.find((s) => s.id === "deploy")?.state).toBe("current");
    expect(model.headline).toBe("3 players in lobby. Deploy when ready.");
    expect(model.slots.map((s) => s.label)).toEqual([
      "You (host)",
      "P2",
      "P3",
      "Open slot",
    ]);
  });
});

describe("clientLobbyWaitModel", () => {
  it("shows relay as busy while joining by room code", () => {
    const model = clientLobbyWaitModel({ k: "joining" });

    expect(model.steps.map((s) => [s.id, s.state])).toEqual([
      ["room", "busy"],
      ["link", "future"],
      ["host", "future"],
      ["raid", "future"],
    ]);
    expect(model.tone).toBe("busy");
    expect(model.showManualFallback).toBe(false);
  });

  it("shows host waiting after the P2P link opens", () => {
    const model = clientLobbyWaitModel({ k: "connected" });

    expect(model.steps.map((s) => [s.id, s.state])).toEqual([
      ["room", "done"],
      ["link", "done"],
      ["host", "current"],
      ["raid", "future"],
    ]);
    expect(model.headline).toBe("Connected. Waiting for host to deploy.");
    expect(model.primaryAction).toBeUndefined();
    expect(model.slots.map((s) => [s.label, s.state])).toEqual([
      ["You", "filled"],
      ["Host", "filled"],
      ["Squad", "unknown"],
      ["Squad", "unknown"],
    ]);
  });

  it("opens manual fallback only for recoverable failures", () => {
    const failed = clientLobbyWaitModel({
      k: "failed",
      step: "link",
      msg: "connection failed (network/NAT) — try manual connect below.",
    });
    const lost = clientLobbyWaitModel({
      k: "lost",
      step: "host",
      msg: "room is full — the squad is already at capacity (4).",
    });

    expect(failed.steps.find((s) => s.id === "link")?.state).toBe("error");
    expect(failed.showManualFallback).toBe(true);
    expect(lost.steps.find((s) => s.id === "host")?.state).toBe("error");
    expect(lost.showManualFallback).toBe(false);
  });
});

describe("manualLobbyWaitModel", () => {
  it("uses Codes instead of Room for manual SDP exchange", () => {
    const model = manualLobbyWaitModel({ k: "codes", role: "client" });

    expect(model.steps.map((s) => [s.id, s.label])).toEqual([
      ["codes", "Codes"],
      ["link", "Link"],
      ["host", "Host"],
      ["raid", "Raid"],
    ]);
    expect(model.steps.find((s) => s.id === "codes")?.state).toBe("busy");
    expect(model.steps.some((s) => s.label === "Room")).toBe(false);
    expect(model.slots.map((s) => [s.label, s.state])).toEqual([
      ["You", "filled"],
      ["Host", "unknown"],
      ["Squad", "unknown"],
      ["Squad", "unknown"],
    ]);
  });

  it("shows host waiting after manual link opens", () => {
    const model = manualLobbyWaitModel({ k: "connected", role: "client" });

    expect(model.steps.map((s) => [s.id, s.state])).toEqual([
      ["codes", "done"],
      ["link", "done"],
      ["host", "current"],
      ["raid", "future"],
    ]);
    expect(model.headline).toBe("Manual link connected. Waiting for host to deploy.");
  });

  it("prompts the manual host to deploy after the peer link opens", () => {
    const model = manualLobbyWaitModel({ k: "connected", role: "host" });

    expect(model.steps.map((s) => [s.id, s.state])).toEqual([
      ["codes", "done"],
      ["link", "done"],
      ["host", "current"],
      ["raid", "future"],
    ]);
    expect(model.headline).toBe("Manual peer connected. Deploy when ready.");
    expect(model.detail).toBe("Press Deploy raid when your squad is ready.");
    expect(model.slots.map((s) => [s.label, s.state])).toEqual([
      ["You (host)", "filled"],
      ["Manual peer", "filled"],
      ["Open slot", "empty"],
      ["Open slot", "empty"],
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
bun run test -- game/lobbyWait.test.ts
```

Expected: FAIL because `game/lobbyWait.ts` does not exist yet.

- [ ] **Step 3: Implement the display model**

Create `game/lobbyWait.ts`:

```ts
export type LobbyWaitStepId = "room" | "squad" | "deploy" | "raid" | "link" | "host" | "codes";
export type LobbyWaitStepState = "done" | "current" | "future" | "busy" | "error" | "info";
export type LobbyWaitTone = "ready" | "busy" | "warn";
export type LobbyWaitSlotState = "filled" | "empty" | "unknown";

export interface LobbyWaitStep {
  id: LobbyWaitStepId;
  label: string;
  detail: string;
  state: LobbyWaitStepState;
}

export interface LobbyWaitSlot {
  label: string;
  state: LobbyWaitSlotState;
  pid?: number;
}

export interface LobbyWaitModel {
  role: "host" | "client" | "manual-host" | "manual-client";
  tone: LobbyWaitTone;
  headline: string;
  detail: string;
  steps: LobbyWaitStep[];
  slots: LobbyWaitSlot[];
  primaryAction?: string;
  showManualFallback: boolean;
}

export interface HostLobbyWaitInput {
  isPublic: boolean;
  peerPids: readonly number[];
}

export type ClientLobbyDisplayState =
  | { k: "joining" }
  | { k: "linking" }
  | { k: "connected" }
  | { k: "failed"; step: "room" | "link"; msg: string }
  | { k: "lost"; step: "room" | "link" | "host"; msg: string };

export type ManualLobbyDisplayState =
  | { k: "codes"; role: "host" | "client" }
  | { k: "linking"; role: "host" | "client" }
  | { k: "connected"; role: "host" | "client" }
  | { k: "error"; role: "host" | "client"; step: "codes" | "link" | "host"; msg: string };

const hostSteps = (squad: LobbyWaitStepState, deploy: LobbyWaitStepState): LobbyWaitStep[] => [
  { id: "room", label: "Room", detail: "created", state: "done" },
  { id: "squad", label: "Squad", detail: "players join", state: squad },
  { id: "deploy", label: "Deploy", detail: "host starts", state: deploy },
  { id: "raid", label: "Raid", detail: "survive", state: "future" },
];

const clientSteps = (
  room: LobbyWaitStepState,
  link: LobbyWaitStepState,
  host: LobbyWaitStepState,
): LobbyWaitStep[] => [
  { id: "room", label: "Room", detail: "found", state: room },
  { id: "link", label: "Link", detail: "P2P ready", state: link },
  { id: "host", label: "Host", detail: "deploys", state: host },
  { id: "raid", label: "Raid", detail: "auto-start", state: "future" },
];

const manualSteps = (
  codes: LobbyWaitStepState,
  link: LobbyWaitStepState,
  host: LobbyWaitStepState,
): LobbyWaitStep[] => [
  { id: "codes", label: "Codes", detail: "exchange", state: codes },
  { id: "link", label: "Link", detail: "P2P ready", state: link },
  { id: "host", label: "Host", detail: "deploys", state: host },
  { id: "raid", label: "Raid", detail: "auto-start", state: "future" },
];

const hostSlots = (peerPids: readonly number[]): LobbyWaitSlot[] => {
  const filled: LobbyWaitSlot[] = [
    { label: "You (host)", state: "filled", pid: 0 },
    ...peerPids.slice(0, 3).map((pid) => ({ label: `P${pid + 1}`, state: "filled" as const, pid })),
  ];
  while (filled.length < 4) filled.push({ label: "Open slot", state: "empty" });
  return filled;
};

const clientSlots = (): LobbyWaitSlot[] => [
  { label: "You", state: "filled" },
  { label: "Host", state: "filled" },
  { label: "Squad", state: "unknown" },
  { label: "Squad", state: "unknown" },
];

const manualSlots = (role: "host" | "client", connected = false): LobbyWaitSlot[] =>
  role === "host"
    ? [
        { label: "You (host)", state: "filled", pid: 0 },
        {
          label: "Manual peer",
          state: connected ? "filled" : "unknown",
          pid: connected ? 1 : undefined,
        },
        { label: "Open slot", state: "empty" },
        { label: "Open slot", state: "empty" },
      ]
    : [
        { label: "You", state: "filled" },
        { label: "Host", state: connected ? "filled" : "unknown" },
        { label: "Squad", state: "unknown" },
        { label: "Squad", state: "unknown" },
      ];

export function hostLobbyWaitModel(input: HostLobbyWaitInput): LobbyWaitModel {
  const players = input.peerPids.length + 1;
  return {
    role: "host",
    tone: "ready",
    headline:
      input.peerPids.length === 0
        ? "Room is ready. Deploy solo or invite players."
        : `${players} players in lobby. Deploy when ready.`,
    detail: input.isPublic
      ? "Public room is listed. Players can join until you deploy."
      : "Share the room code. Players can join until you deploy.",
    steps: hostSteps("info", "current"),
    slots: hostSlots(input.peerPids),
    primaryAction: "Deploy raid",
    showManualFallback: false,
  };
}

export function clientLobbyWaitModel(state: ClientLobbyDisplayState): LobbyWaitModel {
  switch (state.k) {
    case "joining":
      return {
        role: "client",
        tone: "busy",
        headline: "Finding room through relay.",
        detail: "Keep this screen open while the room answers.",
        steps: clientSteps("busy", "future", "future"),
        slots: [{ label: "You", state: "filled" }],
        showManualFallback: false,
      };
    case "linking":
      return {
        role: "client",
        tone: "busy",
        headline: "Establishing peer link.",
        detail: "This can take a moment on strict networks.",
        steps: clientSteps("done", "busy", "future"),
        slots: [{ label: "You", state: "filled" }],
        showManualFallback: false,
      };
    case "connected":
      return {
        role: "client",
        tone: "ready",
        headline: "Connected. Waiting for host to deploy.",
        detail: "The raid starts automatically when the host deploys.",
        steps: clientSteps("done", "done", "current"),
        slots: clientSlots(),
        showManualFallback: false,
      };
    case "failed":
      return {
        role: "client",
        tone: "warn",
        headline: state.msg,
        detail: "Manual connect is available below for recoverable network failures.",
        steps:
          state.step === "room"
            ? clientSteps("error", "future", "future")
            : clientSteps("done", "error", "future"),
        slots: [{ label: "You", state: "filled" }],
        showManualFallback: true,
      };
    case "lost":
      return {
        role: "client",
        tone: "warn",
        headline: state.msg,
        detail: "Try another room or return to co-op.",
        steps:
          state.step === "room"
            ? clientSteps("error", "future", "future")
            : state.step === "link"
              ? clientSteps("done", "error", "future")
              : clientSteps("done", "done", "error"),
        slots: clientSlots(),
        showManualFallback: false,
      };
  }
}

export function manualLobbyWaitModel(state: ManualLobbyDisplayState): LobbyWaitModel {
  const role = state.role === "host" ? "manual-host" : "manual-client";
  switch (state.k) {
    case "codes":
      return {
        role,
        tone: "busy",
        headline:
          state.role === "host"
            ? "Share your code, then paste their reply."
            : "Paste the host code to generate a reply.",
        detail: "Manual connect uses copied codes instead of a room relay.",
        steps: manualSteps("busy", "future", "future"),
        slots: manualSlots(state.role),
        showManualFallback: false,
      };
    case "linking":
      return {
        role,
        tone: "busy",
        headline: "Exchanging manual peer link.",
        detail:
          state.role === "host"
            ? "Paste their reply to complete the peer link."
            : "Send the reply back, then wait for the link to open.",
        steps: manualSteps("done", "busy", "future"),
        slots: manualSlots(state.role),
        showManualFallback: false,
      };
    case "connected":
      return {
        role,
        tone: "ready",
        headline:
          state.role === "host"
            ? "Manual peer connected. Deploy when ready."
            : "Manual link connected. Waiting for host to deploy.",
        detail:
          state.role === "host"
            ? "Press Deploy raid when your squad is ready."
            : "The raid starts automatically when the host deploys.",
        steps: manualSteps("done", "done", "current"),
        slots: manualSlots(state.role, true),
        showManualFallback: false,
      };
    case "error":
      return {
        role,
        tone: "warn",
        headline: state.msg,
        detail: "Check the copied code and try the manual exchange again.",
        steps:
          state.step === "codes"
            ? manualSteps("error", "future", "future")
            : state.step === "link"
              ? manualSteps("done", "error", "future")
              : manualSteps("done", "done", "error"),
        slots: manualSlots(state.role),
        showManualFallback: false,
      };
  }
}
```

- [ ] **Step 4: Run the targeted tests**

Run:

```bash
bun run test -- game/lobbyWait.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add game/lobbyWait.ts game/lobbyWait.test.ts
git commit -m $'feat: model multiplayer waiting states\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'
```

Expected: commit succeeds.

---

### Task 2: Lobby Wait Container and Stepper Styles

**Files:**
- Modify: `index.html:173-176`
- Modify: `game/style.css:625-659`

**Interfaces:**
- Consumes: `#lobby-wait` will be read by `game/main.ts` in Task 3.
- Produces: CSS classes used by Task 3 renderer:
  - `.lobby-wait`
  - `.lobby-wait.tone-ready`
  - `.lobby-wait.tone-busy`
  - `.lobby-wait.tone-warn`
  - `.lobby-stepper`
  - `.lobby-step`
  - `.lobby-step.is-done`
  - `.lobby-step.is-current`
  - `.lobby-step.is-busy`
  - `.lobby-step.is-error`
  - `.lobby-step.is-info`
  - `.lobby-wait-card`
  - `.squad-chip.empty`
  - `.squad-chip.unknown`

- [ ] **Step 1: Add the lobby wait container**

In `index.html`, replace:

```html
  <div id="lobby-squad" style="margin-top:12px;color:var(--ink);font-size:13px;letter-spacing:.05em;"></div>
  <div id="lobby-status" class="hint" style="min-height:16px;margin-top:2px;"></div>
```

with:

```html
  <div id="lobby-wait" class="lobby-wait" aria-live="polite"></div>
  <div id="lobby-squad" style="margin-top:10px;color:var(--ink);font-size:13px;letter-spacing:.05em;"></div>
  <div id="lobby-status" class="hint" style="min-height:16px;margin-top:2px;"></div>
```

- [ ] **Step 2: Add CSS for the visual stepper and slot chips**

In `game/style.css`, replace the comment `/* co-op lobby: connecting spinner + squad badges */`
and the block through `.squad-dot` with:

```css
/* co-op lobby: visual waiting flow + squad slots */
.lobby-wait {
  width: min(520px, 90vw);
  margin-top: 14px;
  padding: 13px;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.28);
  box-shadow: 0 0 0 1px rgba(159, 220, 184, 0.16);
}
.lobby-wait:empty {
  display: none;
}
.lobby-stepper {
  position: relative;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.lobby-stepper::before {
  content: "";
  position: absolute;
  left: 12.5%;
  right: 12.5%;
  top: 18px;
  height: 2px;
  background: rgba(159, 220, 184, 0.18);
}
.lobby-step {
  position: relative;
  z-index: 1;
  min-width: 0;
  text-align: center;
  color: rgba(215, 255, 225, 0.52);
}
.lobby-step-node {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  margin: 0 auto 7px;
  border-radius: 50%;
  background: #08100b;
  color: rgba(215, 255, 225, 0.56);
  box-shadow: 0 0 0 1px rgba(159, 220, 184, 0.24);
  font-size: 13px;
  font-weight: 800;
}
.lobby-step.is-done .lobby-step-node {
  background: rgba(125, 255, 79, 0.15);
  color: var(--toxic);
  box-shadow: 0 0 0 1px rgba(125, 255, 79, 0.42);
}
.lobby-step.is-current .lobby-step-node,
.lobby-step.is-busy .lobby-step-node {
  background: var(--toxic);
  color: #041006;
  box-shadow:
    0 0 0 4px rgba(125, 255, 79, 0.12),
    0 0 22px rgba(125, 255, 79, 0.42);
}
.lobby-step.is-busy .lobby-step-node {
  animation: pulse 1.4s ease-in-out infinite;
}
.lobby-step.is-error .lobby-step-node {
  background: var(--amber);
  color: #140d02;
  box-shadow:
    0 0 0 4px rgba(255, 191, 71, 0.12),
    0 0 22px rgba(255, 191, 71, 0.35);
}
.lobby-step.is-info .lobby-step-node {
  background: rgba(159, 220, 184, 0.12);
  color: #9fdcb8;
  box-shadow: 0 0 0 1px rgba(159, 220, 184, 0.28);
}
.lobby-step-title {
  overflow: hidden;
  color: inherit;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
.lobby-step-detail {
  margin-top: 2px;
  color: rgba(215, 255, 225, 0.5);
  font-size: 10px;
  line-height: 1.2;
}
.lobby-wait-card {
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(125, 255, 79, 0.07);
  box-shadow: 0 0 0 1px rgba(125, 255, 79, 0.2);
  text-align: left;
}
.lobby-wait.tone-busy .lobby-wait-card {
  background: rgba(159, 220, 184, 0.07);
  box-shadow: 0 0 0 1px rgba(159, 220, 184, 0.2);
}
.lobby-wait.tone-warn .lobby-wait-card {
  background: rgba(255, 191, 71, 0.08);
  box-shadow: 0 0 0 1px rgba(255, 191, 71, 0.28);
}
.lobby-wait-title {
  color: var(--ink);
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.03em;
}
.lobby-wait-detail {
  margin-top: 4px;
  color: rgba(215, 255, 225, 0.68);
  font-size: 12px;
  line-height: 1.35;
}
#lobby-status.busy::after {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-left: 9px;
  border-radius: 50%;
  background: var(--toxic);
  box-shadow: 0 0 8px var(--toxic);
  animation: pulse 1.4s ease-in-out infinite;
  vertical-align: baseline;
}
.squad-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}
.squad-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--ink);
  padding: 4px 10px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.35);
  box-shadow: 0 0 0 1px var(--line);
}
.squad-chip.empty,
.squad-chip.unknown {
  color: rgba(215, 255, 225, 0.5);
  border-style: dashed;
  background: rgba(0, 0, 0, 0.2);
}
.squad-dot {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}
.squad-chip.empty .squad-dot,
.squad-chip.unknown .squad-dot {
  background: transparent;
  box-shadow: inset 0 0 0 1px rgba(215, 255, 225, 0.35);
}
```

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS. CSS and HTML are not type-checked, but this catches import/type regressions before wiring.

- [ ] **Step 4: Commit**

Run:

```bash
git add index.html game/style.css
git commit -m $'feat: add multiplayer waiting stepper styles\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'
```

Expected: commit succeeds.

---

### Task 3: Render Lobby Wait Models in `wireCoop()`

**Files:**
- Modify: `game/main.ts:1-80`
- Modify: `game/main.ts:418-500`

**Interfaces:**
- Consumes from Task 1:
  - `type ClientLobbyDisplayState`
  - `type LobbyWaitModel`
  - `type LobbyWaitSlot`
  - `clientLobbyWaitModel(state)`
  - `hostLobbyWaitModel(input)`
  - `manualLobbyWaitModel(state)`
- Consumes from Task 2:
  - `#lobby-wait`
  - `.lobby-step*`, `.lobby-wait*`, `.squad-chip.empty`, `.squad-chip.unknown`
- Produces:
  - `renderLobbyWait(model: LobbyWaitModel): void`
  - `renderLobbySlots(slots: readonly LobbyWaitSlot[]): void`
  - `ClientLobby` aliased to the pure model's `ClientLobbyDisplayState`, which includes failure step metadata:
    - `{ k: "failed"; step: "room" | "link"; msg: string }`
    - `{ k: "lost"; step: "room" | "link" | "host"; msg: string }`

- [ ] **Step 1: Import the display model**

In `game/main.ts`, add this import after the `Input` import:

```ts
import {
  clientLobbyWaitModel,
  type ClientLobbyDisplayState,
  hostLobbyWaitModel,
  type LobbyWaitModel,
  type LobbyWaitSlot,
  manualLobbyWaitModel,
} from "./lobbyWait";
```

- [ ] **Step 2: Reuse the pure client display state for `ClientLobby`**

Replace the existing `ClientLobby` type:

```ts
type ClientLobby =
  | { k: "joining" } // relay handshake (pre-link)
  | { k: "linking" } // P2P open wait (the p2pOpenTimeout window)
  | { k: "connected" } // link open; waiting for the host to deploy
  | { k: "failed"; msg: string } // connect failure → reveal the manual <details> fallback
  | { k: "lost"; msg: string }; // opened then dropped in-lobby / version mismatch → no manual
```

with:

```ts
type ClientLobby = ClientLobbyDisplayState;
```

The lifecycle comments above the type remain valid: `joining`, `linking`, `connected`, `failed`, and
`lost` still mean the same things. The imported type adds display-only step metadata for terminal
states so the stepper can color the correct node without using casts.

- [ ] **Step 3: Add render helpers inside `wireCoop()`**

Inside `wireCoop()`, after:

```ts
  const status = el("lobby-status");
  const deploy = el("lobby-deploy");
  const manual = el<HTMLDetailsElement>("lobby-manual");
```

add:

```ts
  const wait = el("lobby-wait");
```

Replace the existing `makeChip` / `setSquad` helper block:

```ts
  const makeChip = ({ pid, label }: { pid: number; label: string }): HTMLElement => {
    const chip = document.createElement("span");
    chip.className = "squad-chip";
    const dot = document.createElement("span");
    dot.className = "squad-dot";
    dot.style.background = chipColor(pid);
    const name = document.createElement("span");
    name.textContent = label;
    chip.append(dot, name);
    return chip;
  };
  // #lobby-squad carries .squad-row (added above), so chips render directly into it.
  const setSquad = (members: { pid: number; label: string }[]): void => {
    renderList(squad, members, (m) => `${m.pid}:${m.label}`, makeChip);
  };
```

with:

```ts
  const makeSlotChip = ({ pid, label, state }: LobbyWaitSlot): HTMLElement => {
    const chip = document.createElement("span");
    chip.className = "squad-chip";
    chip.classList.toggle("empty", state === "empty");
    chip.classList.toggle("unknown", state === "unknown");
    const dot = document.createElement("span");
    dot.className = "squad-dot";
    if (pid !== undefined && state === "filled") dot.style.background = chipColor(pid);
    const name = document.createElement("span");
    name.textContent = label;
    chip.append(dot, name);
    return chip;
  };
  const renderLobbySlots = (slots: readonly LobbyWaitSlot[]): void => {
    renderList(
      squad,
      slots,
      (slot, i) => `${i}:${slot.label}:${slot.state}:${slot.pid ?? "x"}`,
      makeSlotChip,
    );
  };
  const renderLobbyWait = (model: LobbyWaitModel): void => {
    wait.className = `lobby-wait tone-${model.tone}`;
    const stepper = document.createElement("div");
    stepper.className = "lobby-stepper";
    model.steps.forEach((step, i) => {
      const item = document.createElement("div");
      item.className = `lobby-step is-${step.state}`;
      const node = document.createElement("div");
      node.className = "lobby-step-node";
      node.textContent = step.state === "done" ? "✓" : String(i + 1);
      const title = document.createElement("div");
      title.className = "lobby-step-title";
      title.textContent = step.label;
      const detail = document.createElement("div");
      detail.className = "lobby-step-detail";
      detail.textContent = step.detail;
      item.append(node, title, detail);
      stepper.append(item);
    });

    const card = document.createElement("div");
    card.className = "lobby-wait-card";
    const title = document.createElement("div");
    title.className = "lobby-wait-title";
    title.textContent = model.headline;
    const detail = document.createElement("div");
    detail.className = "lobby-wait-detail";
    detail.textContent = model.detail;
    card.append(title, detail);

    wait.replaceChildren(stepper, card);
    renderLobbySlots(model.slots);
  };
```

- [ ] **Step 4: Route client lobby state through the visual model**

At the start of `setClientLobby`, before the `switch`, add:

```ts
    if (!manual.open) renderLobbyWait(clientLobbyWaitModel(s));
```

The full function should now begin:

```ts
  const setClientLobby = (s: ClientLobby): void => {
    if (!manual.open) renderLobbyWait(clientLobbyWaitModel(s));
    switch (s.k) {
```

Keep the existing switch behavior, especially:

```ts
      case "failed":
        setStatus(s.msg);
        manual.open = true;
        break;
      case "lost":
        setStatus(s.msg);
        break;
```

In the `linking` case, delete this old direct squad write because `renderLobbyWait()` now owns
`#lobby-squad`:

```ts
        setSquad([{ pid: 1, label: "You" }]);
```

- [ ] **Step 5: Clear visual wait UI when opening a fresh lobby**

In `openLobby`, after:

```ts
    squad.replaceChildren();
```

add:

```ts
    wait.replaceChildren();
```

- [ ] **Step 6: Run typecheck to expose call sites that need failure metadata**

Run:

```bash
bun run typecheck
```

Expected: FAIL with TypeScript errors on `setClientLobby({ k: "failed", msg: ... })` and `setClientLobby({ k: "lost", msg: ... })` call sites that now require `step`.

- [ ] **Step 7: Commit**

Do not commit this task yet. Continue to Task 4 so all `ClientLobby` call sites are fixed before the next commit.

---

### Task 4: Wire Host, Client, and Manual Lobby States

**Files:**
- Modify: `game/main.ts:540-787`

**Interfaces:**
- Consumes from Task 3:
  - `renderLobbyWait(model)`
  - `hostLobbyWaitModel(input)`
  - `manualLobbyWaitModel(state)`
  - `ClientLobbyDisplayState` failure step metadata.
- Produces:
  - Host render updates on lobby open and squad refresh.
  - Client failure calls include `step`.
  - Manual SDP render updates use `Codes -> Link -> Host -> Raid`.

- [ ] **Step 1: Wire host lobby render updates**

In `openHostLobby`, replace `refreshSquad`:

```ts
    const refreshSquad = (): void => {
      // host is player 0; each connected peer gets its pid's color/number
      setSquad([
        { pid: 0, label: "You (host)" },
        ...host.connectedPids().map((pid) => ({ pid, label: `P${pid + 1}` })),
      ]);
    };
```

with:

```ts
    const refreshSquad = (): void => {
      if (manual.open) return;
      renderLobbyWait(
        hostLobbyWaitModel({
          isPublic: coopPublic,
          peerPids: host.connectedPids(),
        }),
      );
    };
```

This intentionally routes squad chips through the model so empty slots can render.

- [ ] **Step 2: Keep public/private toggle visually current**

Inside `pub.onchange`, after `coopHostHandle?.setMeta({...});`, add:

```ts
      refreshSquad();
```

- [ ] **Step 3: Keep host status copy concise**

Leave this existing status copy unchanged:

```ts
    setStatus(
      isPublic ? "public raid open — others can find you" : "private room — share the code",
    );
```

The new visual wait card becomes the primary waiting explanation; this line remains supporting copy.

- [ ] **Step 4: Add failure metadata to room-code client states**

Replace this room-full state:

```ts
            setClientLobby({
              k: "lost",
              msg: "room is full — the squad is already at capacity (4).",
            });
```

with:

```ts
            setClientLobby({
              k: "lost",
              step: "host",
              msg: "room is full — the squad is already at capacity (4).",
            });
```

Replace the P2P timeout failure:

```ts
          setClientLobby({
            k: "failed",
            msg: failMsg(
              "couldn't connect (network/NAT). Try a personal network, or manual connect below.",
            ),
          });
```

with:

```ts
          setClientLobby({
            k: "failed",
            step: "link",
            msg: failMsg(
              "couldn't connect (network/NAT). Try a personal network, or manual connect below.",
            ),
          });
```

Replace the close handler state:

```ts
          setClientLobby(
            opened
              ? { k: "lost", msg: "disconnected from host." }
              : {
                  k: "failed",
                  msg: failMsg("connection failed (network/NAT) — try manual connect below."),
                },
          );
```

with:

```ts
          setClientLobby(
            opened
              ? { k: "lost", step: "host", msg: "disconnected from host." }
              : {
                  k: "failed",
                  step: "link",
                  msg: failMsg("connection failed (network/NAT) — try manual connect below."),
                },
          );
```

Replace the `catch` state:

```ts
        setClientLobby({
          k: "failed",
          msg: `${err instanceof Error ? err.message : err} — try manual connect below`,
        });
```

with:

```ts
        setClientLobby({
          k: "failed",
          step: "room",
          msg: `${err instanceof Error ? err.message : err} — try manual connect below`,
        });
```

- [ ] **Step 5: Add failure metadata to manual client `lost` states**

Replace manual version mismatch:

```ts
              setClientLobby({
                k: "lost",
                msg: "host is on a different version — update to play together",
              });
```

with:

```ts
              setClientLobby({
                k: "lost",
                step: "host",
                msg: "host is on a different version — update to play together",
              });
              renderLobbyWait(
                manualLobbyWaitModel({
                  k: "error",
                  role: "client",
                  step: "host",
                  msg: "Host is on a different version — update to play together.",
                }),
              );
```

Replace manual room-full:

```ts
              setClientLobby({
                k: "lost",
                msg: "room is full — the squad is already at capacity (4).",
              });
```

with:

```ts
              setClientLobby({
                k: "lost",
                step: "host",
                msg: "room is full — the squad is already at capacity (4).",
              });
              renderLobbyWait(
                manualLobbyWaitModel({
                  k: "error",
                  role: "client",
                  step: "host",
                  msg: "Room is full — the squad is already at capacity (4).",
                }),
              );
```

- [ ] **Step 6: Wire manual host visual states**

In the host manual `manual.ontoggle` block, replace:

```ts
      if (!manual.open || manualReady) return;
```

with:

```ts
      if (!manual.open) {
        refreshSquad();
        return;
      }
      if (manualReady) return;
```

Then after:

```ts
      manualReady = true;
```

add:

```ts
      renderLobbyWait(manualLobbyWaitModel({ k: "codes", role: "host" }));
```

In the host manual `go.onclick`, before `await accept(c);`, add:

```ts
              renderLobbyWait(manualLobbyWaitModel({ k: "linking", role: "host" }));
```

After `setStatus("manual peer linked ✓");`, add:

```ts
              renderLobbyWait(manualLobbyWaitModel({ k: "connected", role: "host" }));
```

In the host manual `catch` for parse failure, after `setStatus("that reply code didn't parse");`, add:

```ts
              renderLobbyWait(
                manualLobbyWaitModel({
                  k: "error",
                  role: "host",
                  step: "codes",
                  msg: "That reply code didn't parse.",
                }),
              );
```

In the outer `catch (err)` for `createHostLink`, after `setStatus(\`manual offer failed: ${err}\`);`, add:

```ts
          renderLobbyWait(
            manualLobbyWaitModel({
              k: "error",
              role: "host",
              step: "codes",
              msg: `Manual offer failed: ${err}`,
            }),
          );
```

- [ ] **Step 7: Wire manual client visual states**

In the client manual `manual.ontoggle` block, replace:

```ts
      if (!manual.open || manualReady) return;
```

with:

```ts
      if (!manual.open) {
        wait.replaceChildren();
        squad.replaceChildren();
        return;
      }
      if (manualReady) return;
```

Then after:

```ts
      manualReady = true;
```

add:

```ts
      renderLobbyWait(manualLobbyWaitModel({ k: "codes", role: "client" }));
```

In the manual client `go.onclick`, after `const offer = inEl.value.trim();`, add this before `if (!offer) return;`:

```ts
          renderLobbyWait(manualLobbyWaitModel({ k: "codes", role: "client" }));
```

After `const { link, answer } = await createClientLink(offer);`, add:

```ts
          renderLobbyWait(manualLobbyWaitModel({ k: "linking", role: "client" }));
```

Replace:

```ts
          link.onOpen(() => setClientLobby({ k: "connected" }));
```

with:

```ts
          link.onOpen(() => {
            setClientLobby({ k: "connected" });
            renderLobbyWait(manualLobbyWaitModel({ k: "connected", role: "client" }));
          });
```

After `setStatus("reply ready — send it to the host, then wait");`, add:

```ts
          renderLobbyWait(manualLobbyWaitModel({ k: "linking", role: "client" }));
```

In the parse failure catch, after `setStatus("that host code didn't parse");`, add:

```ts
          renderLobbyWait(
            manualLobbyWaitModel({
              k: "error",
              role: "client",
              step: "codes",
              msg: "That host code didn't parse.",
            }),
          );
```

- [ ] **Step 8: Run targeted tests and typecheck**

Run:

```bash
bun run test -- game/lobbyWait.test.ts && bun run typecheck
```

Expected: both PASS.

- [ ] **Step 9: Commit Tasks 3 and 4 together**

Run:

```bash
git add game/main.ts
git commit -m $'feat: render multiplayer waiting flow in lobby\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>'
```

Expected: commit succeeds.

---

### Task 5: Manual UI Smoke Check

**Files:**
- Read-only validation: `game/main.ts`, `game/style.css`, `index.html`

**Interfaces:**
- Consumes the full implementation from Tasks 1-4.
- Produces no new public interface.

- [ ] **Step 1: Run full lint/type/test checks that cover this UI change**

Run:

```bash
bun run typecheck && bun run test -- game/lobbyWait.test.ts && bun run lint
```

Expected: PASS.

- [ ] **Step 2: Start the dev server**

Run:

```bash
bun run dev
```

Expected: Vite reports a local URL, usually `http://localhost:5173/`.

- [ ] **Step 3: Manually inspect host lobby zero-peer state**

In the browser:

1. Open the Vite URL.
2. Click `Co-op`.
3. Click `Host raid`.
4. Confirm the lobby shows `Room`, `Squad`, `Deploy`, `Raid` left-to-right.
5. Confirm `Deploy` is the current/highlighted step.
6. Confirm `Squad` is not shown as a blocker.
7. Confirm three empty slots are visible.
8. Confirm `Deploy raid` remains available.

Expected: host can clearly start solo or invite players.

- [ ] **Step 4: Manually inspect join-by-code initial and recoverable failure states**

In the browser:

1. Return to co-op hub.
2. Click `Join by code`.
3. Enter a fake room code such as `FAKE`.
4. Click `Join`.
5. Confirm the room/link stepper appears.
6. After failure, confirm the failed step is warning-colored.
7. Confirm the manual fallback opens only for this recoverable failure.

Expected: recoverable failure shows manual fallback and does not look like a successful waiting state.

- [ ] **Step 5: Manually inspect manual SDP labels**

In the same lobby:

1. Open `No server? Connect manually` if it is not already open.
2. Confirm the stepper uses `Codes`, `Link`, `Host`, `Raid`.
3. Confirm it does not show `Room`.
4. Paste invalid text and generate/connect.
5. Confirm the `Codes` step shows warning/error.

Expected: manual mode does not imply a signaling room exists.

- [ ] **Step 6: Manually inspect manual host connected state**

Use two browser tabs:

1. Tab A: open `Co-op` -> `Host raid` -> `No server? Connect manually`.
2. Tab B: open `Co-op` -> `Join by code` -> `No server? Connect manually`.
3. Copy Tab A's host code into Tab B and click `Generate reply`.
4. Copy Tab B's reply into Tab A and click `Connect`.
5. Confirm Tab A still shows `Codes`, `Link`, `Host`, `Raid`, not `Room`.
6. Confirm Tab A says the manual peer is connected and prompts the host to deploy.
7. Confirm Tab A's `Deploy raid` button remains available.

Expected: the manual host is not told to wait for host deploy; it is told to deploy when ready.

- [ ] **Step 7: Verify manual terminal paths cannot draw room-code stepper**

Run:

```bash
rg 'if \(!manual\.open\) renderLobbyWait\(clientLobbyWaitModel\(s\)\)|if \(manual\.open\) return|manualLobbyWaitModel\(\{' game/main.ts -n
```

Expected output includes:

```text
if (!manual.open) renderLobbyWait(clientLobbyWaitModel(s));
if (manual.open) return;
manualLobbyWaitModel({
```

Then inspect the manual client `onVersionMismatch` and `onRoomFull` handlers in `game/main.ts`.
Expected: both handlers call `setClientLobby({ k: "lost", step: "host", ... })` and then render
`manualLobbyWaitModel({ k: "error", role: "client", step: "host", ... })` while manual is open.

- [ ] **Step 8: Stop the dev server**

Stop the `bun run dev` process with Ctrl-C in the terminal running it, or use the Bash session stop mechanism if running under an async tool.

Expected: server exits cleanly.

- [ ] **Step 9: Report any smoke-check defect before changing code**

If any smoke-check step fails, stop and record the exact failed state, expected visual result, and
actual visual result. Do not make speculative polish changes inside this validation task. Create a
follow-up implementation task or fix commit for the observed defect.

Expected: if every smoke-check step passes, no commit is created in this task.

---

## Self-Review Notes

- Spec coverage:
  - Role-aware left-to-right stepper: Tasks 1-4.
  - Host zero-peer deploy and Squad non-gate: Task 1 tests, Task 4 host wiring, Task 5 smoke check.
  - Client Room/Link/Host/Raid waiting: Task 1 tests, Task 4 wiring.
  - Manual SDP Codes/Link/Host/Raid: Task 1 tests, Task 4 wiring, Task 5 smoke check.
  - `failed` versus `lost` manual fallback rule: Task 1 tests, Task 4 metadata wiring.
  - Client roster limitation: Task 1 model uses `unknown` slots; Task 2 CSS shows unknown without implying live occupancy.
  - No network/game behavior changes: all tasks modify display model, DOM render, markup, and CSS only.
- Red-flag scan: no incomplete marker words or vague implementation steps.
- Type consistency:
  - `ClientLobby` is an alias of `ClientLobbyDisplayState`, so `setClientLobby()` and
    `clientLobbyWaitModel()` consume the same union without casts.
  - `LobbyWaitSlot` is consumed only by `renderLobbySlots`.
  - Manual model states use `Codes` labels and never reuse `Room`.
