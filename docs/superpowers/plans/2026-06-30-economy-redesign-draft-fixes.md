# ドラフト経済 根本修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PR #29 コードレビューで出た 4 指摘を、対症療法を避け根本原因から修正する。

**Architecture:** `Player` の「その夜のドラフト状態」を再モデル化する。無料ピックを bool から `draftFreePicksUsed: number` に変えて `CONFIG.arsenal.freePicks` を実レバー化し、取得済みカードを記録する `draftTaken: string[]`（host 専用・snapshot 非同期）を追加して、リロールが取得済み perk を再提示し二重適用するバグを塞ぐ。武器述語を 1 つに統一し、消失した buyer-isolation テストを復元する。snapshot は host カウンタ＋派生 bool で wire 不変（PROTOCOL_VERSION 12 据え置き・golden test 不変）。

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess) / Bun / Vite / Vitest（pure 関数のみ）/ Biome。

**Spec:** [`docs/superpowers/specs/2026-06-30-economy-redesign-draft-fixes-design.md`](../specs/2026-06-30-economy-redesign-draft-fixes-design.md)

## Global Constraints

- `bun run typecheck`（`tsc --noEmit`）と `bun run lint`（biome）が通ること。
- **single-player byte-identical**：co-op コードを触っても SP 挙動を変えない。systems（`sysPlayer`/`sysAI`/…）は touch しない。
- **wire 不変**：`PROTOCOL_VERSION` は 12 のまま。`snapshot.test.ts` の golden byte test が不変であること（符号化バイトを変えない）。
- テストは **pure・決定的** な範囲のみ（CLAUDE.md のテスト方針）。各タスク末でコミット。
- チューニングは `CONFIG` 経由（systems に定数を埋めない）。
- perk の `apply` は乗算的（`dmgMul *= 1.25` 等）。`UPGRADES` の `id`：`fieldMedic`/`hollowPoints`/`adrenaline` は `starter: true`、`quickHands` 等は `starter: false`。
- 既存の純関数：`rollOffer(pool, n, exclude = [], rng = Math.random)`（`game/data/arsenal.ts`）— `avail = pool.filter(it => !exclude.includes(it.id))` してから partial Fisher–Yates で最大 n 枚（pool < n は在るだけ返す）。`rerollCost(rerolls)`、`draftPool(state, buyer)`、`cardItem(state, buyer, id)`、`CARD_ORDER`。
- 実行コマンド：単体は `bunx vitest run <file>`、全体は `bun run test`。

---

### Task 1: 武器述語の単一化 `isUpgradeableWeapon`（指摘 3）

`CARD_ORDER`（`!WEAPONS[id]?.melee`：未定義 id を取りこぼせず混入）と `draftPool`（`!w || w.melee`：正しく存在チェック）の述語不一致を、共有述語で解消する。独立タスク（状態モデル変更に依存しない）。

**Files:**
- Modify: `game/data/weapons.ts`（`WEAPON_ORDER` 定義の直後、line 249 付近に追加）
- Modify: `game/data/arsenal.ts`（import line 5、`draftPool` line 133 付近、`CARD_ORDER` line 175 付近）
- Test: `game/data/arsenal.test.ts`

**Interfaces:**
- Produces: `export const isUpgradeableWeapon = (id: string): boolean`（`game/data/weapons.ts`）

- [ ] **Step 1: 失敗するテストを書く**

`game/data/arsenal.test.ts` の先頭 import に `isUpgradeableWeapon` を加え（`import { ... } from "./weapons";` が無ければ新規行）、末尾に追加：

```ts
import { isUpgradeableWeapon } from "./weapons";

describe("isUpgradeableWeapon", () => {
  it("includes a ranged weapon defined in WEAPONS", () => {
    expect(isUpgradeableWeapon("pistol")).toBe(true);
  });
  it("excludes the melee weapon", () => {
    expect(isUpgradeableWeapon("knife")).toBe(false);
  });
  it("excludes an id with no WEAPONS entry", () => {
    expect(isUpgradeableWeapon("nonexistent")).toBe(false);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `bunx vitest run game/data/arsenal.test.ts -t isUpgradeableWeapon`
Expected: FAIL（`isUpgradeableWeapon` is not exported）

- [ ] **Step 3: 述語を `weapons.ts` に追加**

`game/data/weapons.ts` の `export const WEAPON_ORDER = [...]`（line 249）の直後に：

```ts
/** A weapon id that can receive upgrade (`lvl:`) draft cards: exists in WEAPONS and is not melee.
 *  Shared by CARD_ORDER (the snapshot wire index) and draftPool so the two never diverge on the
 *  membership test — a WEAPON_ORDER id missing from WEAPONS is excluded from both, not silently
 *  injected into CARD_ORDER. */
export const isUpgradeableWeapon = (id: string): boolean => {
  const w = WEAPONS[id];
  return w != null && !w.melee;
};
```

- [ ] **Step 4: `arsenal.ts` で使用**

import を更新（line 5）：

```ts
import { isUpgradeableWeapon, WEAPON_ORDER, WEAPONS } from "./weapons";
```

`CARD_ORDER`（line 175 付近）を：

```ts
export const CARD_ORDER: string[] = [
  ...UPGRADES.map((u) => `perk:${u.id}`),
  ...WEAPON_ORDER.filter(isUpgradeableWeapon).map((id) => `lvl:${id}`),
];
```

`draftPool` の武器ループ（line 133 付近）を：

```ts
  for (const id of WEAPON_ORDER) {
    if (!isUpgradeableWeapon(id) || !state.owned[id]) continue;
    const it = cardItem(state, buyer, `lvl:${id}`); // undefined if maxed → skipped
    if (it) items.push(it);
  }
```

（`WEAPONS` は `cardItem` で引き続き使うので import から外さない。）

- [ ] **Step 5: テストが通ることを確認**

Run: `bunx vitest run game/data/arsenal.test.ts`
Expected: PASS（既存 `rollOffer`/`cardItem`/`draftPool` テスト含め全緑）

- [ ] **Step 6: コミット**

```bash
git add game/data/weapons.ts game/data/arsenal.ts game/data/arsenal.test.ts
git commit -m "fix(arsenal): unify weapon-upgrade predicate (CARD_ORDER vs draftPool)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 2: `CONFIG.arsenal.freePicks` の配線（`draftFreeUsed` → `draftFreePicksUsed`、指摘 2）

死んだ設定値 `freePicks` を実レバー化する。`draftFreeUsed: boolean` を `draftFreePicksUsed: number` に rename し、無料判定を `draftFreePicksUsed < CONFIG.arsenal.freePicks` にする。snapshot は host カウンタ＋派生 bool で wire 不変。**rename なので全参照（game.ts / snapshot.ts / 既存テスト）を一括更新する** — 1 箇所でも残すと型エラーで `bun run typecheck` が落ちる。

**Files:**
- Modify: `game/types.ts`（line 172-173）
- Modify: `game/engine/players.ts`（line 61）
- Modify: `game/game.ts`（`applyDraftTake` doc コメント line 1129-1132、`rollDraft` line 1125、`applyDraftTake` line 1138-1145、`renderShop` line 1165/1171/1173）
- Modify: `game/net/snapshot.ts`（`SnapPlayer` line 79、capture line 189、apply line 340、binary encode line 570）
- Modify: `index.html`（`#shop-free` 初期文言 line 116）
- Modify: `game/game.draft.test.ts`（既存アサーション line 12/24/34）
- Modify: `game/net/snapshot.test.ts`（line 195）
- Test: `game/game.draft.test.ts`（新規 freePicks テスト）

**Interfaces:**
- Consumes: なし（Task 1 と独立）
- Produces: `Player.draftFreePicksUsed: number`（`draftFreeUsed: boolean` を置換）。無料判定は `buyer.draftFreePicksUsed < CONFIG.arsenal.freePicks`。`SnapPlayer.draftFreeUsed: boolean` は wire 射影として温存。

- [ ] **Step 1: 失敗するテストを書く**

`game/game.draft.test.ts` の import に `CONFIG` を追加（先頭）：

```ts
import { CONFIG } from "./config";
```

`describe` ブロック内に追加：

```ts
it("honors CONFIG.arsenal.freePicks for the number of free picks", () => {
  const orig = CONFIG.arsenal.freePicks;
  CONFIG.arsenal.freePicks = 2;
  try {
    const s = newState();
    s.inShop = true;
    const p = localPlayer(s);
    p.money = 0;
    p.draftOffer = ["perk:hollowPoints", "perk:fieldMedic", "perk:adrenaline"];
    expect(applyDraftTake(s, p, "perk:hollowPoints")).toBe(true); // free 1
    expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(true); // free 2
    expect(p.money).toBe(0);
    expect(applyDraftTake(s, p, "perk:adrenaline")).toBe(false); // 3rd costs SCRAP, broke
    p.money = 80;
    expect(applyDraftTake(s, p, "perk:adrenaline")).toBe(true); // paid
    expect(p.money).toBe(0);
  } finally {
    CONFIG.arsenal.freePicks = orig; // assertion throw でも必ず復元（同ファイル後続の汚染防止）
  }
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `bunx vitest run game/game.draft.test.ts -t "honors CONFIG.arsenal.freePicks"`
Expected: FAIL（現状 `draftFreeUsed` bool で無料は 1 回だけ → 2 回目の free take が `false` になり money 課金される）

- [ ] **Step 3: フィールドを rename して配線**

`game/types.ts`（line 172-173）を置換：

```ts
  /** how many free picks this player has spent this night (free while < CONFIG.arsenal.freePicks,
   *  then cards cost SCRAP). Reset each night by rollDraft. */
  draftFreePicksUsed: number;
```

`game/engine/players.ts`（line 61）`draftFreeUsed: false,` を：

```ts
    draftFreePicksUsed: 0,
```

`game/game.ts` `applyDraftTake` の doc コメント（line 1129-1132）の死語 `draftFreeUsed` を更新：

```ts
/**
 * Apply a draft "take" host-authoritatively. The first CONFIG.arsenal.freePicks takes of the night
 * are FREE (counted by draftFreePicksUsed); further takes cost SCRAP (canBuy-gated). The card must
 * be in the buyer's current offer. Returns false (changing nothing) on any guard miss.
 */
```

`game/game.ts` `rollDraft`（line 1125）`p.draftFreeUsed = false;` を：

```ts
  p.draftFreePicksUsed = 0;
```

`game/game.ts` `applyDraftTake` の free/paid 分岐（line 1138-1145）を：

```ts
  if (buyer.draftFreePicksUsed < CONFIG.arsenal.freePicks) {
    it.buy(s, buyer);
    buyer.draftFreePicksUsed += 1;
  } else {
    if (!it.canBuy(s, buyer)) return false;
    buyer.money -= it.price;
    it.buy(s, buyer);
  }
```

`game/game.ts` `renderShop`：

line 1165 を残数表示に：

```ts
  const freeLeft = Math.max(0, CONFIG.arsenal.freePicks - me.draftFreePicksUsed);
  el("shop-free").textContent = freeLeft > 0 ? `${freeLeft} free pick${freeLeft > 1 ? "s" : ""}` : "free picks used";
```

line 1171 の `cardKey`（差分キー）を — **`draftFreePicksUsed` を含めないと無料消費後にカードが再描画されず古い FREE/価格表示が残る**：

```ts
  const cardKey = (it: StoreItem) => `${it.id}:${it.price}:${me.draftFreePicksUsed < CONFIG.arsenal.freePicks ? 1 : 0}`;
```

line 1173 を：

```ts
    const free = me.draftFreePicksUsed < CONFIG.arsenal.freePicks;
```

`index.html` line 116 の `#shop-free` 初期文言（ハードコードの "1 free pick"）を空にする — `renderShop` が残数表示で必ず上書きするので、`freePicks` を変えても shop を開く直前に古い "1 free pick" が出ない：

```html
  <p>Scrap <b id="shop-credits" style="color:var(--amber)">0</b> &middot; <span id="shop-free"></span></p>
```

- [ ] **Step 4: snapshot を派生 bool 射影に（wire 不変）**

`game/net/snapshot.ts` `SnapPlayer`（line 79）にコメントを付けて温存：

```ts
  /** WIRE PROJECTION of draftFreePicksUsed: true ⇔ no free picks remain this night. Host derives it
   *  at encode; client decodes it back to draftFreePicksUsed (0 or freePicks). This keeps the wire a
   *  single flag bit. NOTE: assumes CONFIG.arsenal.freePicks === 1. To support freePicks >= 2, promote
   *  this to a raw u8 counter (PROTOCOL_VERSION bump) and show remaining count in renderShop. */
  draftFreeUsed: boolean;
```

capture（line 189）を：

```ts
      draftFreeUsed: p.draftFreePicksUsed >= CONFIG.arsenal.freePicks,
```

applySnapshot（line 340）を：

```ts
    p.draftFreePicksUsed = sp.draftFreeUsed ? CONFIG.arsenal.freePicks : 0;
```

binary encode（line 570）を（コメントも更新）：

```ts
    w.u8((p.lightOn ? 1 : 0) | (p.absent ? 2 : 0) | (p.draftFreePicksUsed >= CONFIG.arsenal.freePicks ? 4 : 0)); // flag byte: bit0 lightOn, bit1 absent, bit2 = free picks exhausted (projection of draftFreePicksUsed)
```

（binary decode line 689-696 と SnapPlayer 構築 line 729 は `draftFreeUsed` bool のまま変更不要。`CONFIG` は snapshot.ts line 1 で import 済み。）

- [ ] **Step 5: 既存テストの `draftFreeUsed` 参照を射影へ更新**

`game/game.draft.test.ts`：
- line 12 `expect(p.draftFreeUsed).toBe(false);` → `expect(p.draftFreePicksUsed).toBe(0);`
- line 24 `expect(p.draftFreeUsed).toBe(true);` → `expect(p.draftFreePicksUsed).toBe(1);`
- line 34 `p.draftFreeUsed = true;` → `p.draftFreePicksUsed = CONFIG.arsenal.freePicks;`

`game/net/snapshot.test.ts`：
- 先頭 import に `import { CONFIG } from "../config";` を追加（無ければ）
- line 195 `p.draftFreeUsed = true;` → `p.draftFreePicksUsed = CONFIG.arsenal.freePicks;`
- line 200 `expect(bp.draftFreeUsed).toBe(true);` は **そのまま**（`bp` は SnapPlayer 射影で温存）

- [ ] **Step 6: 全テスト＋型チェックが通ることを確認**

Run: `bun run typecheck && bun run test`
Expected: PASS（新 freePicks テスト緑、既存全緑、`snapshot.test.ts` の golden byte test 不変）

- [ ] **Step 7: コミット**

```bash
git add game/types.ts game/engine/players.ts game/game.ts game/net/snapshot.ts index.html game/game.draft.test.ts game/net/snapshot.test.ts
git commit -m "fix(arsenal): wire up CONFIG.arsenal.freePicks (draftFreePicksUsed counter)

Replaces the draftFreeUsed boolean with a per-night counter so the
freePicks config knob actually drives behavior. Wire stays a single
flag bit (host derives, client decodes) so PROTOCOL_VERSION/golden
snapshot are unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 3: リロールが取得済み perk を再提示しないようにする（`draftTaken`、指摘 1 — 主バグ）

その夜に取得した perk を `draftTaken` に記録し、リロール時に `rollOffer` の `exclude` へ渡す。これで取得済み perk の再出現＝二重適用（`dmgMul *= 1.25` の倍掛け）を構造的に塞ぐ。`draftTaken` は host 専用・snapshot 非同期（client は reroll を適用しない）。weapon (`lvl:`) カードは記録しない（`canBuy` が maxLevel をガード、§3.5 の perk-only 判断）。

**Files:**
- Modify: `game/types.ts`（draft フィールド群の末尾、`draftRerolls` の後）
- Modify: `game/engine/players.ts`（`makePlayer` の draft 初期化、line 62 付近）
- Modify: `game/game.ts`（`rollDraft` line 1126、`applyDraftTake` line 1146 付近、`applyDraftReroll` line 1158）
- Test: `game/game.draft.test.ts`

**Interfaces:**
- Consumes: `Player.draftFreePicksUsed`（Task 2）、`rollOffer(pool, n, exclude, rng)`、`draftPool`
- Produces: `Player.draftTaken: string[]`。`rollDraft` がリセット、`applyDraftTake` が perk take を記録、`applyDraftReroll` が `exclude` に渡す。

- [ ] **Step 1: 失敗するテストを書く**

`game/game.draft.test.ts` に追加：

```ts
it("rollDraft clears draftTaken from the prior night", () => {
  const s = newState();
  const p = localPlayer(s);
  p.draftTaken = ["perk:hollowPoints"];
  rollDraft(s, p);
  expect(p.draftTaken).toEqual([]);
});

it("reroll never re-offers a perk taken this night (free path)", () => {
  const s = newState();
  s.inShop = true;
  const p = localPlayer(s);
  p.money = 1000;
  rollDraft(s, p); // resets draftTaken + free counter
  p.draftOffer = ["perk:hollowPoints", "perk:fieldMedic", "perk:adrenaline"];
  expect(applyDraftTake(s, p, "perk:hollowPoints")).toBe(true); // free
  expect(applyDraftReroll(s, p)).toBe(true);
  expect(p.draftOffer).not.toContain("perk:hollowPoints");
});

it("reroll never re-offers a perk taken this night (paid path)", () => {
  const s = newState();
  s.inShop = true;
  const p = localPlayer(s);
  p.draftFreePicksUsed = CONFIG.arsenal.freePicks; // force the paid branch
  p.money = 1000;
  p.draftOffer = ["perk:hollowPoints", "perk:fieldMedic", "perk:adrenaline"];
  expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(true); // paid
  expect(applyDraftReroll(s, p)).toBe(true);
  expect(p.draftOffer).not.toContain("perk:fieldMedic");
});
```

（除外は rng に依存しない：`rollOffer` が `avail` から exclude を先に除くので、取得済み id は結果に絶対入らない。`fieldMedic`/`hollowPoints`/`adrenaline` は starter perk なので必ず pool にいる＝テストは決定的。`CONFIG` import は Task 2 で追加済み。）

- [ ] **Step 2: テストが落ちることを確認**

Run: `bunx vitest run game/game.draft.test.ts -t "draftTaken"`
Expected: FAIL（`p.draftTaken` が undefined）。reroll テストも FAIL（exclude 未指定で再出現しうる／`draftTaken` 未定義）

- [ ] **Step 3: `draftTaken` フィールドを追加**

`game/types.ts` の `draftRerolls: number;`（line 175）の後に：

```ts
  /** card ids this player has TAKEN this night (PERK ids only). Host-only roll state, NOT
   *  snapshot-synced: only the host rolls/rerolls so clients never read it (makePlayer inits it to
   *  []). Reset each night by rollDraft; passed as `exclude` to rollOffer on reroll so a taken perk
   *  cannot resurface and stack within one night. Weapon (`lvl:`) cards are intentionally excluded
   *  from this list — they are maxLevel-capped by canBuy and may be re-upgraded the same night. */
  draftTaken: string[];
```

`game/engine/players.ts` の `makePlayer` draft 初期化（`draftRerolls: 0,` の後、line 62 付近）に：

```ts
    draftTaken: [],
```

- [ ] **Step 4: ロジックを実装**

`game/game.ts` `rollDraft`（`p.draftRerolls = 0;` の後、line 1126 付近）に：

```ts
  p.draftTaken = [];
```

`game/game.ts` `applyDraftTake` の取得確定後（free/paid 分岐の後、`buyer.draftOffer = buyer.draftOffer.filter(...)` の直前、line 1146）に：

```ts
  // Record perk takes so a reroll can't resurface them (perks have no per-night cap, so a
  // re-offered perk could be taken again and stack). Weapon (`lvl:`) cards are intentionally NOT
  // recorded — canBuy caps them at maxLevel and they may be upgraded again the same night.
  if (cardId.startsWith("perk:")) buyer.draftTaken.push(cardId);
```

`game/game.ts` `applyDraftReroll`（line 1158）の redraw を：

```ts
  buyer.draftOffer = rollOffer(draftPool(s, buyer), buyer.draftOffer.length, buyer.draftTaken).map(
    (it) => it.id,
  );
```

- [ ] **Step 5: テストが通ることを確認**

Run: `bun run typecheck && bunx vitest run game/game.draft.test.ts`
Expected: PASS（取得済み除外の free/paid 両経路が緑、既存 draft テスト全緑）

- [ ] **Step 6: コミット**

```bash
git add game/types.ts game/engine/players.ts game/game.ts game/game.draft.test.ts
git commit -m "fix(arsenal): reroll excludes perks already taken this night

applyDraftReroll passed no exclude to rollOffer, so a taken perk could
resurface and (perks being uncapped per night) be taken again, stacking
its multiplier. Track perk takes in Player.draftTaken (host-only, not
synced) and pass them as exclude on reroll.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 4: buyer-isolation 回帰テストの復元（指摘 4）

commit `b8226c9`（個人ウォレット）の回帰ガードが PR で消失した。perk は `applyBuy` から `applyDraftTake` へ移ったので、復元先は `applyDraftTake`（perk）と `applyBuy`（Fortify）の両方。**これらは既に正しい挙動を守るガードなので初回実行で PASS する**（fail-first にならないのは正常）。落ちたら隔離が壊れている証拠。

**Files:**
- Modify: `game/game.draft.test.ts`（2 人 perk 隔離）
- Modify: `game/game.test.ts`（Fortify 隔離）
- Test: 上記 2 ファイル

**Interfaces:**
- Consumes: `addPlayer(state, id, x, y, name?)`（`game/engine/players.ts`）、`applyDraftTake`、`applyBuy`

- [ ] **Step 1: テストを書く（perk 隔離）**

`game/game.draft.test.ts` の import を更新（`addPlayer` を追加）：

```ts
import { addPlayer, localPlayer } from "./engine/players";
```

`describe` 内に追加：

```ts
it("a perk take applies to the buyer only, not a teammate", () => {
  const s = newState();
  s.inShop = true;
  const buyer = localPlayer(s);
  const mate = addPlayer(s, 1, 0, 0);
  const mateDmg = mate.dmgMul;
  const mateHp = mate.maxHp;
  const mateMoney = mate.money;
  buyer.money = 0;
  buyer.draftOffer = ["perk:hollowPoints"]; // +25% dmg, free
  expect(applyDraftTake(s, buyer, "perk:hollowPoints")).toBe(true);
  expect(buyer.dmgMul).toBeCloseTo(1.25);
  expect(mate.dmgMul).toBe(mateDmg); // teammate untouched
  expect(mate.maxHp).toBe(mateHp);
  expect(mate.money).toBe(mateMoney);
});
```

- [ ] **Step 2: テストを書く（Fortify 隔離）**

`game/game.test.ts` の import を更新：

```ts
import { addPlayer, localPlayer } from "./engine/players";
```

`describe` 内に追加：

```ts
it("a fortification buy queues for the buyer only, not a teammate", () => {
  const s = newState();
  s.inShop = true;
  const buyer = localPlayer(s);
  const mate = addPlayer(s, 1, 0, 0);
  const mateMoney = mate.money;
  buyer.money = 100;
  expect(applyBuy(s, fortId, buyer)).toBe(true);
  expect(buyer.deployQueue).toContain("ammostation");
  expect(mate.deployQueue).not.toContain("ammostation");
  expect(mate.money).toBe(mateMoney); // teammate wallet untouched
});
```

- [ ] **Step 3: テストが通ることを確認**

Run: `bunx vitest run game/game.draft.test.ts game/game.test.ts`
Expected: PASS（隔離は既に正しいので即緑。落ちたら個人ウォレット隔離が壊れている）

- [ ] **Step 4: コミット**

```bash
git add game/game.draft.test.ts game/game.test.ts
git commit -m "test(coop): restore buyer-isolation guards for draft perk + fortify buy

Re-adds the teammate-isolation regression tests lost in the economy
redesign (perk moved from applyBuy to applyDraftTake). Guards b8226c9's
individual-wallet invariant.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01ABfRoiJaCaefkQ5BbRbLdj"
```

---

### Task 5: 最終検証（全ゲート）

コード変更なし。マージ前に全 CI ゲートをローカルで確認する。

- [ ] **Step 1: 型・テスト・lint・build**

Run: `bun run typecheck && bun run test && bun run lint && bun run build`
Expected: 全 PASS。`snapshot.test.ts` の golden byte test が不変（wire 不変の確認）。

- [ ] **Step 2: feel-first プレイテスト項目の申し送り（自動テスト対象外）**

実機（`bun run dev`）で確認すべき体感（spec §5）。**コードでは検証しない**ので、PR 説明か手元で確認：
- リロールしても取得済み perk が出ないテンポ、SCRAP コスト感。
- §3.5 の保留判断：weapon-upgrade はリロールで連投可（perk-only 除外）。「1 夜 1 強化」に制限したいかは実機体感で別途決定（`applyDraftTake` の push 条件を `perk:` から外せば統一規則に切替可）。

- [ ] **Step 3: （ブランチが上流に無ければ）push して PR #29 を更新**

```bash
git push
```

---

## Self-Review

**Spec coverage:**
- 指摘 1（リロール exclude）→ Task 3 ✓
- 指摘 2（freePicks 配線）→ Task 2 ✓
- 指摘 3（武器述語統一）→ Task 1 ✓
- 指摘 4（隔離テスト復元）→ Task 4 ✓
- spec §3.2 wire 不変・PROTOCOL 据え置き → Task 2 Step 4/6 ✓
- spec §3.5 weapon perk-only ＋ feel-first 申し送り → Task 3（push 条件）＋ Task 5 Step 2 ✓
- spec §4 `renderShop` cardKey 更新・既存テスト更新 → Task 2 Step 3/5 ✓
- spec §5 CONFIG 書き換えの try-finally 復元 → Task 2 Step 1 ✓

**Placeholder scan:** プレースホルダ無し。各コードステップに実コードを記載。

**Type consistency:** `draftFreePicksUsed: number`（Task 2 で導入、Task 3 のテストで使用）、`draftTaken: string[]`（Task 3）、`isUpgradeableWeapon`（Task 1）、`rollOffer(..., exclude)`（Global Constraints の既存シグネチャと一致）、`addPlayer(s, 1, 0, 0)`（Task 4、`players.ts:135` シグネチャと一致）。`SnapPlayer.draftFreeUsed` は wire 射影として温存（rename しない）— Task 2 で一貫。

**実行順序の根拠:** Task 1 は独立。Task 2（rename）を Task 3（draftTaken）より先に置くことで、Task 3 の paid-path テストが最初から `draftFreePicksUsed` を使え、テストの再編集を避ける。各タスク末で typecheck/test 緑＝コミット可能。
