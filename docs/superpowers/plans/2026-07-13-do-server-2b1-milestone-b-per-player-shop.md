# 2b① Milestone B — Per-Player Non-Pausing Shop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shop a per-player, non-pausing, day-only interaction opened at a fortress workbench — the DO applies the buy/draft/place CoopEvents authoritatively, and `state.inShop` (the old global pause flag) is retired.

**Architecture:** Move the authoritative shop logic (`applyBuy`/`applyPlace`/`applyDraftTake`/`applyDraftReroll`/`rollDraft`) out of the DOM-coupled `game/game.ts` into a headless `sim/systems/shop.ts` so the DO can call it; regate purchasing on `phase === "day"` instead of the retired `inShop`. The client opens a client-local overlay by pressing interact at a new fortress workbench spot during the day (movement suppressed while open); buy/draft/reroll ship as CoopEvents the DO handles. The day/night cycle and day-start already live on the DO (Milestone A), so "close shop" is now a purely local overlay dismiss.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Bun, Vitest (node env), Cloudflare Durable Object (standard WebSocket API), Biome.

## Global Constraints

- **The DO never globally pauses:** never set `state.paused`; `state.inShop` is being *removed* this milestone.
- **sim/ stays headless:** no DOM/WebGL/Audio imports in `sim/` (enforced by `sim/tsconfig.json` + CI). The extracted shop logic must import only `sim/` modules.
- **Systems/logic are net-agnostic:** shop functions take `(state, …)` and mutate/return; they never import net code.
- **Derive-first fx:** no new `fxEvents` on the wire. Shop results propagate through the existing snapshot fields (`money`/`wlevel`/`draftOffer`/`deployQueue`/deployables — already synced).
- **Wire change → PROTOCOL_VERSION bump:** removing `inShop` from the binary snapshot changes the layout, so bump `PROTOCOL_VERSION` 18 → 19; the existing hello `v` gate rejects a stale/cached client. (`snapshot.ts`'s `Reader` has no bounds checks — a length mismatch decodes silently-wrong without the gate.)
- **Cooperative, not adversarial (2a/2b stance):** the DO gates purchasing on `phase === "day"`; it does not re-validate fortress proximity (the client only opens the overlay at the workbench). No per-field input validation beyond the existing patterns.
- **Shop is day-only + at the fortress workbench; place/deploy of already-bought items stays night-legal** (combat placement via the existing Q/Fortify path is unchanged).
- **`Net.mode` is always `"client"`** (single-player was removed in 2a) — the `else` branches in `game.ts`'s shop wrappers are dead code and are removed here.

---

## File structure

- `sim/systems/shop.ts` — **new**: the authoritative shop logic moved from `game.ts` (`applyBuy`, `applyPlace`, `applyDraftTake`, `applyDraftReroll`, `rollDraft`), regated `inShop → phase === "day"`.
- `sim/systems/shop.test.ts` — **new**: the shop/draft unit tests moved from `game/game.test.ts` + `game/game.draft.test.ts`, adjusted to set `phase = "day"` instead of `inShop = true`.
- `sim/data/map.ts` — add `WORKBENCH` fortress shop spot.
- `sim/types.ts` — add `Player.draftRolledForDay`; remove `State.inShop`.
- `sim/state.ts` — init `draftRolledForDay`; remove `inShop` init.
- `sim/systems/dawn.ts` — roll each present player's draft offer at dawn.
- `sim/snapshot.ts` — remove `inShop` (5 sites); the flag bit3 becomes reserved.
- `sim/net/protocol.ts` — `PROTOCOL_VERSION` 18 → 19.
- `worker/arena.ts` — `onMessage` handles buy/place/draftTake/draftReroll; `spawnFresh` rolls a mid-day joiner's draft.
- `game/game.ts` — client-local `shopOpen` state; `buyItem`/`deployPlace`/`draftTake`/`draftReroll` become request-only; `shopDeploy` → local close; `syncShopUI`/`updateHUD` read `shopOpen`; remove the moved functions + dead `else` branches; render the workbench marker.
- `game/main.ts` — interact-at-workbench opens the overlay; rebase `inShop` reads → `shopOpen`; suppress movement while open.
- `game/game.test.ts` / `game/game.draft.test.ts` — removed (moved to `sim/systems/shop.test.ts`).

---

### Task 1: Extract authoritative shop logic to `sim/systems/shop.ts`

**Files:**
- Create: `sim/systems/shop.ts`
- Create: `sim/systems/shop.test.ts`
- Modify: `game/game.ts` (remove the 5 moved functions; import the 3 still referenced by client wrappers as needed)
- Delete: `game/game.test.ts`, `game/game.draft.test.ts` (their content moves to `sim/systems/shop.test.ts`)

**Interfaces:**
- Consumes: `storeItems`/`cardItem`/`draftPool`/`rollOffer`/`rerollCost` (`sim/data/arsenal.ts`); `DEPLOYABLE_TYPES`/`deployableCount`/`placeSpot`/`placeDeployable` (`sim/data/deployables.ts`); `CONFIG`; `Player`/`State`.
- Produces (all in `sim/systems/shop.ts`):
  - `applyBuy(s: State, itemId: string, buyer: Player | undefined): boolean`
  - `applyPlace(s: State, player: Player | undefined): boolean`
  - `applyDraftTake(s: State, buyer: Player | undefined, cardId: string): boolean`
  - `applyDraftReroll(s: State, buyer: Player | undefined): boolean`
  - `rollDraft(state: State, p: Player): void`
  - Purchasing (`applyBuy`/`applyDraftTake`/`applyDraftReroll`) is gated on `s.phase === "day"` (was `s.inShop`). `applyPlace` and `rollDraft` keep their existing gates (no phase gate — placement is night-legal).

- [ ] **Step 1: Create `sim/systems/shop.ts`** with the moved logic, regated:

```typescript
import { CONFIG } from "../config";
import { cardItem, draftPool, rerollCost, rollOffer, storeItems } from "../data/arsenal";
import { DEPLOYABLE_TYPES, deployableCount, placeDeployable, placeSpot } from "../data/deployables";
import type { Player, State } from "../types";

/**
 * Authoritative shop logic. Headless (sim/), called by the DO on the buy/place/draft CoopEvents.
 * Purchasing (buy/draftTake/draftReroll) is day-only — the client only opens the shop overlay at
 * the fortress workbench during the day, and the DO enforces `phase === "day"` as the gate.
 * Placement (applyPlace) is night-legal (drop a bought turret mid-siege) and unchanged.
 */

/** Apply a purchase. `buyer` is the player who paid. False (no change) if it's not day, the buyer
 *  is gone, or the item can't be afforded. */
export function applyBuy(s: State, itemId: string, buyer: Player | undefined): boolean {
  if (s.phase !== "day" || !buyer) return false;
  const it = storeItems(s, buyer).find((x) => x.id === itemId);
  if (!it?.canBuy(s, buyer)) return false;
  buyer.money -= it.price;
  it.buy(s, buyer);
  return true;
}

/** Place the front of `player`'s deploy queue in front of them. Night-legal (no phase gate).
 *  False (no change) if down, empty queue, at the type cap, or no valid spot. */
export function applyPlace(s: State, player: Player | undefined): boolean {
  if (!player || player.hp <= 0) return false;
  const defId = player.deployQueue[0];
  if (!defId) return false;
  const def = DEPLOYABLE_TYPES[defId];
  if (!def || deployableCount(s, defId) >= def.cap) return false;
  const spot = placeSpot(s, player, def);
  if (!spot) return false;
  placeDeployable(s, defId, spot.x, spot.y);
  player.deployQueue.shift();
  return true;
}

/** Roll a fresh nightly draft offer for player `p` and reset their free-pick + reroll counters. */
export function rollDraft(state: State, p: Player): void {
  p.draftOffer = rollOffer(draftPool(state, p), CONFIG.arsenal.offerSize).map((it) => it.id);
  p.draftFreePicksUsed = 0;
  p.draftRerolls = 0;
  p.draftTaken = [];
}

/** Apply a draft "take": first CONFIG.arsenal.freePicks takes are free, further ones cost SCRAP. */
export function applyDraftTake(s: State, buyer: Player | undefined, cardId: string): boolean {
  if (s.phase !== "day" || !buyer?.draftOffer.includes(cardId)) return false;
  const it = cardItem(s, buyer, cardId);
  if (!it) return false;
  if (buyer.draftFreePicksUsed < CONFIG.arsenal.freePicks) {
    it.buy(s, buyer);
    buyer.draftFreePicksUsed += 1;
  } else {
    if (!it.canBuy(s, buyer)) return false;
    buyer.money -= it.price;
    it.buy(s, buyer);
  }
  if (cardId.startsWith("perk:")) buyer.draftTaken.push(cardId);
  buyer.draftOffer = buyer.draftOffer.filter((id) => id !== cardId);
  return true;
}

/** Apply a draft reroll: charge escalating SCRAP, bump the counter, redraw the shown cards. */
export function applyDraftReroll(s: State, buyer: Player | undefined): boolean {
  if (s.phase !== "day" || !buyer || buyer.draftOffer.length === 0) return false;
  const cost = rerollCost(buyer.draftRerolls);
  if (buyer.money < cost) return false;
  buyer.money -= cost;
  buyer.draftRerolls += 1;
  buyer.draftOffer = rollOffer(draftPool(s, buyer), buyer.draftOffer.length, buyer.draftTaken).map(
    (it) => it.id,
  );
  return true;
}
```

- [ ] **Step 2: Move the tests** — create `sim/systems/shop.test.ts` from the SHOP describe blocks of `game/game.test.ts` (the `applyBuy (Fortify purchase …)` block) + all of `game/game.draft.test.ts`, with two mechanical changes: (a) import the functions from `./shop`; (b) replace every `s.inShop = true` with `s.phase = "day"` and every `s.inShop = false` with `s.phase = "night"`. Carry the helper imports the moved cases use (`addPlayer`/`localPlayer` from `../engine/players`, `newState` from `../state`). Preserve every shop assertion — behavior is identical, only the gate field changed.
  - **Do NOT re-home the `describe("stepSim() transition events …")` block** in `game/game.test.ts`: it is redundant — the identical assertion (day→night pushes the NIGHT/waveStart cues) already lives in `sim/step.test.ts` (the `"returns 'night' and pushes the NIGHT/waveStart cues"` case). Dropping it loses no coverage.
  - Then delete `game/game.test.ts` and `game/game.draft.test.ts`.

- [ ] **Step 3: Remove the moved functions from `game/game.ts`** — delete the bodies of `applyBuy`, `applyPlace`, `rollDraft`, `applyDraftTake`, `applyDraftReroll` (lines ~1342-1421). The client wrappers (`buyItem`/`deployPlace`/`draftTake`/`draftReroll`) currently have dead `else` branches that call these (dead because `Net.mode` is always `"client"`) — reduce each wrapper to the client-request path only. Example — `buyItem` becomes:

```typescript
/** Buy a Fortify (deployable) item by id — ship a request to the DO (applied authoritatively). */
export function buyItem(itemId: string): void {
  if (!shopOpen) return; // shopOpen introduced in Task 4; until then this reads state.inShop
  Net.client?.requestBuy(itemId);
  Audio.ui(true);
}
```

NOTE for the implementer: `shopOpen` does not exist yet (Task 4). For THIS task, keep the wrappers' existing `if (!state.inShop) return;` guard and only remove the dead `else { applyBuy… }` bodies + the now-unused imports. Task 4 swaps `state.inShop` → `shopOpen`. Do not introduce `shopOpen` here.

- [ ] **Step 4: Fix imports** — `game/game.ts` no longer defines the shop functions. If any remaining `game.ts` code calls them (it should not after Step 3 — the wrappers are request-only), import from `../sim/systems/shop`. Remove now-unused imports (`placeSpot`, `placeDeployable`, `deployableCount`, `DEPLOYABLE_TYPES`, `rollOffer`, `draftPool`, `rerollCost`, `cardItem`) from `game.ts` **only if** nothing else in `game.ts` uses them (e.g. `renderShop` still uses `storeItems`/`cardItem`/`rerollCost` — keep those). Let `bun run typecheck` + Biome/knip drive which imports are truly unused.

- [ ] **Step 5: Run the gates**

Run: `bun run test -- sim/systems/shop.test.ts && bun run typecheck && bun run lint`
Expected: shop tests PASS (all moved assertions green); typecheck PASS; lint PASS. (`bun run test` full suite should also pass — the old game test files are gone, their cases now live under `sim/`.)

- [ ] **Step 6: Commit**

```bash
git add sim/systems/shop.ts sim/systems/shop.test.ts game/game.ts
git add -A game/game.test.ts game/game.draft.test.ts
git commit -m "refactor(sim): extract authoritative shop logic to sim/systems/shop (regate inShop->phase)"
```

---

### Task 2: Per-player dawn draft roll + mid-day joiner roll

**Files:**
- Modify: `sim/types.ts` (add `Player.draftRolledForDay`)
- Modify: `sim/engine/players.ts` (`makePlayer` inits it)
- Modify: `sim/systems/dawn.ts` (roll each present player at dawn)
- Modify: `worker/arena.ts` (`spawnFresh` rolls a mid-day joiner)
- Test: `sim/systems/dawn.test.ts`

**Interfaces:**
- Consumes: `rollDraft(state, p)` (Task 1, `sim/systems/shop.ts`).
- Produces:
  - `Player.draftRolledForDay: number` — the `state.day` a player's offer was last rolled; guards against a mid-day joiner being re-rolled by the same day's dawn pass (double free picks).
  - `sysDawn` now rolls every present (`!absent`) player whose `draftRolledForDay !== state.day`.

- [ ] **Step 1: Add the field** in `sim/types.ts` (beside the other draft fields, e.g. after `draftTaken`):

```typescript
  /** the state.day a fresh draft offer was last rolled for this player — guards a mid-day joiner
   *  (rolled on spawn) against a second roll by the same day's dawn pass (which would re-grant free picks). */
  draftRolledForDay: number;
```

- [ ] **Step 2: Init it** in `sim/engine/players.ts` `makePlayer` (beside `draftTaken: []`):

```typescript
    draftRolledForDay: -1,
```

- [ ] **Step 3: Write the failing test** — add to `sim/systems/dawn.test.ts`:

```typescript
  it("rolls a fresh draft offer for each present player at dawn (once per day)", () => {
    const s = newState();
    s.players = [];
    const a = addPlayer(s, 0, 0, 0);
    const b = addPlayer(s, 1, 0, 0);
    s.owned = { pistol: true, smg: true, shotgun: true }; // ensure the pool is non-empty
    sysDawn(s); // day 1 -> 2
    expect(a.draftOffer.length).toBeGreaterThan(0);
    expect(b.draftOffer.length).toBeGreaterThan(0);
    expect(a.draftRolledForDay).toBe(s.day);
    expect(b.draftRolledForDay).toBe(s.day);
  });

  it("does not re-roll a player already rolled for the current day", () => {
    const s = newState();
    s.players = [];
    const a = addPlayer(s, 0, 0, 0);
    s.day = 5;
    a.draftRolledForDay = 6; // pretend a mid-day joiner was rolled for the day sysDawn will produce
    a.draftFreePicksUsed = 2; // and has already spent free picks
    sysDawn(s); // day 5 -> 6; a is already stamped for day 6
    expect(a.draftFreePicksUsed).toBe(2); // not reset — no second roll
  });
```

- [ ] **Step 4: Run it to verify it fails**

Run: `bun run test -- sim/systems/dawn.test.ts`
Expected: FAIL — `sysDawn` doesn't roll drafts yet.

- [ ] **Step 5: Implement the roll in `sim/systems/dawn.ts`** — import `rollDraft` and add a roll pass in `sysDawn`, after `startDay(state)` (so `state.day` is the new day):

```typescript
import { rollDraft } from "./shop";
```
```typescript
export function sysDawn(state: State): { pid: number; salvage: number }[] {
  state.day++;
  const banked = bankSalvageAtDawn(state);
  reviveStragglers(state);
  startDay(state);
  for (const p of state.players) {
    if (p.absent || p.draftRolledForDay === state.day) continue;
    rollDraft(state, p);
    p.draftRolledForDay = state.day;
  }
  return banked;
}
```

- [ ] **Step 6: Roll a mid-day joiner** in `worker/arena.ts` `spawnFresh`, after `addPlayer(...)`:

```typescript
    // a joiner arriving mid-day missed the dawn roll — give them an offer now (stamped so the
    // next dawn's roll pass skips them and they don't get a second set of free picks).
    if (s.phase === "day") {
      const p = s.players.find((pl) => pl.id === pid);
      if (p) {
        rollDraft(s, p);
        p.draftRolledForDay = s.day;
      }
    }
```

Add the import to `worker/arena.ts`:

```typescript
import { rollDraft } from "../sim/systems/shop";
```

- [ ] **Step 7: Run tests + typecheck**

Run: `bun run test -- sim/systems/dawn.test.ts && bun run typecheck`
Expected: PASS (dawn tests incl. the two new cases; root + worker typecheck clean).

- [ ] **Step 8: Commit**

```bash
git add sim/types.ts sim/engine/players.ts sim/systems/dawn.ts worker/arena.ts sim/systems/dawn.test.ts
git commit -m "feat(sim,net): per-player dawn draft roll + mid-day joiner roll (draftRolledForDay guard)"
```

---

### Task 3: DO handles the shop CoopEvents

**Files:**
- Modify: `worker/arena.ts` (`onMessage`: dispatch buy/place/draftTake/draftReroll)

**Interfaces:**
- Consumes: `applyBuy`/`applyPlace`/`applyDraftTake`/`applyDraftReroll` (`sim/systems/shop.ts`); the `CoopEvent` shapes (`buy`/`place`/`deploy`/`draftTake`/`draftReroll`).
- Produces: the DO applies these authoritatively for the requesting peer's player; results propagate via the snapshot. `deploy` is retired (no-op — day-start lives on the DO; closing the overlay is client-local).

- [ ] **Step 1: Handle the events** in `worker/arena.ts` `onMessage`, replacing the deferred comment (`// buy/place/deploy/draft: 2b (per-player shop). Not handled in the held-night gate.`) with real dispatch. After the `input`/`ping` branches, add:

```typescript
    } else if (msg.t === "buy") {
      applyBuy(s, msg.itemId as string, s.players.find((pl) => pl.id === peer.pid));
    } else if (msg.t === "place") {
      applyPlace(s, s.players.find((pl) => pl.id === peer.pid));
    } else if (msg.t === "draftTake") {
      applyDraftTake(s, s.players.find((pl) => pl.id === peer.pid), msg.cardId as string);
    } else if (msg.t === "draftReroll") {
      applyDraftReroll(s, s.players.find((pl) => pl.id === peer.pid));
    }
    // "deploy" is retired in 2b: the day starts at dawn on the DO, and closing the shop overlay
    // is client-local. A stray "deploy" from an old client is ignored (no branch).
```

Add the import to `worker/arena.ts`:

```typescript
import { applyBuy, applyDraftReroll, applyDraftTake, applyPlace } from "../sim/systems/shop";
```

(Keep the existing `rollDraft` import from Task 2 — combine into one import line from `../sim/systems/shop`.)

- [ ] **Step 2: Typecheck + tests**

Run: `bun run typecheck && bun run test`
Expected: PASS (root + worker typecheck; full suite — no new unit tests here, the shop logic is tested in Task 1; DO dispatch is harness-verified in Step 3).

- [ ] **Step 3: Harness smoke (controller/human — cannot run headless).** With Task 4-5 not yet done the overlay can't open in-browser, so verify dispatch via a scripted client is out of scope here; defer the end-to-end buy check to the Task 5 playtest. Confirm only that the worker boots without error: `bun run dev:coop` starts, arena connects, cycle runs (Milestone A behavior intact).

- [ ] **Step 4: Commit**

```bash
git add worker/arena.ts
git commit -m "feat(net): DO applies the shop CoopEvents (buy/place/draftTake/draftReroll)"
```

---

### Task 4: Client-local shop-open state (rebase off `state.inShop`)

**Files:**
- Modify: `game/game.ts` (add `shopOpen`; `shopDeploy` → local close; `syncShopUI`/`updateHUD` read `shopOpen`; wrappers guard on `shopOpen`)
- Modify: `game/main.ts` (rebase `inShop` reads → `shopOpen`)

**Interfaces:**
- Produces:
  - `shopOpen: boolean` (module-local in `game.ts`) — whether THIS client's shop overlay is open. Not synced, not authoritative.
  - `openShopOverlay()` / `closeShopOverlay()` (or a setter) — exported so `main.ts` (Task 5 opens it) and `shopDeploy` (closes it) can toggle it.
  - `isShopOpen(): boolean` — exported read for `main.ts` guards.

- [ ] **Step 1: Add the client-local state + accessors** in `game/game.ts` (near the other module state):

```typescript
// Whether THIS client's shop overlay is open. Client-local UI state — the sim no longer pauses
// and there is no synced `inShop`. Opened by interacting at the fortress workbench during the day
// (main.ts), closed by the Done control or leaving. Movement input is suppressed while open.
let shopOpen = false;
export function isShopOpen(): boolean {
  return shopOpen;
}
export function openShopOverlay(): void {
  shopOpen = true;
}
export function closeShopOverlay(): void {
  shopOpen = false;
}
```

- [ ] **Step 2: Rebase `game.ts`'s own `inShop` reads onto `shopOpen`:**
  - `buyItem`/`deployPlace`/`draftTake`/`draftReroll`: `if (!state.inShop) return;` → `if (!shopOpen) return;`
  - `updateHUD` mobile-controls line (`… && !state.inShop`) → `… && !shopOpen`
  - `updateHUD` pause line (`if (state.paused && !state.inShop)`) → `if (state.paused && !shopOpen)`
  - `syncShopUI`: `const open = state.inShop;` → `const open = shopOpen;`
  - `togglePause`: `if (!state.running || state.inShop) return;` → `if (!state.running || shopOpen) return;`

- [ ] **Step 3: `shopDeploy` becomes a local close** in `game/game.ts` — replace its body with:

```typescript
/** Close this client's shop overlay (day-start already happened on the DO at dawn). Local only. */
export function shopDeploy(): void {
  if (!shopOpen) return;
  Audio.ui(true);
  closeShopOverlay();
}
```

(Remove the old `Net.client?.requestDeploy()` client branch and the dead `state.inShop = false; state.paused = false; state.day++; startDay(...)` local branch. `requestDeploy` on the client becomes unused — leave it inert; M-C cleanup.)

- [ ] **Step 4: Rebase `main.ts`'s `inShop` reads onto `isShopOpen()`:**
  - Line ~182 (fortify touch guard): `if (!st.running || st.inShop || settingsOpen) return;` → `if (!st.running || isShopOpen() || settingsOpen) return;`
  - Line ~243 (keydown): `if (state.inShop) { … }` → `if (isShopOpen()) { … }`
  - Line ~324 (settings force-close): `if (settingsOpen && (st.inShop || …))` → `if (settingsOpen && (isShopOpen() || …))`
  Add `isShopOpen` to the `./game` import in `main.ts`.

- [ ] **Step 5: Typecheck + lint + test**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS. `state.inShop` is now unread by client code (it's still on `State`, set nowhere — removed in Task 6).

- [ ] **Step 6: Commit**

```bash
git add game/game.ts game/main.ts
git commit -m "refactor(game): client-local shopOpen state; shopDeploy closes the overlay (no global day-start)"
```

---

### Task 5: Open the shop at the fortress workbench (interact + marker)

**Files:**
- Modify: `sim/data/map.ts` (add `WORKBENCH`)
- Modify: `game/main.ts` (interact-at-workbench opens the overlay; suppress movement while open)
- Modify: `game/game.ts` (render the workbench marker in `draw`; suppress movement input while `shopOpen`)

**Interfaces:**
- Consumes: `WORKBENCH: { x: number; y: number }` (`sim/data/map.ts`); `isShopOpen`/`openShopOverlay`/`closeShopOverlay` (Task 4); the local predicted player position + snapshot `phase`.
- Produces: pressing interact (E / touch interact) while within `CONFIG.siege.interactRadius` of `WORKBENCH` during `phase === "day"` opens the overlay; movement input is suppressed while the overlay is open.

- [ ] **Step 1: Add the workbench spot** in `sim/data/map.ts` (near `HOME_SPAWN`):

```typescript
/** Fortress shop workbench: interact here during the day to open the per-player shop overlay. */
export const WORKBENCH = { x: 0, y: 0 };
```

- [ ] **Step 2: Open on interact-at-workbench (OPEN-only — closing is the existing Done/Enter path).** Add a small helper in `game/main.ts` and call it from both the keydown (desktop `KeyE`) and touch-interact (`btnRepair` touchstart, ~line 164) paths, edge-triggered, BEFORE the normal repair/search interact. The local player is `localPlayer(getState())` (its predicted position is current after `Client.render`).

  **Why open-only (not toggle):** if interact also *closed* the shop, then on the close frame `isShopOpen()` is already false, so `sampleLocalInput` runs and reads the still-held `KeyE` as `interactHeld = true`, sending a stray interact to the DO. Making close go through the overlay's **Done button** (`deployBtn` → `shopDeploy` → `closeShopOverlay`) and **Enter** (already wired at `main.ts` ~line 250 inside the `isShopOpen()` block) avoids that entirely. Opening has no such issue — once open, input is suppressed (`emptyInput()`, Step 3), so the held key can't leak.

```typescript
// Open the client-local shop overlay if the local player is at the fortress workbench during the
// day. Returns true if it handled the press (opened the shop) so the caller skips repair/search.
// Does NOT close — closing is the Done button / Enter (see shopDeploy).
function openWorkbenchShop(): boolean {
  const st = getState();
  if (!st.running || st.phase !== "day" || isShopOpen()) return false;
  const lp = localPlayer(st);
  if (Math.hypot(lp.x - WORKBENCH.x, lp.y - WORKBENCH.y) >= CONFIG.siege.interactRadius) return false;
  openShopOverlay();
  return true;
}
```

In the `keydown` listener (~line 233), add near the top (after the existing early-returns), guarded against auto-repeat so it fires once per press:

```typescript
    if (e.code === "KeyE" && !e.repeat && openWorkbenchShop()) return;
```

In the `btnRepair` touchstart handler (~line 160-165), before `Input.touchInteract = true;`:

```typescript
      if (openWorkbenchShop()) return; // at the workbench by day → open the shop, not repair
```

Add imports to `main.ts`: `WORKBENCH` from `../sim/data/map`, `CONFIG` from `../sim/config`, `localPlayer` from `../sim/engine/players`, `getState` from `./game`, and `openShopOverlay`/`isShopOpen` from `./game` (`closeShopOverlay` is used by `shopDeploy` in `game.ts`, not here).

- [ ] **Step 3: Suppress input while the overlay is open.** `main.ts` (~line 300) samples input as `const inp = live ? (settingsOpen ? emptyInput() : sampleLocalInput(st)) : null;`. The overlay-open case is exactly analogous to the settings-open case (a neutral input while a menu is up), so extend that condition:

```typescript
      const inp = live ? (settingsOpen || isShopOpen() ? emptyInput() : sampleLocalInput(st)) : null;
```

`emptyInput()` (already imported) zeroes `moveX`/`moveY`/`firing`/`interactHeld` and leaves the player stationary — the idle body doesn't walk or fire while browsing. This reuses the existing suppression path rather than mutating fields by hand.

- [ ] **Step 4: Render the workbench marker** in `game/game.ts` `draw()` (where world props are drawn, before `flush`): draw a distinct static marker at `WORKBENCH` so players can find it — e.g. a small ring + glow in the fortify palette:

The renderer's `ring`/`glow` take numeric colour components: `ring(x, y, rad, r, g, b, a = 1)` and `glow(x, y, rad, r, g, b, a = 1)` (see `game/engine/renderer.ts`). Draw the marker inside the `begin()`/`flush()` block where other world props are drawn:

```typescript
// fortress workbench marker (shop spot): a ring, brighter by day when it's usable
if (state.phase === "day") {
  Renderer.ring(WORKBENCH.x, WORKBENCH.y, 22, 0.9, 0.8, 0.4, 0.9);
  Renderer.glow(WORKBENCH.x, WORKBENCH.y, 46, 0.5, 0.42, 0.2, 0.5);
} else {
  Renderer.ring(WORKBENCH.x, WORKBENCH.y, 22, 0.4, 0.4, 0.45, 0.4);
}
```

Import `WORKBENCH` from `../sim/data/map` in `game.ts`. This is a feel element — validate legibility in the playtest.

- [ ] **Step 5: Typecheck + lint + test**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS.

- [ ] **Step 6: Playtest (feel gate — controller/human, cannot run headless).** `bun run dev:coop`: by day, walk to the fortress workbench (marker visible) → press interact → the shop overlay opens, your body stops moving; buy a fortify / take a draft card / reroll → money + cards update from the snapshot; press Done (or interact again) → overlay closes, movement resumes. Confirm the overlay does NOT open at night (marker dimmed, interact does nothing). **Blocking feel check (spec §5):** an idle body at the daytime workbench is safe enough against roamers — if not, note it for a follow-up (roamer spawn placement / safe radius).

- [ ] **Step 7: Commit**

```bash
git add sim/data/map.ts game/main.ts game/game.ts
git commit -m "feat(game): open the per-player shop at the fortress workbench (day-only interact + marker)"
```

---

### Task 6: Retire `state.inShop` + bump PROTOCOL_VERSION

**Files:**
- Modify: `sim/types.ts` (remove `State.inShop`)
- Modify: `sim/state.ts` (remove `inShop` init)
- Modify: `sim/snapshot.ts` (remove the 5 `inShop` sites; bit3 reserved)
- Modify: `sim/net/protocol.ts` (`PROTOCOL_VERSION` 18 → 19)
- Test: `sim/snapshot.test.ts` (golden byte test updates if it asserts the flag byte / version)

**Interfaces:**
- Produces: `State` no longer has `inShop`; the snapshot flag byte's bit3 is unused/reserved; `PROTOCOL_VERSION === 19`.

- [ ] **Step 1: Remove `inShop` from the snapshot** in `sim/snapshot.ts` — all five sites:
  - the `Snapshot` interface field `inShop: boolean;` (line ~174)
  - `captureSnapshot`'s `inShop: state.inShop,` (line ~221)
  - `applySnapshot`'s `state.inShop = snap.inShop;` (line ~376)
  - the encode flag OR `(snap.inShop ? 8 : 0)` (line ~644) — remove the term; leave bit3 unused
  - the decode `inShop: (flags & 8) !== 0,` (line ~1251)
  Update the flag-byte comment (line ~639) from `bit3 inShop` to `bit3 reserved`.

- [ ] **Step 2: Remove `State.inShop`** in `sim/types.ts` (the `inShop: boolean;` field + its comment, ~line 174) and its init in `sim/state.ts` (`inShop: false,`, line 75).

- [ ] **Step 3: Bump the protocol** in `sim/net/protocol.ts`:

```typescript
export const PROTOCOL_VERSION = 19;
```

- [ ] **Step 4: Reconcile the snapshot golden test** — `sim/snapshot.test.ts:107` has a golden `toMatchInlineSnapshot(\`"len=306 fnv=770b418f"\`)`. `inShop` was a **bit** in an existing flags byte (bit3), not its own byte, so **`len` stays 306** — do NOT change the length. The FNV hash only drifts if the golden fixture's captured snapshot had `inShop === true` (bit3 set → now cleared); if the fixture had `inShop === false`, bit3 was already 0 and the bytes are identical, so the test passes unchanged. (The golden does not encode `PROTOCOL_VERSION`, so the 18→19 bump does not touch it.)

Run: `bun run test -- sim/snapshot.test.ts`
Expected: either PASS unchanged (fixture had `inShop=false`), OR FAIL with a new `fnv=` value → update ONLY the `fnv=` in the inline snapshot to the reported value (keep `len=306`). Do not touch the length or work around the assertion.

- [ ] **Step 5: Full gates**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: PASS (root + worker typecheck; full suite). Confirm no remaining `inShop` references: `grep -rn "inShop" sim/ game/ worker/` returns nothing (outside node_modules).

- [ ] **Step 6: Commit**

```bash
git add sim/types.ts sim/state.ts sim/snapshot.ts sim/net/protocol.ts sim/snapshot.test.ts
git commit -m "refactor(sim,net): retire state.inShop; PROTOCOL_VERSION 18->19 (bit3 reserved)"
```

---

## Final verification

- [ ] **Ship as ONE PR after all 6 tasks.** The shop is intentionally non-functional between T1 and T5: post-Milestone-A `state.inShop` is never set (the old auto-open at dawn is gone), and the new workbench open path only lands in T5. Each task keeps typecheck/tests green at its own boundary (so the per-task review gates hold), but no intermediate commit is an independently *shippable* build. Do not open the PR until T6 is complete.
- [ ] **Full gate:** `bun run typecheck && bun run test && bun run lint && bun run build` — all green; `bunx tsc --noEmit --project worker/tsconfig.json` green.
- [ ] **No `inShop` remnants:** `grep -rn "inShop" sim/ game/ worker/` → empty.
- [ ] **Playtest (feel gate):** `bun run dev:coop` — by day, open the shop at the workbench, buy/draft/reroll (updates via snapshot), close and resume; no shop at night; two clients each shop independently with no global pause; a mid-day joiner gets a draft offer; SALVAGE/day cycle (Milestone A) still correct. **Blocking:** idle body at the daytime workbench feels safe.

## Notes for M-C (do NOT implement here)

- Drive the client auto-reconnect loop over `wsLink`; migrate `flashT` fully client-side; stale-comment triage (`sim/config.ts` host-authoritative + reconnect P4/host; `game/net/events.ts` roomfull; `game/net/client.ts` two-channel reconnect comments; `sim/engine/players.ts` game-over comments); delete the dead `gameover`/`clientGameOver`/`endRun` client path and the now-inert `requestDeploy`/`deploy` CoopEvent.
