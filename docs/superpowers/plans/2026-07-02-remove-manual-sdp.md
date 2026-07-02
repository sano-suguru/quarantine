# Remove Manual SDP Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Delete the legacy manual SDP copy-paste co-op fallback, leaving room-code auto-connect as the single client path.

**Architecture:** Remove the `#lobby-manual` `<details>` UI and every main.ts handler that drives it, then strip the now-orphaned manual state models from `lobbyWait.ts`/its tests. The strict TypeScript config (`noUnusedLocals`/`noUnusedParameters`) is the completeness gate — a clean typecheck proves no dangling manual reference remains. Shared transport link builders (`createHostLink`/`createClientLink`) stay because the room-code path uses them internally.

**Tech Stack:** TypeScript (strict), Bun, Vite, Vitest, Biome.

## Global Constraints

- Single-player behavior stays byte-for-byte unchanged.
- Host-authoritative paths unchanged (only the manual toggle is removed from the host lobby).
- `game/net/transport.ts` `createHostLink`/`createClientLink` MUST remain (room-code uses them under the hood via `signaling.ts`).
- Every commit ends with: `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.
- Gates: `bun run typecheck` (= `tsc --noEmit && tsc --noEmit -p scripts/tsconfig.json`), `bun run lint` (= `biome check --error-on-warnings`), `bun run test`, `bun run build`.
- `game/main.ts` is playtest-gated: automated gates are necessary but final acceptance is a 2-tab playtest (Task 3).

---

## File Structure

- `index.html` — remove the `#lobby-manual` block.
- `game/main.ts` — remove all manual element handles, both `setManualState`/`manual.ontoggle` blocks, `pendingClientManualState`/`lastManualState`, the manual-model imports, the manual link-builder call sites + imports; simplify `syncEntryVisibility`/`setClientLobby`/`openLobby`; reword manual-referencing copy.
- `game/lobbyWait.ts` — remove the manual state model (`ManualLobbyDisplayState`, `manualLobbyWaitModel`, `clientManualFallback*`, `manualSteps`, `manualSlots`, the `showManualFallback` field, and the `manual-host`/`manual-client` role variants).
- `game/lobbyWait.test.ts` — remove the manual-model test cases.

---

### Task 1: Strip the manual UI and its main.ts wiring

**Files:**
- Modify: `index.html:188-203`
- Modify: `game/main.ts` (multiple regions, anchors below)

**Interfaces:**
- Consumes: existing `syncEntryVisibility`, `resetJoinEntry`, `joinAbort`, `setClientLobby`, `openLobby`, `roomJoin`, `roomHost`, `lobbyKind`, `lastClientLobbyState`.
- Produces: a lobby with no manual UI. `syncEntryVisibility` becomes `roomJoin.style.display = lobbyKind === "join" && !busy ? "flex" : "none";` (no `manualBody`, no `!manual.open`).

- [x] **Step 1: Remove the manual block from index.html**

Delete `index.html` lines 188–203 inclusive (the `<!-- fallback: … -->` comment through `</details>`), leaving the surrounding `</div>` (204) intact:

```html
  <!-- fallback: zero-dependency manual SDP copy-paste (no signaling server) -->
  <details id="lobby-manual" class="lobby-manual">
    <summary>No server? Connect manually</summary>
    <div id="lobby-manual-body" class="lobby-wrap" style="margin-top:10px;">
      <div id="lobby-recv" class="lobby-field">
        <div class="lobby-label" id="lobby-recv-label">Their code</div>
        <textarea id="lobby-in" class="lobby-ta" placeholder="paste the other player's code"></textarea>
        <button type="button" class="btn lobby-btn" id="lobby-go">Connect</button>
      </div>
      <div id="lobby-send" class="lobby-field">
        <div class="lobby-label" id="lobby-send-label">Your code</div>
        <textarea id="lobby-out" class="lobby-ta" readonly></textarea>
        <button type="button" class="btn lobby-btn" id="lobby-copy">Copy code</button>
      </div>
    </div>
  </details>
```

- [x] **Step 2: Remove the manual-model imports from main.ts**

In the `./lobbyWait` import block, drop `clientManualFallbackState`, `clientManualFallbackWaitModel`, `ManualLobbyDisplayState`, `manualLobbyWaitModel`. Keep the rest:

```typescript
import {
  type ClientLobbyDisplayState,
  clientLobbyWaitModel,
  hostLobbyWaitModel,
  type LobbyWaitModel,
  type LobbyWaitSlot,
} from "./lobbyWait";
```

Also drop `createClientLink` and `createHostLink` from the `./net/transport` import (their only main.ts call sites are the manual blocks removed below). Leave the other names in that import (`getTurnStatus`, `NETLOG`, `type PeerLink`, …) untouched.

- [x] **Step 3: Remove `pendingClientManualState` (module scope) + its endCoop reset**

Delete the declaration (the `// Manual-SDP client fallback UI state…` comment + `let pendingClientManualState: ManualLobbyDisplayState | null = null;`) and the `pendingClientManualState = null;` line inside `endCoop()`.

- [x] **Step 4: Remove the manual element handles**

Delete these lines in `wireCoop`:

```typescript
  const manual = el<HTMLDetailsElement>("lobby-manual");
  const manualBody = el("lobby-manual-body"); // the manual SDP entry controls (hidden once connected)
  // manual-fallback elements
  const out = el<HTMLTextAreaElement>("lobby-out");
  const inEl = el<HTMLTextAreaElement>("lobby-in");
  const go = el("lobby-go");
  const sendBlock = el("lobby-send");
  const sendLabel = el("lobby-send-label");
  const recvLabel = el("lobby-recv-label");
```

Also delete `let lastManualState: ManualLobbyDisplayState | null = null;`.

- [x] **Step 5: Simplify `syncEntryVisibility`**

Replace the two style writes so it derives only the room-code row (drop `manualBody` and the `!manual.open` term). Also update its doc comment to drop the manual-body sentence:

```typescript
  const syncEntryVisibility = (): void => {
    const k = lastClientLobbyState?.k;
    const busy = k === "joining" || k === "linking" || k === "connected";
    roomJoin.style.display = lobbyKind === "join" && !busy ? "flex" : "none";
  };
```

- [x] **Step 6: Simplify `setClientLobby`**

Change `if (!manual.open) renderLobbyWait(clientLobbyWaitModel(s));` to `renderLobbyWait(clientLobbyWaitModel(s));`, and replace the `failed` case's manual side-effect with a plain status write:

```typescript
      case "failed":
        setStatus(s.msg);
        break;
```

- [x] **Step 7: Simplify `openLobby`**

Remove `out.value = "";`, `inEl.value = "";`, `manual.open = false;`, `manual.ontoggle = null;`, and `lastManualState = null;`. Keep `lobbyKind = kind;` and the trailing `syncEntryVisibility();` (reword its comment to `// sole writer of the room-code entry-row visibility`).

- [x] **Step 8: Remove the `lobby-copy` handler**

Delete:

```typescript
  el("lobby-copy").onclick = () => {
    out.select();
    navigator.clipboard?.writeText(out.value).catch(() => {});
  };
```

- [x] **Step 9: Remove the host manual block + its refreshSquad guard**

In `openHostLobby`: delete the `if (manual.open) return;` first line of `refreshSquad` (so it always renders). Reword the signaling-error line from `` `signaling: ${s.error} — use manual connect below` `` to `` `signaling: ${s.error} — try again` ``. Then delete the entire host manual block — from the `// manual fallback: opening <details>…` comment through the `manual.ontoggle`'s closing `};` (the `let manualReady`/`let manualState`/`setManualState`/`manual.ontoggle` region), leaving `openHostLobby`'s closing `};` intact.

- [x] **Step 10: Remove the client manual block + reword failure copy**

In `openJoinLobby`'s `join()` catch, reword the two fallback strings:
- `` failMsg("connection failed (network/NAT) — try manual connect below.") `` → `` failMsg("connection failed (network/NAT) — check the code or try a personal device/network.") ``
- `` `${msg} — try manual connect below` `` → `` `${msg} — check the code and try again` ``
- the timeout `setClientLobby({failed})` string `"couldn't connect (network/NAT). Try a personal network, or manual connect below."` → `"couldn't connect (network/NAT). Check the code, or try a personal device/network."`
- the catch-guard comment `// manual took over / lobby left — don't clobber it` → `// lobby left / superseded — don't clobber it`

Then delete the entire client manual block — from the `// manual fallback: opening <details>…` comment through the `manual.ontoggle`'s closing `};` (the `let manualReady`/`let manualState`/`setManualState`/`manual.ontoggle` region), leaving `openJoinLobby`'s closing `};` intact.

- [x] **Step 11: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: both PASS. `noUnusedLocals`/`noUnusedParameters` will flag any manual symbol left behind — if it errors, remove the flagged orphan. Confirm no manual refs remain:

Run: `grep -in "manual" game/main.ts index.html`
Expected: no output.

- [x] **Step 12: Commit**

```bash
git add game/main.ts index.html
git commit -m "$(cat <<'MSG'
feat(coop): remove the manual SDP copy-paste fallback UI

Room-code auto-connect is now the only client path. Deletes the #lobby-manual
<details> panel and every main.ts handler that drove it (both setManualState /
manual.ontoggle blocks, pendingClientManualState, lastManualState, the manual
link-builder call sites), simplifies syncEntryVisibility/setClientLobby/openLobby
to a single flow, and rewords the failure copy to drop "manual connect below".
The failed state no longer opens a panel — it just shows the message and leaves
Join enabled to retry.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
MSG
)"
```

---

### Task 2: Strip the manual state model from lobbyWait

**Files:**
- Modify: `game/lobbyWait.ts`
- Modify: `game/lobbyWait.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (Task 1 already stopped importing these symbols).
- Produces: `LobbyWaitModel` with no `showManualFallback` field; wait-slot role union without `"manual-host"`/`"manual-client"`.

- [x] **Step 1: Remove the manual exports from lobbyWait.ts**

Delete `export type ManualLobbyDisplayState`, `export function manualLobbyWaitModel`, `export function clientManualFallbackWaitModel`, `export function clientManualFallbackState`, and the module-private `manualSteps`/`manualSlots` helpers. Remove the `showManualFallback: boolean;` field from `LobbyWaitModel` and every object literal that sets it (`showManualFallback: false`/`true`). Remove `"manual-host" | "manual-client"` from the wait-slot role union (leaving `"host" | "client"`), and delete the `detail: "Manual connect is available below…"` line that only made sense with a fallback.

- [x] **Step 2: Remove the manual test cases from lobbyWait.test.ts**

Delete the `describe`/`it` blocks that exercise `manualLobbyWaitModel`, `clientManualFallbackState`, and `clientManualFallbackWaitModel`, plus any `showManualFallback` assertions in the remaining client/host cases. Remove the now-unused imports of those symbols from the test's import block.

- [x] **Step 3: Typecheck + lint + test**

Run: `bun run typecheck && bun run lint && bun run test -- game/lobbyWait.test.ts`
Expected: all PASS. Confirm the model is clean:

Run: `grep -in "manual\|showManualFallback" game/lobbyWait.ts game/lobbyWait.test.ts`
Expected: no output.

- [x] **Step 4: Commit**

```bash
git add game/lobbyWait.ts game/lobbyWait.test.ts
git commit -m "$(cat <<'MSG'
refactor(coop): drop the manual lobby-wait state model

The manual SDP UI is gone, so remove its display-state model
(ManualLobbyDisplayState, manualLobbyWaitModel, clientManualFallback*,
manualSteps/manualSlots), the dead showManualFallback field, the
manual-host/manual-client roles, and their tests.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
MSG
)"
```

---

### Task 3: Full gates + playtest handoff

**Files:** none (verification only)

- [x] **Step 1: Run the full automated gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build`
Expected: typecheck/lint clean, all tests pass, build succeeds.

- [ ] **Step 2: Playtest matrix (2 tabs, `bun run dev:coop`)**

A = host, B = join:
1. A hosts (room code shown), B enters the code → B connects, A shows P2. No manual panel anywhere in either lobby.
2. B Back → A drops P2; B re-enters the same code → reconnects cleanly (no "can't join" screen).
3. B enters a bad/nonexistent code → failure message reads the reworded copy (no "manual connect below"), Join stays enabled to retry.
4. Host lobby: room-code + Quick-Match controls present, no "Connect manually" details.

- [ ] **Step 3: Whole-branch completion**

Once the playtest passes, run `superpowers:finishing-a-development-branch` for the whole `feat/multiplayer-waiting-ux` branch (merge / PR / cleanup).

---

## Self-Review

**Spec coverage:** index.html block (T1.1), main.ts wiring incl. imports/handles/handlers/messages/simplifications (T1.2–T1.10), lobbyWait model + `showManualFallback` + roles (T2.1), tests (T2.2), kept transport builders (Global Constraints), kept syncEntryVisibility/resetJoinEntry/joinAbort (T1.5 keeps them, simplifies only), failure messaging decision (T1.9/T1.10), host `roomHost` via openLobby-only (T1.9 removes the toggle). All spec sections mapped.

**Placeholder scan:** none — every step names exact regions and shows the reworded strings/simplified code.

**Type consistency:** `syncEntryVisibility` final form matches across T1.5; `LobbyWaitModel` loses `showManualFallback` in T2.1 and no remaining caller reads it (renderLobbyWait verified to read only tone/steps/headline/detail/slots). Task 1 stops importing the lobbyWait manual symbols before Task 2 deletes them, so both tasks typecheck independently.
