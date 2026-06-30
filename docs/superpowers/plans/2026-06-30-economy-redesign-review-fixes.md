# Economy Redesign — PR #29 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the three review findings on PR #29 at their root cause — not by masking symptoms.

**Architecture:** Three independent root-cause fixes plus test hardening. (1) The SALVAGE pot is split by a player count that can diverge from the set of machines that actually bank it; we make the divisor and the recipient set share one definition via a pure, tested helper. (2) The nightly free-pick count is under-encoded on the wire as a single boolean, which silently caps `CONFIG.arsenal.freePicks` at 1; we promote it to a real `u8` counter so the CONFIG knob is genuinely tunable (data-driven principle). (3) The reroll-redraw-count semantics are correct but ambiguous; we make the intent explicit rather than change behavior, and route the feel call to playtest.

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess), Bun, Vitest, custom WebGL2 engine. Binary snapshot codec in `game/net/snapshot.ts`.

## Global Constraints

- **Single-player must stay byte-for-byte unchanged.** Any economy/co-op edit must leave the 1-player path identical (e.g. SALVAGE split by 1 non-absent player == old `total`).
- **Host-authoritative co-op.** Clients never re-simulate; they render synced snapshot fields only. No new client-side prediction.
- **Conscious PROTOCOL_VERSION bump discipline.** Any change to the snapshot wire layout MUST bump `PROTOCOL_VERSION` in `game/net/net.ts` AND update the golden inline snapshot in `game/net/snapshot.test.ts`. Never silence the golden test without bumping.
- **Data-driven, no special-case debt.** Ride existing seams (CONFIG knobs, the `StoreItem`/draft abstraction). Don't add bespoke branches.
- **Quality gates (all must pass before each commit):** `bun run typecheck`, `bun run lint` (zero warnings — `--error-on-warnings`), `bun run test`, `bun run build`.

---

### Task 1: SALVAGE split — one definition of "who banks"

**Root cause:** `gameOver` divides the pot by `state.players.length` (`game/game.ts:1333`), but `Host.broadcastGameOver` only reaches `this.links` (open clients; dropped links are spliced out in `host.ts` onClose). A teammate held `absent` during the reconnect grace window is counted in the divisor but receives nothing — present players are under-paid and the absent share leaks. The divisor and the recipient set are computed independently and can diverge. Fix: derive the share from a single pure helper, and feed it the count of **non-absent** players (== the machines that actually bank: host pid 0 is always non-absent, each open client is non-absent).

**Files:**
- Modify: `game/data/arsenal.ts` (add `salvageShare` next to `salvageEarned`, ~line 31)
- Modify: `game/game.ts:1329-1339` (`gameOver`) and the import block at `game/game.ts:7-13`
- Test: `game/data/arsenal.test.ts` (add cases near the existing `salvageEarned` test at line 88-93)

**Interfaces:**
- Produces: `salvageShare(total: number, recipients: number): number` — `Math.floor(total / Math.max(1, recipients))`. The `Math.max(1, …)` guard keeps a (theoretically impossible) zero-recipient call from dividing by zero; single-player passes `recipients = 1` → returns `total` unchanged.
- Consumes (in `gameOver`): `salvageEarned(day, kills)` (existing, `arsenal.ts:29`), `salvageShare` (new).

- [ ] **Step 1: Write the failing test**

In `game/data/arsenal.test.ts`, add `salvageShare` to the existing import from `"./arsenal"` (the line that currently imports `salvageEarned`), then add this block after the `salvageEarned` test (after line 93):

```ts
  it("salvageShare floors the pot across recipients (single-player == total)", () => {
    expect(salvageShare(100, 1)).toBe(100); // single-player: identical to the old total
    expect(salvageShare(100, 3)).toBe(33); // floored, never over-banks
    expect(salvageShare(7, 3)).toBe(2);
    expect(salvageShare(100, 0)).toBe(100); // guard: never divide by zero
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- arsenal`
Expected: FAIL — `salvageShare is not a function` (not exported yet).

- [ ] **Step 3: Add the pure helper**

In `game/data/arsenal.ts`, immediately after `salvageEarned` (after line 31), add:

```ts
/** A single player's banked share of a run's SALVAGE pot, split evenly across the `recipients`
 *  that actually bank it (the non-absent players == host + connected clients). Floored so co-op
 *  never over-banks; `Math.max(1, …)` guards the impossible zero-recipient case. */
export function salvageShare(total: number, recipients: number): number {
  return Math.floor(total / Math.max(1, recipients));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run test -- arsenal`
Expected: PASS.

- [ ] **Step 5: Wire `gameOver` to the helper + non-absent recipient count**

In `game/game.ts`, add `salvageShare` to the import from `"./data/arsenal"` (the block at lines 2-13, alongside `salvageEarned`).

Then replace the body of `gameOver` (`game/game.ts:1329-1339`). Current:

```ts
function gameOver(): void {
  // the run's SALVAGE is a party pot, split evenly (floor so co-op never over-banks);
  // each player banks their own share to their own localStorage via the gameover event.
  const total = salvageEarned(state.day, state.kills);
  const share = Math.floor(total / state.players.length);
  // money is per-player now; the debrief shows the squad's combined leftover credits
  // (in single-player that's just the one wallet → identical to before).
  const money = state.players.reduce((sum, p) => sum + p.money, 0);
  Net.host?.broadcastGameOver(share, state.day, state.kills, money);
  endRun(share, state.day, state.kills, money);
}
```

Replace with:

```ts
function gameOver(): void {
  // the run's SALVAGE is a party pot, split evenly (floor so co-op never over-banks);
  // each player banks their own share to their own localStorage via the gameover event.
  // INVARIANT: the players that actually bank == the non-absent set == {host (pid 0, never
  // absent)} ∪ {open client links}. Host.onClose marks a dropped client `absent` AND splices
  // its link out of the broadcast set in one synchronous handler, so the two stay in lockstep —
  // a teammate held `absent` mid-reconnect has no link, receives no gameover event, and must
  // therefore be excluded from the divisor or it dilutes the present players and leaks its share.
  // (Not unit-tested at this level — gameOver is DOM/Audio/Net-bound and net code is out of the
  // pure-test scope per CLAUDE.md; salvageShare carries the split's pure logic + its test.)
  const total = salvageEarned(state.day, state.kills);
  const recipients = state.players.reduce((n, p) => (p.absent ? n : n + 1), 0);
  const share = salvageShare(total, recipients);
  // money is per-player now; the debrief shows the squad's combined leftover credits
  // (in single-player that's just the one wallet → identical to before).
  const money = state.players.reduce((sum, p) => sum + p.money, 0);
  Net.host?.broadcastGameOver(share, state.day, state.kills, money);
  endRun(share, state.day, state.kills, money);
}
```

- [ ] **Step 6: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all PASS. (Single-player: `recipients` = 1 → `salvageShare(total, 1)` = `total`, identical to before.)

- [ ] **Step 7: Commit**

```bash
git add game/data/arsenal.ts game/data/arsenal.test.ts game/game.ts
git commit -m "fix(economy): split SALVAGE across non-absent recipients, not raw player count

The pot was divided by state.players.length, but a teammate held absent
during the reconnect grace window receives no gameover event (its link is
gone) — so present players were under-paid and the absent share leaked.
Extract a pure salvageShare(total, recipients) helper and feed it the
non-absent count (== the machines that actually bank). Single-player is
unchanged (recipients=1 → share=total).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 2: Promote the draft free-pick count to a real wire counter

**Root cause:** `captureSnapshot` projects `draftFreePicksUsed` to a single bit (`>= CONFIG.arsenal.freePicks`, `snapshot.ts:193`) packed into the player flag byte (bit2, `snapshot.ts:574`); `decode` reconstructs `freeUsed ? freePicks : 0` (`snapshot.ts:344,700`). This is lossless ONLY when `freePicks === 1`. The CONFIG knob `freePicks` therefore silently lies for any value ≥ 2 (a client mid-shop would show the wrong remaining-free count, desyncing its HUD from the host) — and nothing fails to warn you: the golden test hashes layout not values, and the round-trip test sets `draftFreePicksUsed = CONFIG.arsenal.freePicks` so it stays green at any value. Fix: send the real `u8` counter, removing the assumption entirely so the knob is genuinely tunable. This is a wire-layout change → PROTOCOL_VERSION bump + golden update.

**Files:**
- Modify: `game/net/snapshot.ts` — `SnapPlayer` interface (line 77-84), `captureSnapshot` (line 192-194), `encode` (line 571-574), `decode` (line 696-733), `applySnapshot` (line 344)
- Modify: `game/net/net.ts:19` (`PROTOCOL_VERSION`)
- Test: `game/net/snapshot.test.ts` — round-trip test (line 192-204) + golden inline snapshot (line 131-133)

**Interfaces:**
- Produces (wire): one new `u8` per player carrying `draftFreePicksUsed` (0..255, clamped). The flag byte loses bit2 (back to lightOn=bit0, absent=bit1 only).
- Consumes: `Player.draftFreePicksUsed` (existing, `types.ts:174`); `renderShop` already reads the real counter (`game/game.ts:1172,1181,1183`), so no UI change is needed once the client receives the true value.

- [ ] **Step 1: Update the round-trip test to assert the real counter (write the failing test)**

In `game/net/snapshot.test.ts`, replace the `"round-trips draft offer fields"` test (lines 192-204) with one that exercises a partial counter (the case the old boolean could never represent):

```ts
  it("round-trips draft offer fields incl. partial free-pick count", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    p.draftOffer = ["perk:hollowPoints", "lvl:pistol"];
    p.draftFreePicksUsed = 2; // a value the old 1-bit projection could not carry
    p.draftRerolls = 2;
    const back = decode(encode(captureSnapshot(s, 1)));
    const bp = back.players[0];
    if (!bp) throw new Error("decoded snapshot is missing player 0");
    expect(bp.draftOffer.map((i) => CARD_ORDER[i])).toEqual(["perk:hollowPoints", "lvl:pistol"]);
    expect(bp.draftFreePicksUsed).toBe(2);
    expect(bp.draftRerolls).toBe(2);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run test -- snapshot`
Expected: FAIL — `bp.draftFreePicksUsed` is `undefined` (field doesn't exist on the decoded snapshot yet), and the golden test ALSO fails (we'll fix that in Step 7).

- [ ] **Step 3: Replace the boolean field with the counter in `SnapPlayer`**

In `game/net/snapshot.ts`, replace lines 77-84 (the `draftOffer` + `draftFreeUsed` doc + field):

```ts
  /** between-nights draft offer, as CARD_ORDER indices */
  draftOffer: number[];
  /** WIRE PROJECTION of draftFreePicksUsed: true ⇔ no free picks remain this night. Host derives it
   *  at encode; client decodes it back to draftFreePicksUsed (0 or freePicks). This keeps the wire a
   *  single flag bit. NOTE: assumes CONFIG.arsenal.freePicks === 1. To support freePicks >= 2, promote
   *  this to a raw u8 counter (PROTOCOL_VERSION bump) and show remaining count in renderShop. */
  draftFreeUsed: boolean;
  draftRerolls: number;
```

with:

```ts
  /** between-nights draft offer, as CARD_ORDER indices */
  draftOffer: number[];
  /** free picks spent this night (raw u8; clients read it directly for the remaining-free count).
   *  Carried as its own byte so CONFIG.arsenal.freePicks is freely tunable — no single-bit assumption. */
  draftFreePicksUsed: number;
  draftRerolls: number;
```

- [ ] **Step 4: Capture the real value**

In `game/net/snapshot.ts` `captureSnapshot`, replace line 192-194:

```ts
      draftOffer: p.draftOffer.map((id) => CARD_ORDER.indexOf(id)).filter((i) => i >= 0),
      draftFreeUsed: p.draftFreePicksUsed >= CONFIG.arsenal.freePicks,
      draftRerolls: p.draftRerolls,
```

with:

```ts
      draftOffer: p.draftOffer.map((id) => CARD_ORDER.indexOf(id)).filter((i) => i >= 0),
      draftFreePicksUsed: p.draftFreePicksUsed,
      draftRerolls: p.draftRerolls,
```

- [ ] **Step 5: Encode the counter as a u8; drop bit2 from the flag byte**

In `game/net/snapshot.ts` `encode`, replace lines 571-574:

```ts
    w.u8(p.draftOffer.length);
    for (const ci of p.draftOffer) w.u8(ci);
    w.u8(Math.min(255, p.draftRerolls));
    w.u8((p.lightOn ? 1 : 0) | (p.absent ? 2 : 0) | (p.draftFreeUsed ? 4 : 0)); // flag byte: bit0 lightOn, bit1 absent, bit2 = free picks exhausted (projection of draftFreePicksUsed)
```

with:

```ts
    w.u8(p.draftOffer.length);
    for (const ci of p.draftOffer) w.u8(ci);
    w.u8(Math.min(255, p.draftRerolls));
    w.u8(Math.min(255, p.draftFreePicksUsed));
    w.u8((p.lightOn ? 1 : 0) | (p.absent ? 2 : 0)); // flag byte: bit0 lightOn, bit1 absent
```

- [ ] **Step 6: Decode the counter; drop bit2 read**

In `game/net/snapshot.ts` `decode`, replace lines 696-700:

```ts
    const draftRerolls = r.u8();
    const pflags = r.u8();
    const lightOn = (pflags & 1) === 1;
    const absent = (pflags & 2) !== 0;
    const draftFreeUsed = (pflags & 4) !== 0;
```

with:

```ts
    const draftRerolls = r.u8();
    const draftFreePicksUsed = r.u8();
    const pflags = r.u8();
    const lightOn = (pflags & 1) === 1;
    const absent = (pflags & 2) !== 0;
```

Then in the `players.push({ … })` object literal (lines 701-735), replace the `draftFreeUsed,` entry with `draftFreePicksUsed,` (it sits between `draftOffer,` and `draftRerolls,`).

- [ ] **Step 7: Apply the real counter on the client**

In `game/net/snapshot.ts` `applySnapshot`, replace line 344:

```ts
    p.draftFreePicksUsed = sp.draftFreeUsed ? CONFIG.arsenal.freePicks : 0;
```

with:

```ts
    p.draftFreePicksUsed = sp.draftFreePicksUsed;
```

- [ ] **Step 8: Bump PROTOCOL_VERSION**

In `game/net/net.ts`, change line 19:

```ts
export const PROTOCOL_VERSION = 12;
```

to:

```ts
export const PROTOCOL_VERSION = 13;
```

- [ ] **Step 9: Run the snapshot tests — read the new golden values**

Run: `bun run test -- snapshot`
Expected: the round-trip test now PASSES; the golden test FAILS with a new `len=`/`fnv=` (length grows by 1 byte per player → the 2-player golden snapshot goes `len=299` → `len=301`, and the fnv hash changes). Copy the EXACT `len=… fnv=…` string Vitest reports as "received".

- [ ] **Step 10: Update the golden inline snapshot**

In `game/net/snapshot.test.ts`, update the inline snapshot at lines 131-133 to the new value reported in Step 9. The length MUST read `len=301` (299 + 1 byte × 2 players); paste the exact `fnv` hash Vitest printed:

```ts
    expect(`len=${bytes.length} fnv=${(h >>> 0).toString(16)}`).toMatchInlineSnapshot(
      `"len=301 fnv=<paste-the-hash-vitest-reported>"`,
    );
```

(If the length is NOT 301, stop — the encode/decode edit is asymmetric; re-check Steps 5-6 before touching the hash.)

- [ ] **Step 11: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test && bun run build`
Expected: all PASS. `typecheck` confirms no remaining `draftFreeUsed` references (grep to be sure: `git grep draftFreeUsed` should return nothing).

- [ ] **Step 12: Commit**

```bash
git add game/net/snapshot.ts game/net/snapshot.test.ts game/net/net.ts
git commit -m "fix(net): send draft free-pick count as a u8, not a single bit

The wire projected draftFreePicksUsed to one flag bit (>= freePicks),
lossless only when CONFIG.arsenal.freePicks === 1 — so the knob silently
lied for any value >= 2 (client HUD desync) with nothing to warn you.
Promote it to a raw u8 counter so the CONFIG knob is genuinely tunable;
drop bit2 from the player flag byte. Wire layout changed → PROTOCOL_VERSION
12->13 + golden snapshot updated (len 299->301).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 3: Draft invariant test hardening (test-only)

**Root cause:** Several draft invariants a future refactor would silently break have no behavioral guard: cost escalation is only proven for a single reroll through `applyDraftReroll`; the paid-take path never asserts the card leaves the offer; the maxLevel cap via the (canBuy-skipping) free path is unguarded; and the deliberate "weapon cards resurface on reroll, perks don't" asymmetry is only half-tested. No production code changes — these pin existing behavior.

**Files:**
- Test: `game/game.draft.test.ts` (add to the existing `describe("draft apply (host-authoritative)")` block; existing tests run to line ~141)
- Test: `game/net/snapshot.test.ts` (add the `CARD_ORDER` stability test next to the existing `DEPLOYABLE_ORDER` one at line 271-278)

**Interfaces:**
- Consumes: `applyDraftTake`, `applyDraftReroll`, `rollDraft` (exported from `game/game.ts`), and the test setup pattern already used in this file (read the top of `game/game.draft.test.ts` for the `newState()` + local-player helpers it uses, and mirror it exactly). `CARD_ORDER` is already imported in `snapshot.test.ts:3`.

- [ ] **Step 1: Add the multi-reroll escalation test**

Read the existing `"reroll charges escalating SCRAP and redraws same count"` test (`game/game.draft.test.ts:52-62`) to copy its exact setup idiom (how it builds `s`, the player `p`, and sets `p.money`). Then add, after it:

```ts
  it("reroll cost escalates across consecutive rerolls (counter drives the price)", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    s.inShop = true;
    rollDraft(s, p);
    p.money = 200;
    expect(applyDraftReroll(s, p)).toBe(true); // 1st reroll: rerollBase (30)
    expect(applyDraftReroll(s, p)).toBe(true); // 2nd reroll: rerollBase + rerollStep (55)
    expect(p.draftRerolls).toBe(2);
    expect(p.money).toBe(200 - 30 - 55); // 115 — proves the 2nd read the incremented counter
  });
```

(Adjust the `newState()`/player setup lines to match the file's existing idiom if it differs — e.g. if other tests obtain `p` via a helper, use that helper.)

- [ ] **Step 2: Add the paid-take offer-removal assertion**

Read the existing `"second take costs SCRAP …"` test (`game/game.draft.test.ts:31`). Add, after it:

```ts
  it("a paid take removes the card from the offer", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    s.inShop = true;
    rollDraft(s, p);
    p.draftOffer = ["perk:fieldMedic", "perk:hollowPoints"];
    p.draftFreePicksUsed = CONFIG.arsenal.freePicks; // free picks spent → next take is paid
    p.money = 1000;
    expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(true);
    expect(p.draftOffer).not.toContain("perk:fieldMedic");
  });
```

Ensure `CONFIG` is imported at the top of the test file (check the existing import block; the parameterized-freePicks test at line 73 already references `CONFIG.arsenal.freePicks`, so it should be imported — reuse that import).

- [ ] **Step 3: Add the maxLevel-via-free-pick guard**

```ts
  it("a free pick cannot push a weapon past maxLevel (cardItem gates it)", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    s.inShop = true;
    p.wlevel.pistol = CONFIG.arsenal.maxLevel; // already maxed
    p.draftOffer = ["lvl:pistol"];
    p.draftFreePicksUsed = 0; // a free pick is available
    expect(applyDraftTake(s, p, "lvl:pistol")).toBe(false); // rejected before the free branch
    expect(p.wlevel.pistol).toBe(CONFIG.arsenal.maxLevel); // unchanged
  });
```

- [ ] **Step 4: Add the weapon-card-resurfaces-on-reroll test**

This pins the other half of the f5c8082 fix (perks go into `draftTaken` and can't resurface; weapon `lvl:` cards do NOT and may be re-offered/re-upgraded the same night):

```ts
  it("a taken weapon card is NOT recorded in draftTaken (may resurface on reroll)", () => {
    const s = newState();
    const p = s.players[0] as State["players"][number];
    s.inShop = true;
    s.owned.pistol = true;
    rollDraft(s, p);
    p.draftOffer = ["lvl:pistol"];
    p.draftFreePicksUsed = 0; // take it free
    expect(applyDraftTake(s, p, "lvl:pistol")).toBe(true);
    expect(p.draftTaken).not.toContain("lvl:pistol"); // weapon cards are intentionally not excluded
    expect(p.wlevel.pistol).toBe(1); // the upgrade applied
  });
```

- [ ] **Step 5: Pin CARD_ORDER's append-only wire index**

`CARD_ORDER` (`arsenal.ts:174`) is the snapshot defId wire index for `draftOffer` — reordering `UPGRADES` or `WEAPON_ORDER` desyncs host↔client silently (the golden snapshot uses an empty offer, so it can't catch this). `DEPLOYABLE_ORDER` has exactly this guard (`snapshot.test.ts:271-278`); `CARD_ORDER` is missing it, and Task 2 just touched this wire. Mirror the existing test — add to `game/net/snapshot.test.ts`, right after the `DEPLOYABLE_ORDER` test (after line 278):

```ts
  it("CARD_ORDER index is append-only stable (perks first, then weapon upgrades)", () => {
    // CARD_ORDER IS the draftOffer wire index. Reordering UPGRADES or WEAPON_ORDER desyncs
    // silently (the golden uses an empty offer, so it can't catch this) — pin the layout here.
    expect(CARD_ORDER[0]).toBe("perk:fieldMedic"); // UPGRADES[0]
    expect(CARD_ORDER[6]).toBe("perk:scavenger"); // last perk (UPGRADES has 7)
    expect(CARD_ORDER[7]).toBe("lvl:pistol"); // first upgradeable weapon (knife is melee → excluded)
    expect(CARD_ORDER.filter((id) => id.startsWith("lvl:"))).not.toContain("lvl:knife");
  });
```

- [ ] **Step 6: Run the draft + snapshot tests**

Run: `bun run test -- draft snapshot`
Expected: all PASS, including the four new draft tests and the CARD_ORDER test. If any setup line mismatches the file's idiom (e.g. a player accessor), fix it to match the existing tests — do not change production code. (If the CARD_ORDER assertions fail, the data tables were reordered — that's a real wire-stability signal, not a test bug: re-confirm append-only before adjusting the expected ids.)

- [ ] **Step 7: Run the full gate**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add game/game.draft.test.ts game/net/snapshot.test.ts
git commit -m "test(draft): pin reroll escalation, paid-take removal, maxLevel cap, weapon resurface, CARD_ORDER

Guards five invariants a refactor would otherwise break silently: cost
escalation read across two consecutive applyDraftReroll calls; a paid take
removes its card from the offer; a free pick cannot exceed maxLevel (the
free path skips canBuy, so cardItem's undefined gate is the only guard);
weapon (lvl:) cards are intentionally absent from draftTaken so they can
resurface and be re-upgraded the same night; and CARD_ORDER's append-only
wire index (mirrors the existing DEPLOYABLE_ORDER guard the draft wire lacked).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 4: Reroll offer-size — surface the behavior as an open design decision

**Root cause (of the *finding*):** `applyDraftReroll` redraws `buyer.draftOffer.length` cards (`game/game.ts:1163`), so taking a card before rerolling permanently shrinks the hand (3→2), and — because `rollOffer` returns fewer than `n` when the pool runs low (`arsenal.ts:154`) and perks taken this night are `exclude`d — the offer can keep shrinking on repeated rerolls. This is **not a correctness bug** (host-authoritative, consistent, no exploit), but whether it's *good design* is genuinely unresolved: there is a real order-dependence (reroll-before-pick sees a fuller hand than reroll-after-pick). That can read either as a fair roguelike timing choice (common in the genre) or as an optimization trap. The git history doesn't record which was intended, so we will NOT assert "deliberate." The honest root issue is an **undocumented, unvalidated behavior** — we surface both readings in the code and escalate the call to playtest as a design decision, not a feel nicety. **No behavior change** in this task.

**Files:**
- Modify: `game/game.ts:1155-1167` (the `applyDraftReroll` docstring)
- Modify: the manual-playtest checklist (a `## Playtest` note in `docs/superpowers/specs/2026-06-30-economy-redesign-design.md`)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Document the behavior neutrally (both readings) in the docstring**

In `game/game.ts`, replace the `applyDraftReroll` doc comment (lines 1155-1157):

```ts
/** Apply a draft reroll host-authoritatively: charge escalating SCRAP, bump the reroll counter,
 *  and redraw the same number of cards the buyer currently has shown. */
```

with:

```ts
/** Apply a draft reroll host-authoritatively: charge escalating SCRAP, bump the reroll counter,
 *  and redraw the cards the buyer currently has SHOWN (`draftOffer.length`). CONSEQUENCE: taking a
 *  card before rerolling permanently shrinks the hand (3 → 2), and the pool/exclude rules can shrink
 *  it further on repeated rerolls. This is host-authoritative and consistent (no correctness issue),
 *  but it is order-dependent: rerolling before a pick sees a fuller hand than rerolling after. Whether
 *  that asymmetry is a fair timing choice or an optimization trap is an OPEN design decision pending
 *  playtest (see the economy spec). The alternative is to always redraw a full hand:
 *  `rollOffer(draftPool(s, buyer), CONFIG.arsenal.offerSize, buyer.draftTaken)`. */
```

- [ ] **Step 2: Escalate it as a design decision in the spec's playtest section**

Add a `## Playtest decisions` note to `docs/superpowers/specs/2026-06-30-economy-redesign-design.md` (append at the end of the file):

```markdown
## Playtest decisions (open)

- [ ] **Reroll hand-size semantics (DECISION, not just feel).** Current: reroll redraws
      `draftOffer.length` (the unclaimed hand), so take-then-reroll shrinks 3→2 and can shrink
      further on repeat. Decide between (a) keep current — reroll re-rolls only the unclaimed hand,
      order-dependent by design; (b) redraw a full `CONFIG.arsenal.offerSize` hand every reroll —
      order-independent, one-line change in `applyDraftReroll` (see its docstring). Validate which
      reads better in a real draft session before sign-off.
```

- [ ] **Step 3: Run the gate (docs-only, but confirm nothing broke)**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: all PASS (no behavior changed).

- [ ] **Step 4: Commit**

```bash
git add game/game.ts docs/superpowers/specs/2026-06-30-economy-redesign-design.md
git commit -m "docs(draft): surface reroll hand-shrink as an open design decision

Reroll redraws draftOffer.length (the unclaimed hand), so take-then-reroll
shrinks the offer 3->2 and can shrink further on repeat. It's host-
authoritative and consistent (no correctness bug) but order-dependent, and
the history doesn't record whether that was intended — so document both
readings neutrally and escalate the keep-vs-redraw-full-hand call to a
playtest design decision rather than asserting intent.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

## Self-Review

**Finding coverage:**
- Finding #1 (SALVAGE absent-player dilution/leak) → Task 1 (root cause: divisor ≠ recipient set → one pure helper + non-absent count). ✓
- Finding #3 / wire (`freePicks===1` assumption) → Task 2 (root cause: counter under-encoded as a bool → real u8 + protocol bump). ✓
- Finding #2 (reroll offer-shrink) → Task 4 (root cause: unstated intent → explicit doc + playtest, no symptomatic code patch). ✓
- Test gaps (reroll escalation multi-step; paid-take removal; maxLevel via free pick; weapon resurface) → Task 3. ✓
- Test gap "salvage split untestable because gameOver is unexported" → resolved by Task 1's `salvageShare` extraction + its test. ✓
- Test gap "draftFreeUsed only tested in the exhausted direction" → resolved by Task 2's partial-counter round-trip test. ✓
- Rubber-duck blind spot: `CARD_ORDER` wire index had no append-only stability test (unlike `DEPLOYABLE_ORDER`) → added in Task 3 Step 5. ✓
- Rubber-duck note: the reroll button is always clickable, `.off` is cosmetic (`game/game.ts:1199-1201`). **Verified harmless — no action:** `applyDraftReroll` rejects `money < cost` host-authoritatively (`game/game.ts:1160`), so a click while broke is a no-op. Changing the UI would be the symptomatic fix; the real defense already exists server-side.
- Rubber-duck correction (Task 1): the duck suggested an integration test asserting `non-absent count == links + 1`. Declined — per CLAUDE.md net code is outside the pure-test scope; the invariant is instead documented at `gameOver` (Task 1 Step 5 comment), which is the in-culture weight. The duck also confirmed the "link dropped but not yet absent-marked" race does NOT exist (`Host.onClose` marks absent + splices the link atomically).

**Placeholder scan:** No TBD/TODO; every code step shows the exact before/after. The only deferred value is the golden `fnv` hash in Task 2 Step 10 — unavoidable (it's an output of the new encoding), with the exact procedure, the expected `len=301` invariant, and a stop-condition if the length is wrong.

**Type consistency:** `salvageShare(total, recipients): number` defined in Task 1 Step 3, consumed in Step 5 with matching arity. `draftFreePicksUsed: number` replaces `draftFreeUsed: boolean` consistently across `SnapPlayer` (Task 2 S3), `captureSnapshot` (S4), `encode` (S5), `decode` (S6), `applySnapshot` (S7) — `git grep draftFreeUsed` returns nothing after Task 2 (verified in S11).

**Single-player invariant:** Task 1 `recipients=1 → share=total` (unchanged). Task 2 changes the wire only, which single-player never encodes/decodes. Task 3 is test-only. Task 4 is docs-only. ✓

**Independence:** Tasks 1, 2, 3, 4 touch disjoint files (arsenal/game; net; draft test; game docstring+docs) and can be done/reviewed in any order or in parallel.
