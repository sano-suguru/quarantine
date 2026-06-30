# 設計: ドラフト経済の根本修正（PR #29 コードレビュー対応）

- 日付: 2026-06-30
- 対象ブランチ: `feat/economy-redesign`（PR #29）
- 前提仕様: [`2026-06-30-economy-redesign-design.md`](./2026-06-30-economy-redesign-design.md)

## 1. 背景

PR #29（経済再設計：SCRAP + 夜間ドラフト + ARSENAL）のコードレビューで 4 件の指摘が出た。本設計はそれらを **対症療法を避け根本原因から** 修正する。CLAUDE.md の非交渉項目「対症療法・特例コードを足さず、既存の仕組みを拡張する」「feel-first（体感は実機検証）」に従う。

## 2. 指摘と根本原因

| # | 指摘 | レビュー確度 | 根本原因 |
|---|---|---|---|
| 1 | `applyDraftReroll` が `rollOffer` に `exclude` を渡さず、その夜に取得済みの perk カードがリロールで再提示され二重適用（`dmgMul *= 1.25` の倍掛け等） | 85 | `Player` の夜間ドラフト状態が過少モデル化：取得済みカードの記録が無い |
| 2 | `CONFIG.arsenal.freePicks`(=1) がどこからも読まれない死んだ設定値（実ロジックは `draftFreeUsed: boolean` でハードコード） | 75 | 同上：無料ピックが bool でモデル化され回数概念が無い |
| 3 | `CARD_ORDER` が `!WEAPONS[id]?.melee` を使い、`WEAPONS` 未定義 id を取りこぼせず wire-index に混入させうる | 25 | `CARD_ORDER` と `draftPool` の武器フィルタ述語が不一致 |
| 4 | 旧 `game.test.ts` の「購入は buyer のみ／teammate に漏れない」回帰テスト（commit `b8226c9`）が PR で消失 | 45 | perk が `applyBuy` から `applyDraftTake` へ移動した際にテストが移植されなかった |

指摘 1・2 は **同一の根**（夜間ドラフト状態の過少モデル化）。状態モデルを正せば両方解消する。

## 3. 設計

### 3.1 夜間ドラフト状態の再モデル化（指摘 1 + 2）

`Player` のフィールドを変更する。

- 削除: `draftFreeUsed: boolean`
- 追加: `draftFreePicksUsed: number` — その夜に消費した無料ピック数
- 追加: `draftTaken: string[]` — その夜に取得したカード id（**host のみが読む抽選状態。snapshot 非同期**）

ロジック（`game/game.ts`、host/single のみが実行する純粋関数）:

- `rollDraft(state, p)`: `p.draftFreePicksUsed = 0`、`p.draftTaken = []`、`p.draftRerolls = 0` にリセットしてから offer 生成。
- `applyDraftTake(s, buyer, cardId)`:
  - 無料判定 = `buyer.draftFreePicksUsed < CONFIG.arsenal.freePicks`。無料なら `draftFreePicksUsed += 1`、有料なら `canBuy` を確認し `money -= price`。
  - **take が成立したら、無料・有料いずれの枝でも** `if (cardId.startsWith("perk:")) buyer.draftTaken.push(cardId)`（後述 3.5 のとおり現状は perk のみ記録）。
  - 取得カードを `draftOffer` から除去（既存どおり）。
- `applyDraftReroll(s, buyer)`: `rollOffer(draftPool(s, buyer), buyer.draftOffer.length, buyer.draftTaken)` — 既存の `exclude` 引数（この用途で設計済み）に取得済みを渡す。

これにより `freePicks` が実レバー化し、取得済み perk の再出現＝二重取得が構造的に消える。

> **最重要**: 取得済みの記録は **無料枝・有料枝の両方** で行う。有料枝で記録を怠ると、有料取得した perk がリロールで再提示され、指摘 1 のバグが有料経路で残存する。

### 3.2 スナップショット（PROTOCOL_VERSION 据え置き）

`draftFreeUsed` は現在 pflags の **bit2**（`snapshot.ts:570`）に符号化されている。host は `draftFreePicksUsed` カウンタを真実として保持し、wire は **派生 bool** に保つ:

- encode: `bit2 = (p.draftFreePicksUsed >= CONFIG.arsenal.freePicks)` — 「無料を使い切ったか」
- decode（client のみ）: `p.draftFreePicksUsed = bit ? CONFIG.arsenal.freePicks : 0`
- `SnapPlayer.draftFreeUsed: boolean` は射影として温存

結果: wire レイアウト不変・**PROTOCOL_VERSION 12 のまま**・golden test 不変。`draftTaken` は host 専用・非同期なので wire 影響なし。

安全性（ラバーダック検証で確認済み）:
- host は `decode`/`applySnapshot` を呼ばない（capture → encode → broadcast の一方向）。`applySnapshot` は `client.ts` のみが呼ぶ。host 権威状態が snapshot 経由で上書きされる経路は無い。
- client の `reconcile` は位置（`predX/predY`）のみを予測対象とし、draft 系は触らない純表示値。丸めが client ロジックを誤動作させる先が無い。
- 取得カードは `draftOffer` から除去され次 snapshot で client の offer から消えるため、`draftTaken` を client に運ばなくても UI 不整合は出ない。

既知の天井（要コメント明記）: 本設計は **freePicks = 1 を前提**に wire/UI を bool 射影している。`freePicks >= 2` にすると client は残り無料数を bool から復元できず、2 回目の無料ピックを「有料」と誤表示する（host は正しく無料適用するので機能は壊れないが UI が嘘をつく）。`snapshot.ts` の pflags 付近に「freePicks を 2 以上にするなら wire を生カウンタ u8 へ昇格し、`renderShop` を残数表示へ同時に上げること」と 1 行コメントを残す。

### 3.3 武器述語の単一化（指摘 3）

`CARD_ORDER`（`!WEAPONS[id]?.melee`）と `draftPool`（`if (!w || w.melee)`）の不一致が根。共有述語を **`game/data/weapons.ts`（依存の葉）** に置く:

```ts
export const isUpgradeableWeapon = (id: string): boolean => {
  const w = WEAPONS[id];
  return w != null && !w.melee;
};
```

`CARD_ORDER` と `draftPool` の双方で使用する（`draftPool` は `&& state.owned[id]` を追加）。`weapons.ts` は依存の葉（`arsenal.ts → weapons.ts` の一方向 import）なので循環しない。存在しない id が wire-index に混入する footgun を構造的に除去する。

### 3.4 隔離テストの復元（指摘 4）

perk は経済再設計で `applyBuy` から `applyDraftTake` へ移動した。よって復元先と対象を正す:

- `game/game.draft.test.ts` に **2 人プレイヤー** のテストを追加: player0 が perk カードを take → player1 の `dmgMul`/`maxHp`/`money` が不変であることをアサート。
- `game/game.test.ts`（Fortify 専用になった `applyBuy`）にも隔離テストを 1 本追加: buyer の `deployQueue` にのみ push され teammate は不変。

これで commit `b8226c9`（個人ウォレット）の回帰ガードを完全に回復する。

### 3.5 設計判断（要 feel-first プレイテスト）: weapon を `draftTaken` に含めるか

- perk の除外は **正しさ**（`canBuy: money >= cost` で夜あたり上限が無く二重掛けは実バグ）。
- weapon の除外は **balance のみ**（`canBuy` が `wlevel < maxLevel` でガード済みなので、除外しなくても壊れない。除外は「1 武器 1 強化/夜」という仕様判断）。

本設計のデフォルトは **perk のみ除外**（バグ修正はバグ以外の挙動を変えない、の原則）。weapon はリロールで連投可のまま（現状どおり）。「1 夜 1 強化」を導入したい場合は独立した feel 判断として **実機プレイテストで決定**する。`applyDraftTake` の push を `cardId.startsWith("perk:")` で分岐しておくため、統一規則（weapon も除外）への切替は 1 箇所の条件変更で済む。

## 4. 影響ファイル

| ファイル | 変更 |
|---|---|
| `game/types.ts` | `Player`: `draftFreeUsed: boolean` 削除 → `draftFreePicksUsed: number` 追加、`draftTaken: string[]` 追加。doc コメント更新 |
| `game/engine/players.ts` | `makePlayer`: `draftFreePicksUsed: 0`, `draftTaken: []` で初期化 |
| `game/game.ts` | `rollDraft`/`applyDraftTake`/`applyDraftReroll` 改修、`renderShop` の無料判定を `draftFreePicksUsed < CONFIG.arsenal.freePicks` に、UI 文言を残数表示に。**`renderShop` の `cardKey`（`renderList` 差分キー）も `draftFreeUsed` → `draftFreePicksUsed`（または「無料が残っているか」の bool）を含める** — 怠ると無料消費後にカードが再描画されず古い FREE/価格表示が残る |
| `game/data/arsenal.ts` | `CARD_ORDER`・`draftPool` を `isUpgradeableWeapon` 使用に |
| `game/data/weapons.ts` | `isUpgradeableWeapon` 追加 |
| `game/net/snapshot.ts` | encode/decode を `draftFreePicksUsed` 射影に（wire 不変）、freePicks=1 前提コメント 1 行 |
| `index.html` | `#shop-free` の初期文言（残数表示に合わせる） |
| テスト | **既存 `game.draft.test.ts` の `draftFreeUsed` 直接参照3本（行12/24/34 付近の read/write アサーション）を `draftFreePicksUsed` 射影へ更新**（フィールド rename に伴う必須更新。怠ると pre-push の `bun run test` で落ちる）＋ 追加（取得済み除外の回帰・freePicks 配線・2 人隔離）。`game.test.ts`（Fortify 隔離）。`snapshot.test.ts`（`SnapPlayer.draftFreeUsed` 射影は温存のため最小変更、Player 側 set を `draftFreePicksUsed` に） |

`config.ts` は `freePicks` が既存のため変更なし（参照されるようになるだけ）。**systems 不変・single-player 挙動不変・wire 不変。**

## 5. テスト方針

純粋・決定的な範囲のみ（CLAUDE.md のテスト方針どおり）:

- `game.draft.test.ts`:
  - 取得済み除外（回帰）: **perk** を free で take → reroll → 取った perk id が新 offer に出ない。**有料経路も（perk 種別固定）**: `perk` を free 1 枚 → 別の `perk` を有料 1 枚 take → reroll → 有料取得した perk の id が出ない。**注**: weapon-upgrade カードは `draftTaken` に記録しない（§3.5 perk-only）ため reroll で再出現する。よってこの除外テストは必ず **perk** で書く（weapon で書くと意図どおり落ちない）。
  - freePicks 配線: `CONFIG.arsenal.freePicks` を一時的に 2 にして「2 回無料・3 回目課金」を検証。**`CONFIG` は mutable だが、assertion 失敗時に復元行へ到達せず同一ファイルの後続テストを汚染するため、`try { … } finally { CONFIG.arsenal.freePicks = 1 }` か `afterEach` で必ず元値へ戻す**（Vitest はファイル単位並列なので他ファイルへは漏れないが、同ファイル内逐次テスト間が唯一のリスク）。
  - 2 人隔離: `addPlayer(s, 1, 0, 0)` で teammate を足し、player0 の perk take が player1 の `dmgMul`/`maxHp`/`money` に漏れないことをアサート。
- `game.test.ts`: `applyBuy`(Fortify) が buyer の `deployQueue` のみに作用し teammate 不変。
- `arsenal.test.ts`: 既存の `rollOffer` "honors exclude" を維持。`isUpgradeableWeapon` 単体（melee 除外・未定義 id 除外）。
- `snapshot.test.ts`: golden 不変を確認。`draftFreePicksUsed` 射影の round-trip。

feel-first（実機プレイテスト、ユニットテスト対象外）:
- リロールで取得済み perk が出ないことの体感、SCRAP テンポ。
- 3.5 の「weapon を 1 夜 1 強化に制限するか」の体感確認。

## 6. 非目標（YAGNI）

- `freePicks >= 2` の wire/UI 対応（生カウンタ同期・残数表示）。今は freePicks=1 のため不要。必要時に follow-up。
- weapon の「1 夜 1 強化」制約の確定（プレイテストで別途判断）。
- delta snapshot 圧縮等、PR #29 の範囲外項目。
