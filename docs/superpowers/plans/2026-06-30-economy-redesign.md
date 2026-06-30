# Economy Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ラン内通貨を昼に集める単一資源 SCRAP に一本化し、毎夜の購入を「全カタログ店」から「3枚ドラフト（1枚無料＋SCRAPで追加/リロール）」へ、メタ進行を専用 ARSENAL 画面のアンロックツリー（武器＋カード）へ作り替える。

**Architecture:** ①純粋なデータ/ロジック層（`config`/`upgrades`/`arsenal`/`state`/`players`：ドラフトのプール構築・抽選・適用をユニットテスト可能な純関数として実装）→ ②単一プレイヤーの UI/フロー（`game.ts`/`index.html`/`style.css`：`#shop` をドラフト＋Fortify に再構成、`#start` 最小化＋専用 `#arsenal` 画面）→ ③co-op 同期（offer を `Player` に載せ snapshot で配る既存パターンに準拠、reliable は client→host の intent のみ）。

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess) / Bun / Vite / Vitest（pure 関数のみ）/ Biome / WebGL2（描画は既存 `style.css` バニラ DOM）。

> **改訂履歴（ラバーダックレビュー反映）**：①既存テスト（`game/game.test.ts`/`game/state.test.ts`/`game/data/upgrades.test.ts`/`game/data/arsenal.test.ts`）は実在 → 「新規」でなく「追記/改修」に修正。特に Task 6 で `game.test.ts` の applyBuy テストを Fortify 版へ移設（さもないと test 赤）。②`state.test.ts` は `vi.stubGlobal("localStorage")` 流儀に修正（node 環境に localStorage 無し／`vi.mock` 不要）。③Task 10 にデッドコード削除の明示リスト＋`buyItem` 破壊的変更の同一コミット束ね。④golden は `vitest -u`（インラインスナップショット自動更新）。⑤修理は config 0 化のみで player.ts 無改変、interactPrompt 文言整合。⑥Task 11 の起動時 `renderArsenal` クラッシュ回避（同一コミット束ね）。

## Global Constraints

- **ビジュアルは既存トークンのみ**（`game/style.css`）：`--bg #070a08` / `--toxic #7dff4f`（選択・解放）/ `--amber #ffb347`（SCRAP・価格）/ `--blood #ff4d4d`（危険）/ `--ink` / `--dim` / `--line #1b2420`。teal・紫・サンセリフ・絵文字・グラデ背景・hover の translateY リフト・角丸>4px は禁止。行/カードは既存 `.srow`/`.arow` に倣う。武器カードのアイコンは `WeaponDef.viz` のベクター描画（絵文字不可）。
- **配色の役割**：SCRAP=`--amber`、SALVAGE=`--toxic`。
- **single-player byte-identical**：co-op コードを触っても SP の挙動を変えない。sim の固定順序（`sysPlayer → sysAI → …`）は不変。ドラフト抽選は `update()` ループ外（openShop/take/reroll ハンドラ内で同期1回）。
- **データ駆動・zero special-case**：カードは `StoreItem`（`{id,name,desc,price,canBuy,buy}`）を再利用し新型を作らない。Fortify（設置物）だけ `storeItems` に残す。
- **テストは pure 関数のみ**（既存方針）。`Math.random` を使う関数は rng を末尾注入してテスト決定性を確保。UI/feel はプレイテストで検証。
- **wire 互換**：snapshot レイアウト変更時は `PROTOCOL_VERSION`（`game/net/net.ts`、現 11）を bump し `snapshot.test.ts` の golden を更新。`CARD_ORDER` は append-only（wire インデックス）。
- ツール：型チェック `bun run typecheck`、テスト `bun run test`、lint `bun run lint`。コミットは bite-sized。

---

## File Structure

| ファイル | 役割（本プランでの変更） |
|---|---|
| `game/config.ts` | `arsenal` にドラフト用ノブ追加、`siege.repairCost`/`econ.repairReward` を 0 に |
| `game/data/upgrades.ts` | `Upgrade` に `id`/`starter` 追加、`UNLOCKABLE_CARDS` 追加 |
| `game/types.ts` | `Upgrade` に `id`/`starter`、`Player` に draft 3フィールド、`State` に `unlockedCards` |
| `game/data/arsenal.ts` | `CARD_ORDER`/`cardItem`/`draftPool`/`rollOffer`/`rerollCost` 追加、`storeItems` を Fortify 専用に縮小 |
| `game/state.ts` | `newState` で owned と unlockedCards を `card:` 接頭辞で分離 |
| `game/engine/players.ts` | `makePlayer` で draft フィールド初期化 |
| `game/game.ts` | `openShop` で offer 生成、`applyDraftTake`/`applyDraftReroll`、`draftTake`/`draftReroll` ラッパ、`renderShop`/`syncShopUI` をドラフト+Fortify に、`renderArsenal` を WEAPONS+CARDS に |
| `game/net/snapshot.ts` | `SnapPlayer` に draft フィールド、capture/apply/encode/decode 追加 |
| `game/net/net.ts` | `PROTOCOL_VERSION` 11→12 |
| `game/net/events.ts` | `CoopEvent` に `draftTake`/`draftReroll` |
| `game/net/host.ts` | draft イベント適用、shop 中 spawn 時の offer 生成 |
| `game/net/client.ts` | `requestDraftTake`/`requestDraftReroll` |
| `game/main.ts` | shop ホットキー（1-3 take / R reroll / Enter deploy）、arsenal ボタン |
| `index.html` | `#shop` 再構成、`#start` 最小化、`#arsenal-screen` 追加 |
| `game/style.css` | ドラフトカード・arsenal 画面のスタイル（既存トークン） |

---

# Phase 1 — 純粋なデータ/ロジック層（TDD）

## Task 1: CONFIG にドラフトノブ追加・修理を SCRAP から外す

**Files:**
- Modify: `game/config.ts:212-221`（`arsenal` ブロック）, `game/config.ts:159-181`（`siege`）, `game/config.ts:192-205`（`econ`）

**Interfaces:**
- Produces: `CONFIG.arsenal.offerSize: number`, `CONFIG.arsenal.freePicks: number`, `CONFIG.arsenal.rerollBase: number`, `CONFIG.arsenal.rerollStep: number`。`CONFIG.siege.repairCost = 0`, `CONFIG.econ.repairReward = 0`。

- [ ] **Step 1: `arsenal` ブロックにノブを追加**

`game/config.ts` の `arsenal` ブロック（現 `salvagePerKill: 0.15,` の直後、閉じ `}` の前）に追記：

```ts
  arsenal: {
    maxLevel: 3,
    dmgPerLevel: 0.15,
    magPerLevel: 0.2,
    levelBaseCost: 60,
    levelStep: 45,
    perkCost: 80,
    salvagePerDay: 8,
    salvagePerKill: 0.15,
    // --- nightly draft (between-nights) ---
    offerSize: 3, // cards drawn each night
    freePicks: 1, // free picks per night before SCRAP is charged
    rerollBase: 30, // SCRAP for the first reroll of a night
    rerollStep: 25, // each further reroll this night costs this much more (resets next night)
  },
```

- [ ] **Step 2: 修理を SCRAP から外す**

`game/config.ts` の `siege.repairCost: 15,` を `repairCost: 0,` に変更（修理は時間/`repairCd` のみでゲート＝SCRAP 不要）。コメントを更新：

```ts
    repairCost: 0, // repair is free labor (time/repairCd-gated); SCRAP is reserved for the draft + fortify
```

`game/config.ts` の `econ.repairReward: 12,` を `repairReward: 0,` に変更（修理が SCRAP を生む/食う両方を断つ）。コメントを更新（既存の「must stay < repairCost」コメントも `0=0` で意味が消えるので書き換える）：

```ts
    repairReward: 0, // no SCRAP fountain from repair (repair is free now — see siege.repairCost=0)
```

> **player.ts は無改変**：`game/systems/player.ts:335-342` は `p.money >= CONFIG.siege.repairCost`（=0 で常に真）と `p.money -= 0` / `p.money += repairReward(=0)*...` を行うだけなので、config の 0 化だけで「修理無料・報酬なし」が成立する（コード変更不要）。

- [ ] **Step 3: 型チェック**

Run: `bun run typecheck`
Expected: PASS（数値の追加/変更のみ）

- [ ] **Step 4: Commit**

```bash
git add game/config.ts
git commit -m "feat(config): add draft knobs; make barricade repair free (off SCRAP)"
```

---

## Task 2: パークに id/starter を付け、UNLOCKABLE_CARDS を定義

**Files:**
- Modify: `game/types.ts`（`Upgrade` インターフェース）
- Modify: `game/data/upgrades.ts`（全 `UPGRADES` エントリ + 新 `UNLOCKABLE_CARDS`）
- Test: `game/data/upgrades.test.ts`（新規）

**Interfaces:**
- Produces: `Upgrade.id: string`, `Upgrade.starter: boolean`。`UNLOCKABLE_CARDS: { id: string; price: number }[]`（id は `card:<perkId>`）。perk id 一覧：`fieldMedic`/`hollowPoints`/`adrenaline`（starter=true）, `quickHands`/`firstAid`/`bandolier`/`scavenger`（starter=false）。

- [ ] **Step 1: `Upgrade` 型に id/starter を追加**

`game/types.ts` の `Upgrade` インターフェースに2フィールド追加（既存 `name`/`desc`/`apply`/`preview` はそのまま）：

```ts
export interface Upgrade {
  /** stable id for the draft card (`perk:<id>`) and meta unlock flag (`card:<id>`) */
  id: string;
  /** in the starter draft pool from a fresh save (false = unlocked via SALVAGE) */
  starter: boolean;
  name: string;
  desc: string;
  apply: (s: State, p: Player) => void;
  preview?: (s: State, p: Player) => string;
}
```

- [ ] **Step 2: 各 UPGRADES エントリに id/starter を付与**

`game/data/upgrades.ts` の各オブジェクト先頭に `id`/`starter` を追加（apply/preview/desc は不変）。対応：

```ts
export const UPGRADES: Upgrade[] = [
  { id: "fieldMedic", starter: true, name: "Field Medic", desc: "+20 max integrity, +1 medkit",
    apply: (_s, p) => { p.maxHp += 20; p.medkits = Math.min(CONFIG.heal.maxMedkits, p.medkits + 1); },
    preview: (_s, p) => `integrity ${p.maxHp} → ${p.maxHp + 20}` },
  { id: "hollowPoints", starter: true, name: "Hollow Points", desc: "+25% weapon damage",
    apply: (_s, p) => { p.dmgMul *= 1.25; },
    preview: (_s, p) => `damage ${pct(p.dmgMul)} → ${pct(p.dmgMul * 1.25)}` },
  { id: "adrenaline", starter: true, name: "Adrenaline", desc: "+12% movement speed",
    apply: (_s, p) => { p.speed *= 1.12; },
    preview: (_s, p) => `speed ${Math.round(p.speed)} → ${Math.round(p.speed * 1.12)}` },
  { id: "quickHands", starter: false, name: "Quick Hands", desc: "+30% fire rate",
    apply: (_s, p) => { p.fireRateMul *= 1.3; },
    preview: (_s, p) => `fire rate ${pct(p.fireRateMul)} → ${pct(p.fireRateMul * 1.3)}` },
  { id: "firstAid", starter: false, name: "First Aid Cache", desc: "+2 medkits",
    apply: (_s, p) => { p.medkits = Math.min(CONFIG.heal.maxMedkits, p.medkits + 2); },
    preview: (_s, p) => `medkits ${p.medkits} → ${Math.min(CONFIG.heal.maxMedkits, p.medkits + 2)}` },
  { id: "bandolier", starter: false, name: "Bandolier", desc: "+50% spare ammo capacity, top off now",
    apply: (_s, p) => { p.reserveMul *= 1.5; for (const id of WEAPON_ORDER) { const w = WEAPONS[id]; if (!w || w.melee) continue; p.reserve[id] = Math.round(w.reserveMax * p.reserveMul); } },
    preview: (_s, p) => `spare capacity ${pct(p.reserveMul)} → ${pct(p.reserveMul * 1.5)}` },
  { id: "scavenger", starter: false, name: "Scavenger", desc: "Full resupply — all magazines and spare ammo",
    apply: (_s, p) => { for (const id of WEAPON_ORDER) { const w = WEAPONS[id]; if (!w || w.melee) continue; p.reserve[id] = Math.round(w.reserveMax * p.reserveMul); p.mags[id] = w.mag; } p.ammo = WEAPONS[p.weapon]?.mag ?? p.ammo; },
    preview: () => "all ammo → full" },
];

/** Perk cards unlocked via SALVAGE (id = `card:<perkId>`). Append-only for save compatibility. */
export const UNLOCKABLE_CARDS: { id: string; price: number }[] = [
  { id: "card:quickHands", price: 60 },
  { id: "card:firstAid", price: 60 },
  { id: "card:bandolier", price: 80 },
  { id: "card:scavenger", price: 100 },
];
```

- [ ] **Step 3: 失敗するテストを書く**

> **既存ファイルに追記**：`game/data/upgrades.test.ts` は**既に存在**し `byName(...)` で apply() を検証している（名前は不変なので既存テストはそのまま緑）。新規作成せず、以下の `describe` ブロックを**末尾に追記**する。import 行は既存にマージ（重複させない）。

`game/data/upgrades.test.ts` に追記：

```ts
import { UNLOCKABLE_CARDS, UPGRADES } from "./upgrades"; // ← 既存 import にマージ

describe("UPGRADES id/starter split", () => {
  it("every upgrade has a unique id", () => {
    const ids = UPGRADES.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("exactly three starter perks", () => {
    expect(UPGRADES.filter((u) => u.starter).map((u) => u.id).sort()).toEqual([
      "adrenaline", "fieldMedic", "hollowPoints",
    ]);
  });
  it("UNLOCKABLE_CARDS reference real non-starter perks via card: namespace", () => {
    for (const c of UNLOCKABLE_CARDS) {
      expect(c.id.startsWith("card:")).toBe(true);
      const perkId = c.id.slice("card:".length);
      const u = UPGRADES.find((x) => x.id === perkId);
      expect(u, `perk for ${c.id}`).toBeDefined();
      expect(u?.starter).toBe(false);
    }
  });
});
```

- [ ] **Step 4: テストが失敗することを確認**

Run: `bun run test -- upgrades`
Expected: FAIL（型/エクスポート未整備なら）→ 実装済みなら PASS。失敗時はメッセージで原因確認。

- [ ] **Step 5: テストが通ることを確認**

Run: `bun run test -- upgrades` および `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add game/types.ts game/data/upgrades.ts game/data/upgrades.test.ts
git commit -m "feat(data): perk id/starter split + UNLOCKABLE_CARDS"
```

---

## Task 3: `cardItem` と `CARD_ORDER`（カード id → StoreItem 解決）

**Files:**
- Modify: `game/data/arsenal.ts`（`cardItem`/`CARD_ORDER` 追加）
- Test: `game/data/arsenal.test.ts`（既存に追記、なければ新規）

**Interfaces:**
- Consumes: `StoreItem`（既存）, `UPGRADES`, `WEAPONS`, `WEAPON_ORDER`, `levelCost`, `CONFIG.arsenal`。
- Produces: `cardItem(state: State, buyer: Player, id: string): StoreItem | undefined`（`perk:<perkId>` と `lvl:<weaponId>` を解決。武器が maxLevel なら undefined）。`CARD_ORDER: string[]`（全カード id の安定順、append-only）。

- [ ] **Step 1: `cardItem` と `CARD_ORDER` を実装**

`game/data/arsenal.ts` の import に `UPGRADES` を追加（既存 `import { UPGRADES } from "./upgrades";` がある）。末尾に追記：

```ts
/**
 * Resolve a single draft card id to a StoreItem (used by host to apply and by client to render).
 * `perk:<perkId>` → a perk card; `lvl:<weaponId>` → that weapon's next-Mk upgrade (undefined if
 * the weapon is melee/unknown or already at maxLevel). Reuses the StoreItem abstraction — no new type.
 */
export function cardItem(_state: State, buyer: Player, id: string): StoreItem | undefined {
  const a = CONFIG.arsenal;
  if (id.startsWith("perk:")) {
    const perkId = id.slice("perk:".length);
    const u = UPGRADES.find((x) => x.id === perkId);
    if (!u) return undefined;
    return {
      id,
      name: u.name,
      desc: u.desc,
      price: a.perkCost,
      canBuy: (_s, b) => b.money >= a.perkCost,
      buy: (s, b) => u.apply(s, b),
    };
  }
  if (id.startsWith("lvl:")) {
    const wid = id.slice("lvl:".length);
    const w = WEAPONS[wid];
    if (!w || w.melee) return undefined;
    const lvl = buyer.wlevel[wid] ?? 0;
    if (lvl >= a.maxLevel) return undefined;
    const price = levelCost(lvl);
    return {
      id,
      name: `${w.name} ▸ Mk ${lvl + 2}`,
      desc: `+${Math.round(a.dmgPerLevel * 100)}% dmg · +${Math.round(a.magPerLevel * 100)}% mag`,
      price,
      canBuy: (_s, b) => b.money >= price && (b.wlevel[wid] ?? 0) < a.maxLevel,
      buy: (_s, b) => {
        b.wlevel[wid] = (b.wlevel[wid] ?? 0) + 1;
      },
    };
  }
  return undefined;
}

/**
 * Stable wire order of every possible draft card id (perk cards then weapon-upgrade cards).
 * APPEND-ONLY — this is the snapshot index for Player.draftOffer (see snapshot.ts). Adding a perk
 * or weapon appends; never reorder.
 */
export const CARD_ORDER: string[] = [
  ...UPGRADES.map((u) => `perk:${u.id}`),
  ...WEAPON_ORDER.filter((id) => !WEAPONS[id]?.melee).map((id) => `lvl:${id}`),
];
```

- [ ] **Step 2: 失敗するテストを書く**

`game/data/arsenal.test.ts` に追記（既存 import に合わせる。新規なら下記 import を先頭に）：

```ts
import { describe, expect, it } from "vitest";
import { newState } from "../state";
import { localPlayer } from "../engine/players";
import { CARD_ORDER, cardItem } from "./arsenal";

describe("cardItem", () => {
  it("resolves a starter perk card", () => {
    const s = newState();
    const it = cardItem(s, localPlayer(s), "perk:hollowPoints");
    expect(it?.name).toBe("Hollow Points");
    expect(it?.price).toBe(80);
  });
  it("resolves a weapon upgrade card with the right Mk label and price", () => {
    const s = newState();
    const p = localPlayer(s);
    const it = cardItem(s, p, "lvl:pistol");
    expect(it?.name).toBe("PISTOL ▸ Mk 2");
    expect(it?.price).toBe(60); // levelBaseCost at level 0
  });
  it("returns undefined for a maxed weapon", () => {
    const s = newState();
    const p = localPlayer(s);
    p.wlevel.pistol = 3; // maxLevel
    expect(cardItem(s, p, "lvl:pistol")).toBeUndefined();
  });
  it("returns undefined for an unknown id", () => {
    const s = newState();
    expect(cardItem(s, localPlayer(s), "bogus:x")).toBeUndefined();
  });
  it("CARD_ORDER lists perk then weapon cards, no melee", () => {
    expect(CARD_ORDER).toContain("perk:fieldMedic");
    expect(CARD_ORDER).toContain("lvl:shotgun");
    expect(CARD_ORDER).not.toContain("lvl:knife");
  });
});
```

- [ ] **Step 3: 失敗確認 → 実装は Step 1 済 → 通過確認**

Run: `bun run test -- arsenal` および `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add game/data/arsenal.ts game/data/arsenal.test.ts
git commit -m "feat(arsenal): cardItem resolver + CARD_ORDER wire list"
```

---

## Task 4: `draftPool`（抽選元の有効カード集合）

**Files:**
- Modify: `game/data/arsenal.ts`（`draftPool` 追加）
- Test: `game/data/arsenal.test.ts`

**Interfaces:**
- Consumes: `cardItem`, `UPGRADES`, `WEAPON_ORDER`, `WEAPONS`, `state.owned`, `state.unlockedCards`（Task 7 で State に追加。Task 4 時点では `state.unlockedCards ?? {}` で防御）。
- Produces: `draftPool(state: State, buyer: Player): StoreItem[]`（解放済みパーク＋所持かつ未上限の武器強化カード）。

> **依存メモ:** `state.unlockedCards` は Task 7 で State に追加される。本タスクでは `(state.unlockedCards ?? {})` と読み、Task 7 完了後もそのまま動く。

- [ ] **Step 1: `draftPool` を実装**

`game/data/arsenal.ts` の `cardItem` の後に追記：

```ts
/**
 * The eligible draft cards for `buyer` this run: unlocked perk cards (starter perks + SALVAGE-
 * unlocked) plus every owned, non-maxed weapon's upgrade card. Host/single only (the roll source);
 * clients render from the synced offer ids via cardItem. Pure — no RNG here.
 */
export function draftPool(state: State, buyer: Player): StoreItem[] {
  const items: StoreItem[] = [];
  const unlocked = state.unlockedCards ?? {};
  for (const u of UPGRADES) {
    if (!u.starter && !unlocked[`card:${u.id}`]) continue;
    const it = cardItem(state, buyer, `perk:${u.id}`);
    if (it) items.push(it);
  }
  for (const id of WEAPON_ORDER) {
    const w = WEAPONS[id];
    if (!w || w.melee || !state.owned[id]) continue;
    const it = cardItem(state, buyer, `lvl:${id}`); // undefined if maxed → skipped
    if (it) items.push(it);
  }
  return items;
}
```

- [ ] **Step 2: 失敗するテストを書く**

`game/data/arsenal.test.ts` に追記：

```ts
import { draftPool } from "./arsenal";

describe("draftPool", () => {
  it("fresh save: 3 starter perks + 3 starter weapon upgrades", () => {
    const s = newState(); // owned = pistol/smg/shotgun/knife; unlockedCards = {}
    const ids = draftPool(s, localPlayer(s)).map((it) => it.id).sort();
    expect(ids).toEqual([
      "lvl:pistol", "lvl:shotgun", "lvl:smg",
      "perk:adrenaline", "perk:fieldMedic", "perk:hollowPoints",
    ]);
  });
  it("unlocked perk card enters the pool", () => {
    const s = newState();
    s.unlockedCards = { "card:scavenger": true };
    expect(draftPool(s, localPlayer(s)).map((it) => it.id)).toContain("perk:scavenger");
  });
  it("maxed weapon drops out of the pool", () => {
    const s = newState();
    const p = localPlayer(s);
    p.wlevel.pistol = 3;
    expect(draftPool(s, p).map((it) => it.id)).not.toContain("lvl:pistol");
  });
  it("knife (melee) never appears", () => {
    const s = newState();
    expect(draftPool(s, localPlayer(s)).map((it) => it.id)).not.toContain("lvl:knife");
  });
});
```

- [ ] **Step 3: 通過確認**

Run: `bun run test -- arsenal` および `bun run typecheck`
Expected: PASS（`state.unlockedCards` は `?? {}` で防御済みなので Task 7 前でも通る）

- [ ] **Step 4: Commit**

```bash
git add game/data/arsenal.ts game/data/arsenal.test.ts
git commit -m "feat(arsenal): draftPool eligible-card builder"
```

---

## Task 5: `rollOffer`（rng 注入抽選）と `rerollCost`

**Files:**
- Modify: `game/data/arsenal.ts`
- Test: `game/data/arsenal.test.ts`

**Interfaces:**
- Produces: `rollOffer(pool: StoreItem[], n: number, exclude?: string[], rng?: () => number): StoreItem[]`（重複なし・最大 n・pool<n は全部返す。`rng` 末尾注入でテスト決定的）。`rerollCost(rerolls: number): number`。

- [ ] **Step 1: 実装**

`game/data/arsenal.ts` に追記：

```ts
/**
 * Pick up to `n` DISTINCT cards from `pool` (minus `exclude` ids) using a partial Fisher–Yates.
 * `rng` is injected (default Math.random) so tests are deterministic — this is the one place we
 * break the project's "Math.random direct-call" habit, because the test方針 requires it.
 */
export function rollOffer(
  pool: StoreItem[],
  n: number,
  exclude: string[] = [],
  rng: () => number = Math.random,
): StoreItem[] {
  const avail = pool.filter((it) => !exclude.includes(it.id));
  const picked: StoreItem[] = [];
  for (let i = 0; i < avail.length && picked.length < n; i++) {
    const j = i + Math.floor(rng() * (avail.length - i));
    const tmp = avail[i] as StoreItem;
    avail[i] = avail[j] as StoreItem;
    avail[j] = tmp;
    picked.push(avail[i] as StoreItem);
  }
  return picked;
}

/** SCRAP cost of the next reroll given how many rerolls were already done this night. */
export function rerollCost(rerolls: number): number {
  return CONFIG.arsenal.rerollBase + rerolls * CONFIG.arsenal.rerollStep;
}
```

- [ ] **Step 2: 失敗するテストを書く**

`game/data/arsenal.test.ts` に追記：

```ts
import { rerollCost, rollOffer } from "./arsenal";
import type { StoreItem } from "./arsenal";

const fake = (id: string): StoreItem => ({ id, name: id, desc: "", price: 0, canBuy: () => true, buy: () => {} });

describe("rollOffer", () => {
  it("returns n distinct items", () => {
    const pool = ["a", "b", "c", "d", "e"].map(fake);
    const seq = [0, 0, 0]; let i = 0;
    const out = rollOffer(pool, 3, [], () => seq[i++] ?? 0);
    expect(out).toHaveLength(3);
    expect(new Set(out.map((x) => x.id)).size).toBe(3);
  });
  it("clamps to pool size when pool < n", () => {
    expect(rollOffer(["a", "b"].map(fake), 3, [], () => 0)).toHaveLength(2);
  });
  it("honors exclude", () => {
    const out = rollOffer(["a", "b", "c"].map(fake), 3, ["b"], () => 0);
    expect(out.map((x) => x.id)).not.toContain("b");
  });
  it("is deterministic under a fixed rng", () => {
    const pool = ["a", "b", "c", "d"].map(fake);
    const r1 = rollOffer(pool.slice(), 2, [], () => 0.5).map((x) => x.id);
    const r2 = rollOffer(pool.slice(), 2, [], () => 0.5).map((x) => x.id);
    expect(r1).toEqual(r2);
  });
});

describe("rerollCost", () => {
  it("monotonically increases with reroll count", () => {
    expect(rerollCost(0)).toBe(30);
    expect(rerollCost(1)).toBe(55);
    expect(rerollCost(2)).toBe(80);
  });
});
```

- [ ] **Step 3: 通過確認**

Run: `bun run test -- arsenal` および `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add game/data/arsenal.ts game/data/arsenal.test.ts
git commit -m "feat(arsenal): rollOffer (rng-injected) + rerollCost"
```

---

## Task 6: `storeItems` を Fortify 専用に縮小

**Files:**
- Modify: `game/data/arsenal.ts:59-112`（`storeItems`）
- Test: `game/data/arsenal.test.ts`

**Interfaces:**
- Produces: `storeItems(state, buyer): StoreItem[]` は **設置物（Fortify）のみ**を返す（武器強化・パークはドラフトへ移行）。`applyBuy`（game.ts、Fortify 購入に流用）は不変で動く。

- [ ] **Step 1: `storeItems` の武器強化ループとパークループを削除**

`game/data/arsenal.ts` の `storeItems` を、Fortify ループだけ残す形に置換：

```ts
/** Build the Fortify (deployables) store list for `buyer`. Weapon upgrades and perks moved to the
 *  nightly draft (draftPool); this now returns only the spatial fortifications, priced off the
 *  buyer's own wallet. `applyBuy` still resolves these by id. */
export function storeItems(state: State, buyer: Player): StoreItem[] {
  const items: StoreItem[] = [];
  for (const id of Object.keys(DEPLOYABLE_TYPES)) {
    const d = DEPLOYABLE_TYPES[id] as DeployableDef;
    const queued = (b: Player) => b.deployQueue.reduce((n, q) => (q === id ? n + 1 : n), 0);
    items.push({
      id: `deploy:${id}`,
      name: `${d.name} (Fortify)`,
      desc: `${d.desc} · ${deployableCount(state, id)}/${d.cap} built${queued(buyer) ? ` · ${queued(buyer)} queued` : ""}`,
      price: d.cost,
      canBuy: (s, b) => b.money >= d.cost && deployableCount(s, id) + queued(b) < d.cap,
      buy: (_s, b) => {
        b.deployQueue.push(id);
      },
    });
  }
  return items;
}
```

`game/data/arsenal.ts` 冒頭の import から、使われなくなった `UPGRADES`/`WEAPON_ORDER`/`WEAPONS` を **削除しない**（`cardItem`/`draftPool`/`CARD_ORDER` がまだ使う）。`a`（`CONFIG.arsenal`）が storeItems 内で未使用になるので、storeItems 内の `const a = CONFIG.arsenal;` 行は削除。

- [ ] **Step 2: 失敗するテストを書く**

`game/data/arsenal.test.ts` に追記：

```ts
import { storeItems } from "./arsenal"; // ← 既存 arsenal.test.ts の import にマージ

describe("storeItems is fortify-only", () => {
  it("returns only deploy: items", () => {
    const s = newState();
    const ids = storeItems(s, localPlayer(s)).map((it) => it.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((id) => id.startsWith("deploy:"))).toBe(true);
  });
});
```

- [ ] **Step 3: 既存 `game/game.test.ts` の applyBuy テストを Fortify 版に書き換え（必須・これを怠ると test が赤）**

> **背景（ラバーダック検証済）**：`game/game.test.ts` は `applyBuy(s, "perk:Field Medic", ...)`（5箇所）と `storeItems(s,buyer).find(i => i.id.startsWith("lvl:"))`（武器強化）を検証している。storeItems が Fortify 専用になると、これらは全て解決不能で**失敗**する。`applyBuy` は Fortify 購入専用になったので、テストも Fortify（`deploy:`）に移す。perk/weapon 購入の検証は Task 8 の `game.draft.test.ts` が担う。

`game/game.test.ts` の `describe("applyBuy ...")` ブロックを以下に**全置換**（buyer 構築ヘルパは既存のものを流用。`storeItems`/`localPlayer`/`newState` の import は既存に合わせる）：

```ts
describe("applyBuy (Fortify purchase, host-authoritative)", () => {
  const fortId = "deploy:ammostation"; // Supply Station, cost 70 (DEPLOYABLE_TYPES.ammostation)
  it("buys a fortification: deducts SCRAP and queues it", () => {
    const s = newState();
    s.inShop = true;
    const buyer = localPlayer(s);
    buyer.money = 100;
    expect(applyBuy(s, fortId, buyer)).toBe(true);
    expect(buyer.money).toBe(30);
    expect(buyer.deployQueue).toContain("ammostation");
  });
  it("rejects when unaffordable", () => {
    const s = newState();
    s.inShop = true;
    const buyer = localPlayer(s);
    buyer.money = 10;
    expect(applyBuy(s, fortId, buyer)).toBe(false);
  });
  it("rejects when the shop is closed", () => {
    const s = newState();
    s.inShop = false;
    const buyer = localPlayer(s);
    buyer.money = 100;
    expect(applyBuy(s, fortId, buyer)).toBe(false);
  });
  it("rejects with no buyer", () => {
    const s = newState();
    s.inShop = true;
    expect(applyBuy(s, fortId, undefined)).toBe(false);
  });
  it("rejects an unknown item id", () => {
    const s = newState();
    s.inShop = true;
    const buyer = localPlayer(s);
    buyer.money = 100;
    expect(applyBuy(s, "deploy:nope", buyer)).toBe(false);
  });
});
```

`game/game.test.ts` の不要になった import（`storeItems` を weapon-find に使っていた箇所）を整理。

- [ ] **Step 4: 通過確認**

Run: `bun run test`（全体。`game.test.ts`/`arsenal.test.ts` が緑であること）、`bun run typecheck`、`bun run lint`
Expected: PASS（lint で未使用 import が出たら該当のみ整理。`knip` は informational）

- [ ] **Step 5: Commit**

```bash
git add game/data/arsenal.ts game/data/arsenal.test.ts game/game.test.ts
git commit -m "refactor(arsenal): storeItems → fortify-only; migrate game.test.ts applyBuy to fortify"
```

---

## Task 7: Player/State の draft フィールド・owned/unlockedCards 分離

**Files:**
- Modify: `game/types.ts`（`Player`, `State`）
- Modify: `game/engine/players.ts:12-61`（`makePlayer`）
- Modify: `game/state.ts:24-84`（`newState`）
- Test: `game/state.test.ts`（新規）

**Interfaces:**
- Produces: `Player.draftOffer: string[]`, `Player.draftFreeUsed: boolean`, `Player.draftRerolls: number`。`State.unlockedCards: Record<string, boolean>`。`newState()` が `meta.unlocked` を `card:` 接頭辞で `unlockedCards` と `owned` に振り分ける。

- [ ] **Step 1: 型を追加**

`game/types.ts` の `Player` インターフェース末尾（`searching: boolean;` の後）に追加：

```ts
  /** between-nights draft: card ids currently offered to this player (host-rolled, snapshot-synced) */
  draftOffer: string[];
  /** this player's free pick this night has been spent (remaining cards then cost SCRAP) */
  draftFreeUsed: boolean;
  /** rerolls this player has done this night — drives escalating rerollCost; reset at openShop */
  draftRerolls: number;
```

`game/types.ts` の `State` インターフェースの `owned` の直後に追加：

```ts
  /** which perk cards are unlocked this run (id = `card:<perkId>`); from meta, host-authoritative.
   *  Read by draftPool. Separate from `owned` (weapons) so the two namespaces don't collide. */
  unlockedCards: Record<string, boolean>;
```

- [ ] **Step 2: `makePlayer` を初期化**

`game/engine/players.ts` の `makePlayer` の return オブジェクト末尾（`searching: false,` の後）に追加：

```ts
    draftOffer: [],
    draftFreeUsed: false,
    draftRerolls: 0,
```

- [ ] **Step 3: `newState` で owned/unlockedCards を分離**

`game/state.ts:28-29` の owned 構築ループを置換：

```ts
  const meta = loadMeta();
  const owned: Record<string, boolean> = {};
  const unlockedCards: Record<string, boolean> = {};
  for (const id of STARTER_WEAPONS) owned[id] = true;
  for (const id of Object.keys(meta.unlocked)) {
    if (!meta.unlocked[id]) continue;
    if (id.startsWith("card:")) unlockedCards[id] = true; // perk card unlocks (NOT weapons)
    else owned[id] = true; // weapon unlocks
  }
```

`game/state.ts` の return オブジェクトの `owned,` の直後に追加：

```ts
    unlockedCards,
```

- [ ] **Step 4: 失敗するテストを書く**

> **既存ファイルに追記**：`game/state.test.ts` は**既に存在**（`describe("newState")` に day1/player/barricade/owned/allocId）。node 環境に `localStorage` は無く、既存テストの一つ（`state.test.ts:52-61`）は `vi.stubGlobal("localStorage", {...})` で localStorage を**スタブ**してから `newState()` を呼んでいる。この流儀に倣い、card: 分離テストを**末尾に追記**する（`vi.mock` は使わない）。`vi` は既存 import に含まれる。

`game/state.test.ts` の `describe("newState")` 内（または末尾）に追記：

```ts
  it("splits card: unlocks into unlockedCards, weapon unlocks into owned", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => JSON.stringify({ version: 1, salvage: 0, unlocked: { rifle: true, "card:scavenger": true } }),
      setItem: () => {},
    });
    const s = newState();
    vi.unstubAllGlobals();
    expect(s.owned.rifle).toBe(true);
    expect(s.owned["card:scavenger"]).toBeUndefined(); // not a weapon
    expect(s.unlockedCards["card:scavenger"]).toBe(true);
  });
```

> `loadMeta`（`meta.ts:20`）は `localStorage.getItem("q_meta")` を JSON.parse する。スタブの `getItem` がその文字列を返せばよい。既存テストの stub 形に合わせること。

- [ ] **Step 5: 失敗確認 → 通過確認**

Run: `bun run test -- state` および `bun run typecheck`
Expected: PASS。型エラー（既存テストの makePlayer/newState 利用箇所が新フィールドを要求）が出たら、それは新フィールドが必須なため。`makePlayer`/`newState` が唯一の生成口なので他テストは影響を受けないはず。既存の `arsenal.test.ts`/`upgrades.test.ts`/`game.draft.test.ts` が `newState()` を localStorage スタブ無しで呼ぶのは、`loadMeta` が `localStorage` 未定義の ReferenceError を try/catch で握り潰し `fresh()` を返すため安全（owned=スターターのみ、unlockedCards=空）。

- [ ] **Step 6: Commit**

```bash
git add game/types.ts game/engine/players.ts game/state.ts game/state.test.ts
git commit -m "feat(state): player draft fields + owned/unlockedCards namespace split"
```

---

## Task 8: ドラフト適用ロジック（host-authoritative・DOM 非依存）

**Files:**
- Modify: `game/game.ts`（`openShop`、新 `rollDraft`/`applyDraftTake`/`applyDraftReroll`）
- Test: `game/game.draft.test.ts`（新規）

**Interfaces:**
- Consumes: `draftPool`, `rollOffer`, `rerollCost`, `cardItem`（arsenal.ts）, `CONFIG.arsenal`。
- Produces:
  - `rollDraft(state: State, p: Player): void`（p に offer を生成、free/rerolls をリセット）
  - `applyDraftTake(s: State, buyer: Player | undefined, cardId: string): boolean`（offer 内かつ：未使用なら無料適用＋freeUsed、使用済なら canBuy 検証＋SCRAP 消費して適用。成功で offer から除去）
  - `applyDraftReroll(s: State, buyer: Player | undefined): boolean`（SCRAP 足り offer>0 なら消費＋rerolls++＋offer を同枚数で引き直し）

- [ ] **Step 1: openShop に offer 生成を追加し、適用関数を実装**

`game/game.ts` の import に追加（既存の arsenal import 行へ）：

```ts
import {
  // ...既存...
  cardItem,
  draftPool,
  rerollCost,
  rollOffer,
} from "./data/arsenal";
```

`game/game.ts` の `openShop()` の `resupply();` の後に1行追加：

```ts
function openShop(): void {
  state.inShop = true;
  state.paused = true;
  Audio.setDread(0.1);
  for (const p of state.players) if (p.hp <= 0) revivePlayer(state, p);
  resupply();
  for (const p of state.players) rollDraft(state, p); // host/single: roll each player's offer
}
```

`game/game.ts` の `applyBuy` の近く（`applyPlace` の後など）に追記：

```ts
/** Host/single: roll a fresh nightly offer for player `p` and reset their free pick + reroll count. */
export function rollDraft(state: State, p: Player): void {
  p.draftOffer = rollOffer(draftPool(state, p), CONFIG.arsenal.offerSize).map((it) => it.id);
  p.draftFreeUsed = false;
  p.draftRerolls = 0;
}

/**
 * Apply a draft "take" host-authoritatively. The first take of the night is FREE (sets
 * draftFreeUsed); subsequent takes cost SCRAP (canBuy-gated). The card must be in the buyer's
 * current offer. Returns false (changing nothing) on any guard miss.
 */
export function applyDraftTake(s: State, buyer: Player | undefined, cardId: string): boolean {
  if (!s.inShop || !buyer || !buyer.draftOffer.includes(cardId)) return false;
  const it = cardItem(s, buyer, cardId);
  if (!it) return false;
  if (!buyer.draftFreeUsed) {
    it.buy(s, buyer);
    buyer.draftFreeUsed = true;
  } else {
    if (!it.canBuy(s, buyer)) return false;
    buyer.money -= it.price;
    it.buy(s, buyer);
  }
  buyer.draftOffer = buyer.draftOffer.filter((id) => id !== cardId);
  return true;
}

/** Apply a draft reroll host-authoritatively: charge escalating SCRAP, bump the reroll counter,
 *  and redraw the same number of cards the buyer currently has shown. */
export function applyDraftReroll(s: State, buyer: Player | undefined): boolean {
  if (!s.inShop || !buyer || buyer.draftOffer.length === 0) return false;
  const cost = rerollCost(buyer.draftRerolls);
  if (buyer.money < cost) return false;
  buyer.money -= cost;
  buyer.draftRerolls += 1;
  buyer.draftOffer = rollOffer(draftPool(s, buyer), buyer.draftOffer.length).map((it) => it.id);
  return true;
}
```

- [ ] **Step 2: 失敗するテストを書く**

`game/game.draft.test.ts`（新規）。`openShop` は内部関数なので、適用関数を直接叩く（state を手で組む）：

```ts
import { describe, expect, it } from "vitest";
import { newState } from "./state";
import { localPlayer } from "./engine/players";
import { applyDraftReroll, applyDraftTake, rollDraft } from "./game";

describe("draft apply (host-authoritative)", () => {
  it("rollDraft fills an offer of offerSize and resets free/rerolls", () => {
    const s = newState();
    const p = localPlayer(s);
    rollDraft(s, p);
    expect(p.draftOffer.length).toBe(3);
    expect(p.draftFreeUsed).toBe(false);
    expect(p.draftRerolls).toBe(0);
  });

  it("first take is free and sets draftFreeUsed; card leaves the offer", () => {
    const s = newState();
    s.inShop = true;
    const p = localPlayer(s);
    p.money = 0;
    p.draftOffer = ["perk:hollowPoints", "perk:fieldMedic", "lvl:pistol"];
    const before = p.dmgMul;
    expect(applyDraftTake(s, p, "perk:hollowPoints")).toBe(true);
    expect(p.draftFreeUsed).toBe(true);
    expect(p.dmgMul).toBeCloseTo(before * 1.25);
    expect(p.money).toBe(0); // free
    expect(p.draftOffer).not.toContain("perk:hollowPoints");
  });

  it("second take costs SCRAP and is blocked when unaffordable", () => {
    const s = newState();
    s.inShop = true;
    const p = localPlayer(s);
    p.draftFreeUsed = true;
    p.money = 50; // perkCost is 80
    p.draftOffer = ["perk:fieldMedic"];
    expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(false);
    p.money = 80;
    expect(applyDraftTake(s, p, "perk:fieldMedic")).toBe(true);
    expect(p.money).toBe(0);
  });

  it("take is rejected for a card not in the offer", () => {
    const s = newState();
    s.inShop = true;
    const p = localPlayer(s);
    p.draftOffer = ["perk:fieldMedic"];
    expect(applyDraftTake(s, p, "lvl:pistol")).toBe(false);
  });

  it("reroll charges escalating SCRAP and redraws same count", () => {
    const s = newState();
    s.inShop = true;
    const p = localPlayer(s);
    p.money = 100;
    p.draftOffer = ["perk:fieldMedic", "perk:adrenaline"];
    expect(applyDraftReroll(s, p)).toBe(true); // first reroll = 30
    expect(p.money).toBe(70);
    expect(p.draftRerolls).toBe(1);
    expect(p.draftOffer.length).toBe(2);
  });

  it("reroll blocked when broke", () => {
    const s = newState();
    s.inShop = true;
    const p = localPlayer(s);
    p.money = 10;
    p.draftOffer = ["perk:fieldMedic"];
    expect(applyDraftReroll(s, p)).toBe(false);
  });
});
```

- [ ] **Step 3: 失敗確認 → 通過確認**

Run: `bun run test -- draft` および `bun run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add game/game.ts game/game.draft.test.ts
git commit -m "feat(game): host-authoritative draft apply (take/reroll/rollDraft)"
```

> **Phase 1 完了チェック:** `bun run test` 全緑、`bun run typecheck` 緑。ロジック層が揃い、UI/net は未配線（既存 SP は `storeItems` 縮小により Fortify のみのショップになるが、ドラフト UI 未実装なので一時的にカードが買えない＝Phase 2 で配線）。

---

# Phase 2 — 単一プレイヤー UI/フロー（手動検証）

## Task 9: ドラフト/Fortify のラッパと main.ts ホットキー配線

**Files:**
- Modify: `game/game.ts`（`draftTake`/`draftReroll` ラッパ、`syncShopUI`/`renderShop` は Task 10）
- Modify: `game/main.ts:205-212`（shop ホットキー）

**Interfaces:**
- Consumes: `applyDraftTake`/`applyDraftReroll`（Task 8）, `Net`（client 分岐）, `Client.requestDraftTake`/`requestDraftReroll`（Task 13 で追加。Phase 2 単体では SP のみ通るので client 分岐は呼ばれない — メソッドは Task 13 まで `?.` で安全）。
- Produces: `draftTake(cardId: string): void`, `draftReroll(): void`（export）。

- [ ] **Step 1: ラッパを追加**

`game/game.ts` に追記（`shopBuySelected` 近く）：

```ts
/** Take a draft card. Client → request to host; host/single → apply authoritatively + re-render. */
export function draftTake(cardId: string): void {
  if (!state.inShop) return;
  if (Net.mode === "client") {
    Net.client?.requestDraftTake(cardId);
    Audio.ui(true);
    return;
  }
  if (applyDraftTake(state, localPlayer(state), cardId)) {
    Audio.ui(true);
    renderShop();
  } else {
    Audio.ui(false);
  }
}

/** Reroll the local player's draft offer. Client → request; host/single → apply + re-render. */
export function draftReroll(): void {
  if (!state.inShop) return;
  if (Net.mode === "client") {
    Net.client?.requestDraftReroll();
    Audio.ui(true);
    return;
  }
  if (applyDraftReroll(state, localPlayer(state))) {
    Audio.ui(true);
    renderShop();
  } else {
    Audio.ui(false);
  }
}
```

- [ ] **Step 2: main.ts のショップホットキーを更新**

`game/main.ts:205-212` を置換（digit 1-3 = カード take、R = reroll、Enter = deploy。Fortify はクリック専用）：

```ts
    if (state.inShop) {
      const me = localPlayer(state);
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) {
        const card = me.draftOffer[Number(digit[1]) - 1];
        if (card) draftTake(card);
      } else if (e.code === "KeyR") shopReroll();
      else if (e.code === "Enter") shopDeploy();
      return;
    }
```

> `shopReroll` は main.ts ローカルの薄いラッパでなく、`draftReroll` を直接呼ぶ。import に `draftReroll`/`draftTake` を追加し、上の `shopReroll()` は `draftReroll()` に置換すること。`shopMove`/`shopBuySelected` の import は Fortify 用にまだ使う場合は残す（Task 10 で Fortify のキーボード操作を足さないなら削除可）。

`game/main.ts:7-24` の import に `draftTake, draftReroll` を追加、`shopMove`/`shopBuySelected` が未使用になれば削除。

- [ ] **Step 3: 型チェック**

Run: `bun run typecheck`
Expected: PASS（`Net.client?.requestDraftTake` は Task 13 まで存在しないので、`Client` 型に先にメソッド宣言を追加するか、Task 13 を先行させる。ここでは **Task 13 のクライアントメソッド追加を先に行ってから本タスクの型チェックを通す**か、`requestDraftTake`/`requestDraftReroll` の宣言だけ client.ts に先に追加しておく）。

> **順序メモ:** 型の都合上、Task 13 の client.ts メソッド追加（`requestDraftTake`/`requestDraftReroll`）を本タスクより先に入れてよい（純追加で SP に無影響）。実行者は Task 13 Step「client.ts request メソッド」だけ先取りして良い。

- [ ] **Step 4: Commit**

```bash
git add game/game.ts game/main.ts
git commit -m "feat(game): draftTake/draftReroll wrappers + shop hotkeys"
```

---

## Task 10: `#shop` をドラフト＋Fortify UI に再構成（手動検証）

**Files:**
- Modify: `index.html:106-113`（`#shop`）
- Modify: `game/game.ts`（`renderShop`/`syncShopUI` をドラフト対応に）
- Modify: `game/style.css`（ドラフトカード/Fortify 行スタイル）

**Interfaces:**
- Consumes: `localPlayer(state).draftOffer`, `cardItem`, `storeItems`（Fortify）, `rerollCost`, `localPlayer.draftRerolls`/`draftFreeUsed`/`money`。

- [ ] **Step 1: `#shop` のマークアップを差し替え**

`index.html:106-113` を置換：

```html
<div id="shop" class="overlay hidden">
  <div class="eyebrow"><span class="dot"></span>Night <span id="shop-wave">1</span> survived</div>
  <h1 style="font-size:clamp(26px,5vw,44px)">Salvage the Dark</h1>
  <p>Scrap <b id="shop-credits" style="color:var(--amber)">0</b> &middot; <span id="shop-free">1 free pick</span> &middot; a wall, or a gun</p>
  <div class="draft" id="draft-cards"></div>
  <div class="draft-ctl">
    <button type="button" class="btn ghost" id="rerollBtn">Reroll <b id="reroll-cost">30</b></button>
  </div>
  <div class="fort-label">Fortify &middot; Scrap</div>
  <div class="store fort" id="choices"></div>
  <button type="button" class="btn" id="deployBtn">Face the Day</button>
  <div class="hint">[1&ndash;3] take card &middot; click fortify &middot; R reroll &middot; ENTER face the day</div>
</div>
```

- [ ] **Step 2: スタイルを追加（既存トークンのみ）**

`game/style.css` の `#shop .btn { margin-top: 18px; }`（行 920-922 付近）の後に追記：

```css
/* nightly draft */
.draft {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  width: min(620px, 90vw);
  margin-top: 14px;
}
.dcard {
  pointer-events: auto;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  text-align: left;
  min-height: 132px;
  padding: 11px 12px;
  border: 1px solid var(--line);
  background: rgba(0, 0, 0, 0.4);
  border-radius: 2px;
  transition: border-color 0.1s, background 0.1s;
}
.dcard:hover, .dcard.sel { border-color: var(--toxic); background: rgba(20, 40, 18, 0.5); }
.dcard.off { opacity: 0.42; }
.dcard .dkind { font-size: 10px; letter-spacing: 0.22em; color: var(--dim); text-transform: uppercase; }
.dcard .dico { height: 24px; margin: 8px 0 6px; display: flex; align-items: center; }
.dcard .cname { font-size: 14px; color: var(--ink); letter-spacing: 0.02em; }
.dcard .desc { font-size: 10.5px; color: var(--dim); line-height: 1.4; margin-top: 3px; flex: 1; }
.dcard .dfoot { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.dcard .dpick { font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--toxic); }
.dcard .sprice { font-size: 14px; color: var(--amber); font-variant-numeric: tabular-nums; }
.dcard.off .sprice { color: var(--blood); }
.draft-ctl { margin-top: 12px; }
.btn.ghost {
  margin-top: 0; background: transparent; color: var(--ink); box-shadow: 0 0 0 1px var(--line);
  font-family: var(--display); font-size: clamp(13px, 1.6vw, 16px); letter-spacing: 0.16em; padding: 8px 18px;
}
.btn.ghost:hover { box-shadow: 0 0 0 1px var(--toxic); background: rgba(125, 255, 79, 0.12); }
.btn.ghost b { color: var(--amber); font-variant-numeric: tabular-nums; }
.fort-label { font-size: 10px; letter-spacing: 0.22em; color: var(--dim); text-transform: uppercase; margin-top: 16px; }
.store.fort { max-height: 22vh; margin-top: 8px; }
```

- [ ] **Step 3: `renderShop` をドラフト＋Fortify に書き換え**

`game/game.ts` の `renderShop`（1125-1149）を置換。ドラフトカードは `renderList`（キー＝`id:price:free`）、Fortify は既存 `.srow` を `#choices` に：

```ts
function renderShop(): void {
  const me = localPlayer(state);
  el("shop-credits").textContent = String(me.money);
  el("shop-free").textContent = me.draftFreeUsed ? "free pick used" : "1 free pick";

  // draft cards (from this player's offer)
  const cards = me.draftOffer
    .map((id) => cardItem(state, me, id))
    .filter((it): it is StoreItem => it !== undefined);
  const cardKey = (it: StoreItem) => `${it.id}:${it.price}:${me.draftFreeUsed ? 1 : 0}`;
  renderList(el("draft-cards"), cards, cardKey, (it) => {
    const free = !me.draftFreeUsed;
    const able = free || it.canBuy(state, me);
    const d = document.createElement("div");
    d.className = `dcard${able ? "" : " off"}`;
    const kind = it.id.startsWith("lvl:") ? "Weapon" : "Perk";
    const cost = free ? `<span class='dpick'>pick free</span>` : `<span class='sprice'>${it.price}</span>`;
    d.innerHTML = `<div class='dkind'>${kind}</div><div class='cname'>${it.name}</div><div class='desc'>${it.desc}</div><div class='dfoot'><span class='dpick'>${free ? "pick free" : ""}</span>${free ? "" : cost}</div>`;
    d.onclick = () => draftTake(it.id);
    return d;
  });

  // reroll button state
  const rc = rerollCost(me.draftRerolls);
  el("reroll-cost").textContent = String(rc);
  const rbtn = el<HTMLButtonElement>("rerollBtn");
  rbtn.onclick = () => draftReroll();
  rbtn.classList.toggle("off", me.money < rc || me.draftOffer.length === 0);

  // fortify list (deployables) — existing .srow look
  const forts = storeItems(state, me);
  renderList(el("choices"), forts, shopRowSig, (it) => {
    const able = it.canBuy(state, me);
    const d = document.createElement("div");
    d.className = `srow${able ? "" : " off"}`;
    d.innerHTML = `<div class='sinfo'><div class='cname'>${it.name}</div><div class='desc'>${it.desc}</div></div><div class='sprice'>${it.price}</div>`;
    d.onclick = () => buyItem(it.id);
    return d;
  });
}
```

> `buyItem` は現在 index 引数。Fortify をクリックで買えるよう **id 引数版に変更**する（Step 4）。`shopSel`/`shopEls`/`highlightShop` のホバー選択ロジックは Fortify では使わない（クリック駆動）ため、関連の未使用コードは lint に従い整理。

- [ ] **Step 4: `buyItem` を id 引数に、`syncShopUI` を再描画駆動に**

`game/game.ts` の `buyItem` を id 引数に変更：

```ts
/** Buy a Fortify (deployable) item by id. Client → request; host/single → apply + re-render. */
export function buyItem(itemId: string): void {
  if (!state.inShop) return;
  if (Net.mode === "client") {
    Net.client?.requestBuy(itemId);
    Audio.ui(true);
    return;
  }
  if (applyBuy(state, itemId, localPlayer(state))) {
    Audio.ui(true);
    renderShop();
  } else {
    Audio.ui(false);
  }
}
```

`game/game.ts` の `syncShopUI`（1233-1265）を、毎フレーム `renderShop()` を呼ぶ簡潔版に置換（offer/Fortify は localPlayer から再構築。差分最適化は `renderList` が担うので毎フレーム呼んでよい）：

```ts
export function syncShopUI(): void {
  const open = state.inShop;
  const shown = shopVisible();
  if (open && !shown) {
    el("shop-wave").textContent = String(state.day);
    show("shop");
  } else if (!open && shown) {
    hide("shop");
    return;
  }
  if (open) renderShop();
}
```

> これで client は snapshot で同期された `localPlayer().draftOffer`/`money` から毎フレーム再構築する（mode 非依存）。

**削除する孤児シンボル（明示・biome の未使用変数は赤になるので必須）**：`game/game.ts` の module 変数 `let shopItems` / `let shopSel` / `let shopEls` / `let shopSig`、`const shopSigOf`、`function highlightShop`、export `shopMove` / `shopBuySelected`。**保持**：`shopRowSig`（新 `renderShop` の Fortify 行キーで使用）。`game/main.ts` の `shopMove`/`shopBuySelected` の import（Task 9 で呼び出しは既に除去済）を削除。

**破壊的変更の束ね（必須）**：`buyItem` の `(i: number)` → `(itemId: string)` 変更と、その全呼び出し元の更新（旧 `shopBuySelected` 内 `buyItem(shopSel)` は `shopBuySelected` ごと削除、main.ts digit ハンドラは Task 9 で `draftTake` に置換済）を**この Task の単一コミットに束ねる**（中間コミットで number/string 不整合の型割れを作らない）。

- [ ] **Step 4b: `interactPrompt` の修理文言を SCRAP 0 に整合**

`game/game.ts:1381` の `return p.money >= CONFIG.siege.repairCost ? "[E] repair" : "[E] repair — no credits";` を、修理が無料になったので単純化：

```ts
    return "[E] repair";
```

- [ ] **Step 5: ビルド＋手動検証（SP）**

Run: `bun run typecheck` → PASS、`bun run dev` で起動。
手動チェック（feel-first）:
1. 初夜を生き延びて DEPLOY → 翌日。1日目クリア後のドラフトに **3枚**出る（perk/weapon、絵文字なし・トキシック/アンバー・モノスペース）。
2. 1枚目は **無料**で取れ、残りは **SCRAP 価格**表示に変わる。
3. **R**（or Rerollボタン）で引き直し、コストが `30→55→…` と上がる。
4. Fortify をクリックで買える。**バリケード修理が SCRAP 0**（HUD の Scrap が減らない）。
5. ENTER で翌日へ。既存 SP の挙動（昼夜・wave）は不変。

- [ ] **Step 6: Commit**

```bash
git add index.html game/style.css game/game.ts game/main.ts
git commit -m "feat(shop): nightly draft + fortify UI (single-player)"
```

---

## Task 11: トップ画面最小化 + 専用 ARSENAL 画面（WEAPONS+CARDS）

**Files:**
- Modify: `index.html`（`#start` から `#arsenal` を除去、新 `#arsenal-screen` overlay、`#start` に ARSENAL ボタン）
- Modify: `game/game.ts`（`renderArsenal` を2グループ化、`openArsenal`/`closeArsenal`、`unlockNode`）
- Modify: `game/main.ts`（ARSENAL ボタン配線）
- Modify: `game/style.css`（`#arsenal-screen` スタイル）

**Interfaces:**
- Consumes: `UNLOCKABLE`（weapons）, `UNLOCKABLE_CARDS`（cards）, `UPGRADES`（カード名解決）, `loadMeta`, `buyUnlock`。
- Produces: `openArsenal()`/`closeArsenal()`/`renderArsenal()`（export）, `unlockNode(id, price)`。

- [ ] **Step 1: index.html — `#start` の arsenal を撤去しボタン追加、専用 overlay 追加**

`index.html:91-100` の `<div id="arsenal">…</div>` ブロックを削除し、`.btn-row` に ARSENAL ボタンを追加：

```html
    <div class="btn-row">
      <button type="button" class="btn coop-cta" id="arsenalBtn">◆ Arsenal</button>
      <button type="button" class="btn" id="startBtn">Enter the Quarantine</button>
      <button type="button" class="btn coop-cta" id="mpCoopBtn">Co-op</button>
      <button type="button" class="btn coop-cta" id="optionsBtn">Options</button>
    </div>
```

`index.html` の `#start` overlay の閉じタグ後（他 overlay と並ぶ位置）に新 overlay を追加：

```html
<div id="arsenal-screen" class="overlay hidden">
  <div class="eyebrow"><span class="dot"></span>Arsenal &middot; between runs</div>
  <h1 style="font-size:clamp(26px,5vw,44px)">Arsenal</h1>
  <p>Salvage <b id="ars-bal" style="color:var(--toxic)">0</b> &#9670; &middot; unlock weapons &amp; cards — they enter your runs, they don't make you stronger</p>
  <div class="ars-groups">
    <div class="ars-col"><div class="ars-head">Weapons</div><div id="ars-weapons"></div></div>
    <div class="ars-col"><div class="ars-head">Cards</div><div id="ars-cards"></div></div>
  </div>
  <button type="button" class="btn" id="arsenalBackBtn">Back</button>
</div>
```

- [ ] **Step 2: スタイル追加**

`game/style.css` の arsenal セクション（`#arsenal { … }` 周辺、行 1093-1155）はそのまま使える（`.arow`/`.ars-head`）。`#arsenal-screen` 用に追記：

```css
.ars-groups { display: flex; gap: 22px; width: min(620px, 92vw); margin-top: 14px; text-align: left; }
.ars-col { flex: 1; min-width: 0; }
.ars-col > div[id] { display: flex; flex-direction: column; gap: 5px; max-height: 46vh; overflow-y: auto; }
```

- [ ] **Step 3: `renderArsenal` を2グループ化**

`game/game.ts` の `renderArsenal`（1311-1334）と `unlockWeapon`（1336-1343）を置換：

```ts
/** Render the dedicated ARSENAL overlay: SALVAGE balance + WEAPONS and CARDS unlock groups. */
export function renderArsenal(): void {
  const meta = loadMeta();
  el("ars-bal").textContent = String(meta.salvage);

  const weaponRows = UNLOCKABLE.flatMap((u) => {
    const w = WEAPONS[u.id];
    if (!w) return [];
    const owned = !!meta.unlocked[u.id];
    return [{ id: u.id, price: u.price, name: w.name, owned, able: !owned && meta.salvage >= u.price }];
  });
  const cardRows = UNLOCKABLE_CARDS.flatMap((c) => {
    const perkId = c.id.slice("card:".length);
    const u = UPGRADES.find((x) => x.id === perkId);
    if (!u) return [];
    const owned = !!meta.unlocked[c.id];
    return [{ id: c.id, price: c.price, name: u.name, owned, able: !owned && meta.salvage >= c.price }];
  });

  const draw = (boxId: string, rows: typeof weaponRows) =>
    renderList(
      el(boxId),
      rows,
      (r) => `${r.id}:${r.owned}:${r.able}`,
      (r) => {
        const d = document.createElement("div");
        d.className = `arow${r.owned ? " owned" : r.able ? "" : " off"}`;
        d.innerHTML = r.owned
          ? `<div class='cname'>${r.name}</div><div class='atag'>UNLOCKED</div>`
          : `<div class='cname'>${r.name}</div><div class='aprice'>${r.price} ◆</div>`;
        if (!r.owned && r.able) d.onclick = () => unlockNode(r.id, r.price);
        return d;
      },
    );
  draw("ars-weapons", weaponRows);
  draw("ars-cards", cardRows);
}

function unlockNode(id: string, price: number): void {
  if (buyUnlock(id, price)) {
    Audio.ui(true);
    renderArsenal();
  } else {
    Audio.ui(false);
  }
}

/** Open / close the dedicated arsenal overlay from the title screen. */
export function openArsenal(): void {
  renderArsenal();
  show("arsenal-screen");
}
export function closeArsenal(): void {
  hide("arsenal-screen");
}
```

`game/game.ts` の import に `UNLOCKABLE_CARDS`（`./data/upgrades`）と `UPGRADES`（既にあれば不要）を追加。`UNLOCKABLE`/`WEAPONS` は既存 import。

> **起動時クラッシュ回避（同一コミット必須）**：`game/main.ts:141` 付近で起動時に `renderArsenal()` が無条件で呼ばれ、`game/game.ts:1300-1308` の `toTitle()` も呼ぶ。新 `renderArsenal` は `el("ars-bal")`/`el("ars-weapons")`/`el("ars-cards")` を参照する。これらは `#arsenal-screen`（初期 `hidden` だが常に DOM 在）にあるので `el()`（getElementById）は成功する。**ただし index.html の `#arsenal-screen` 追加（Step 1）と `renderArsenal` 書き換え（Step 3）を必ず同一コミット（Step 6）に束ねる**こと。別々にすると、旧 index.html（`salvage-bal` 削除済）に新でない renderArsenal が `Missing element #salvage-bal` で起動クラッシュ、あるいは逆。`toTitle()` 内の `renderArsenal()` 呼びは残してよい（要素は常在）。

- [ ] **Step 4: main.ts ボタン配線**

`game/main.ts` のUIボタン配線部（`el("deployBtn").onclick = shopDeploy;` 付近、行 140）に追加：

```ts
  el("arsenalBtn").onclick = openArsenal;
  el("arsenalBackBtn").onclick = closeArsenal;
```

import に `openArsenal, closeArsenal` を追加。`renderArsenal` の import は使わなくなれば削除。

- [ ] **Step 5: ビルド＋手動検証**

Run: `bun run typecheck` → PASS、`bun run dev`。
手動チェック:
1. トップが `◆ Arsenal / Enter / Co-op / Options` のボタン行のみでスッキリ（解放一覧が消えた）。
2. **◆ Arsenal** で専用画面が開き、WEAPONS（rifle/lmg/magnum）と CARDS（quickHands/firstAid/bandolier/scavenger）の2列。SALVAGE 残高は **トキシック緑**。
3. 買える解放ノードは紫…ではなく **既存 `.arow` のトキシック hover**。クリックで解放＝再描画で UNLOCKED 表示。
4. Back でトップへ。解放したカードが翌ランのドラフトに出る（Task 10 のドラフトで確認）。

- [ ] **Step 6: Commit**

```bash
git add index.html game/style.css game/game.ts game/main.ts
git commit -m "feat(meta): dedicated ARSENAL screen (weapons + cards unlock tree)"
```

> **Phase 2 完了チェック:** SP で「ドラフト→翌日」「修理無料」「ARSENAL でカード解放→翌ランのプールに反映」が手で確認できる。`bun run test`/`typecheck`/`lint` 緑。

---

# Phase 3 — co-op 同期

## Task 12: snapshot に draft offer を載せる（round-trip テスト）

**Files:**
- Modify: `game/net/snapshot.ts`（`SnapPlayer`/`captureSnapshot`/`applySnapshot`/`encode`/`decode`）
- Modify: `game/net/net.ts`（`PROTOCOL_VERSION` 11→12）
- Modify/Read: `game/net/snapshot.test.ts`（golden 更新 + 新 round-trip テスト）

**Interfaces:**
- Consumes: `CARD_ORDER`（`../data/arsenal`）。
- Produces: snapshot が per-player に `draftOffer`（CARD_ORDER 索引列）・`draftFreeUsed`・`draftRerolls` を運ぶ。

- [ ] **Step 1: PROTOCOL_VERSION を bump**

`game/net/net.ts` の `export const PROTOCOL_VERSION = 11;` を `= 12;` に。

- [ ] **Step 2: import と SnapPlayer 拡張**

`game/net/snapshot.ts` の import に追加：

```ts
import { CARD_ORDER } from "../data/arsenal";
```

`SnapPlayer` の `absent: boolean;` の後に追加：

```ts
  /** between-nights draft offer, as CARD_ORDER indices */
  draftOffer: number[];
  draftFreeUsed: boolean;
  draftRerolls: number;
```

- [ ] **Step 3: captureSnapshot に追加**

`captureSnapshot` の各 player オブジェクトの `absent: p.absent,` の後に追加：

```ts
      draftOffer: p.draftOffer.map((id) => CARD_ORDER.indexOf(id)).filter((i) => i >= 0),
      draftFreeUsed: p.draftFreeUsed,
      draftRerolls: p.draftRerolls,
```

- [ ] **Step 4: applySnapshot に追加**

`applySnapshot` の player 適用の `p.absent = sp.absent;` の後に追加：

```ts
    p.draftOffer = sp.draftOffer
      .map((i) => CARD_ORDER[i])
      .filter((id): id is string => id !== undefined);
    p.draftFreeUsed = sp.draftFreeUsed;
    p.draftRerolls = sp.draftRerolls;
```

- [ ] **Step 5: encode に追加**

`encode` の per-player ループ、`for (const di of p.deployQueue) w.u8(di);` の後、フラグバイト行の **前**に追加：

```ts
    w.u8(p.draftOffer.length);
    for (const ci of p.draftOffer) w.u8(ci);
    w.u8(Math.min(255, p.draftRerolls));
```

フラグバイト行に `draftFreeUsed`（bit2）を追加：

```ts
    w.u8((p.lightOn ? 1 : 0) | (p.absent ? 2 : 0) | (p.draftFreeUsed ? 4 : 0));
```

- [ ] **Step 6: decode に追加**

`decode` の per-player ループ、`for (let j = 0; j < dqc; j++) deployQueue.push(r.u8());` の後、`const pflags = r.u8();` の **前**に追加：

```ts
    const draftOffer: number[] = [];
    const doc = r.u8();
    for (let j = 0; j < doc; j++) draftOffer.push(r.u8());
    const draftRerolls = r.u8();
```

`const lightOn` / `const absent` の行の後に追加：

```ts
    const draftFreeUsed = (pflags & 4) !== 0;
```

`players.push({ … })` の `absent,` の後に追加：

```ts
      draftOffer,
      draftFreeUsed,
      draftRerolls,
```

- [ ] **Step 7: 失敗するテストを書く + golden 更新**

まず `game/net/snapshot.test.ts` を読み（`cat` ではなく Read ツール）、既存の round-trip テストの隣に追記：

```ts
it("round-trips draft offer fields", () => {
  const s = newState(); // adapt to the test file's existing state-builder helper
  const p = s.players[0]!;
  p.draftOffer = ["perk:hollowPoints", "lvl:pistol"];
  p.draftFreeUsed = true;
  p.draftRerolls = 2;
  const back = decode(encode(captureSnapshot(s, 1)));
  const bp = back.players[0]!;
  expect(bp.draftOffer.map((i) => CARD_ORDER[i])).toEqual(["perk:hollowPoints", "lvl:pistol"]);
  expect(bp.draftFreeUsed).toBe(true);
  expect(bp.draftRerolls).toBe(2);
});
```

> テスト内の state 生成は当該ファイルの既存ヘルパに合わせる（`newState()` か独自 fixture）。`CARD_ORDER`/`captureSnapshot`/`encode`/`decode` を import。

golden byte test（`snapshot.test.ts:129-131`）：`expect(\`len=${bytes.length} fnv=...\`).toMatchInlineSnapshot(\`"len=295 fnv=b7e42223"\`)` という **Vitest インラインスナップショット**。draft フィールド追加でバイト長/FNV が変わり必ず落ちる（bump 強制の意図通り）。FNV は手計算不能なので、**`bun run test -- -u`（vitest の `-u`=update snapshots）で実出力に自動更新**する。更新後、diff を目視して `len=` が増えていること（offer 分のバイト増）を確認。

- [ ] **Step 8: テスト実行（golden 自動更新）**

Run: まず `bun run test -- snapshot`（round-trip は緑、golden は赤を確認）→ `bun run test -- -u`（golden を実出力へ更新）→ 再度 `bun run test -- snapshot` と `bun run typecheck`
Expected: 最終 PASS。`snapshot.test.ts` の `toMatchInlineSnapshot` が新しい `len=/fnv=` に書き換わる。

- [ ] **Step 9: Commit**

```bash
git add game/net/snapshot.ts game/net/net.ts game/net/snapshot.test.ts
git commit -m "feat(net): sync draft offer in snapshot; bump PROTOCOL_VERSION to 12"
```

---

## Task 13: CoopEvent（draftTake/draftReroll）+ host 適用 + shop 中 spawn の offer 生成

**Files:**
- Modify: `game/net/events.ts`（`CoopEvent`）
- Modify: `game/net/client.ts`（request メソッド）
- Modify: `game/net/host.ts`（適用ハンドラ + spawnFresh offer 生成）
- Modify: `game/game.ts`（host が呼ぶ apply は Task 8 で export 済）

**Interfaces:**
- Consumes: `applyDraftTake`/`applyDraftReroll`/`rollDraft`（game.ts, Task 8）。
- Produces: `CoopEvent` に `{t:"draftTake";cardId:string}` と `{t:"draftReroll"}`。`Client.requestDraftTake(cardId)`/`requestDraftReroll()`。

- [ ] **Step 1: CoopEvent を拡張**

`game/net/events.ts` の `CoopEvent` に2つ追加（`deploy` の後）：

```ts
  | { t: "deploy" } // leave the shop, start the next day
  | { t: "draftTake"; cardId: string } // take a draft card (1st of the night free, then SCRAP)
  | { t: "draftReroll" } // reroll the requester's draft offer for escalating SCRAP
```

- [ ] **Step 2: client.ts に request メソッド**

`game/net/client.ts` の `requestDeploy()` の後に追加：

```ts
  requestDraftTake(cardId: string): void {
    this.link.sendRel({ t: "draftTake", cardId });
  }
  requestDraftReroll(): void {
    this.link.sendRel({ t: "draftReroll" });
  }
```

> これは純追加。Task 9 の型解決のため、本ステップを Task 9 より先に入れてよい。

- [ ] **Step 3: host.ts に適用ハンドラ**

`game/net/host.ts` のイベント適用部（113-125、`buy`/`place`/`deploy` の連鎖）に追加。`applyDraftTake`/`applyDraftReroll` を game.ts から import：

```ts
} else if (msg.t === "deploy") {
  shopDeploy(); // idempotent (no-op unless the shop is open)
} else if (msg.t === "draftTake") {
  applyDraftTake(
    st,
    st.players.find((pl) => pl.id === peer.pid),
    msg.cardId,
  );
} else if (msg.t === "draftReroll") {
  applyDraftReroll(
    st,
    st.players.find((pl) => pl.id === peer.pid),
  );
}
```

`game/net/host.ts` の import 行に `applyDraftTake, applyDraftReroll` を追加（既存の `applyBuy, applyPlace, shopDeploy` と同じ game import 元）。

- [ ] **Step 4: shop 中に spawn したプレイヤーへ offer 生成**

`game/net/host.ts` の `spawnFresh`（246-252）末尾に追加（shop 中の join/spawn でも offer を持たせる）：

```ts
private spawnFresh(pid: number): void {
  const st = getState();
  if (st.players.some((p) => p.id === pid)) return;
  const x = HOME_SPAWN.x + ((pid % 4) - 1.5) * 36;
  const p = addPlayer(st, pid, x, HOME_SPAWN.y, `P${pid + 1}`);
  if (st.phase === "night" && !st.inShop) p.hp = 0;
  if (st.inShop) rollDraft(st, p); // entering mid-shop → roll an offer so their draft UI isn't empty
}
```

`game/net/host.ts` の import に `rollDraft` を追加。

- [ ] **Step 5: 型チェック + co-op 手動検証**

Run: `bun run typecheck` → PASS。
co-op 手動チェック（`bun run dev:coop`、2タブ or 2端末）:
1. host と client が同じ部屋に入り夜を越える → **各自に別々のドラフト3枚**が出る（個人ごと）。
2. client が無料ピック/追加購入/リロール → host 権威で適用され、**client の画面が snapshot 経由で更新**。
3. **shop 中に client が再接続**しても（リンク切断→再接続）、ドラフトが空にならず復元される（snapshot 同期）。
4. host が DEPLOY → 全員翌日へ。SP は無影響（`bun run dev` で従来通り）。

- [ ] **Step 6: 最終チェック + Commit**

Run: `bun run typecheck` && `bun run test` && `bun run lint` && `bun run build`
Expected: 全 PASS（`knip` は informational）

```bash
git add game/net/events.ts game/net/client.ts game/net/host.ts
git commit -m "feat(net): co-op draft events (take/reroll) + mid-shop offer spawn"
```

---

## 完了の定義
- `bun run typecheck` / `bun run test` / `bun run lint` / `bun run build` 全 PASS。
- SP：毎夜3枚ドラフト（無料1＋SCRAP追加/リロール）、修理無料、専用 ARSENAL でカード/武器解放→翌ランのプール反映。
- co-op：個人ごとのドラフトが snapshot 同期、shop 中再接続でも復元、host 権威適用。
- ビジュアルは既存トークンのみ（絵文字/グラデ/捏造色なし）。
- SP は byte-identical（co-op コードに触れても挙動不変）。

## 自己レビュー（Spec coverage）
- 5章ドラフト → Task 8/9/10。6章カードプール → Task 2/3/4。7章メタ/ARSENAL画面 → Task 2/11。4章 SCRAP/修理 → Task 1（recast は money 流用＝命名のみ、UI 文言は Task 10/11 で "Scrap"/"Salvage"）。8章ネット → Task 12/13。3.5 品質バー → 各 UI タスクの Global Constraints とビジュアル要件。10章変更点 → 全タスクに分配。11章テスト → Task 2-8/12 の pure テスト。
- 既知の保留（プレイテスト）：価格/枚数/リロール式/SCRAP源泉の昼夜配分/starter配分（§12 調整ノブ）。co-op の SCRAP 源泉スケール検証は実装後の調整事項として残す。
