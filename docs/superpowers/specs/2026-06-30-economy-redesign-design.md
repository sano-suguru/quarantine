# QUARANTINE 経済リデザイン設計書

- **日付**: 2026-06-30
- **状態**: ドラフト（レビュー待ち・ラバーダックレビュー反映済み）
- **対象**: ラン内経済・毎夜の購入・メタプログレッション（SALVAGE）の統合再設計
- **改訂履歴**: 外部レビュー（rubber-duck）の指摘を反映 — ①offer を reliable イベントでなく snapshot で同期（§8）②`CardRef` を新設せず `StoreItem` 再利用（§10）③`rollOffer` に rng 注入（§10/§11）④`card:` 名前空間と `state.ts` の owned 汚染を手当て（§7.3）⑤修理を SCRAP から外し「易しい床」を担保（§4.1/§3.5.3）⑥弾薬床が perk 非依存である根拠を明記（§6.1）。

## 1. 背景と問題

現状の経済は2つの不満を抱えている。

1. **メタ進行が薄い** — SALVAGE の使い道が武器3種（rifle/lmg/magnum）の恒久アンロックのみ。3ランほどで買い切り、以降 SALVAGE が無意味になる。長く遊ぶ動機を支えられていない。
2. **毎夜の購入がローグライクでない** — 生き延びた後の購入が「全カタログの店」（武器強化＋パーク7種＋設置物が12項目以上フラットに並ぶ・固定価格・金があれば全部買える）。選択の緊張もビルドの個性もラン毎の変化も生まれず、ユーザーフレンドリーでもない。

両者の根は同じ：**「店（full catalog から買う）」モデルを採っているが、ジャンルが求めるのは「ドラフト（ランダムな少数から選ぶ）」モデル**。さらにラン内通貨 `credits` は抽象的で、昼の探索（7DtD 的な資源収集→拠点強化の方向性）と噛み合っていない。

## 2. ゴール / 非ゴール

**ゴール**
- 毎夜の購入を「店」から「ドラフト」へ。少数提示・取り逃しの緊張・ラン毎のビルド差を生む。
- メタ進行を「強さ」でなく「多様性（引きの幅）」を買う**アンロックツリー**にし、事実上無限の sink にする。
- ラン内通貨を抽象 `credits` から**昼に集める単一資源 SCRAP** に置き換え、昼の収集を夜の備えに直結させる。
- co-op／single-player の既存アーキテクチャ（個人ウォレット・ホスト権威・「state を snapshot 同期 → UI は両者ローカル再構築」パターン）を壊さない。snapshot は**拡張する**が、その拡張は既存メカニズムに忠実に行う（offer を `Player` に載せる＝§8）。

**非ゴール（別 spec）**
- 本格的な base-building（昼の資源採集・建築の深掘り）。本 spec は「7DtD と両立可能な SCRAP 経済の土台」までに留める。深掘りは次の brainstorm で扱う。
- 振る舞い系カード（貫通／吸血／爆発弾 等）の具体設計。仕組みは本 spec で用意し、中身はデータ追加フェーズで段階的に足す。
- レアリティ／重み付き抽選。v1 は一様抽選。

## 3. 設計原則との整合（CLAUDE.md）

- **Feel-first**：ドラフトの枚数・無料数・価格感・リロール式は本書では初期値を置くだけで、**確定はプレイテストで詰める**（feel 変更は遊んで確かめるまで done としない）。
- **Data-driven, zero special-case**：カード／解放ノード／設置物は既存のデータテーブル（`data/upgrades.ts`・新 `UNLOCKABLE_CARDS`・`DEPLOYABLE_TYPES`）と `CONFIG` で表現する。ドラフトの仕組みは `arsenal.ts`／`game.ts`／`net/` の既存 seam に乗せ、bespoke なコードパスを作らない。

## 3.5 品質バー（一貫性・非Slop・カジュアル配慮）

本リデザインが満たすべき非機能要件。実装・レビュー時のチェック項目とする。

### 3.5.1 既存デザインとの一貫性（実トークンで固定）
ドラフト画面・ARSENAL 画面は既存の `game/style.css`（commit 495be13）の語彙だけで作る。**新しいビジュアル言語・新色・新フォントを足さない。**

- **実パレット**（`:root`）：`--bg #070a08` / `--toxic #7dff4f`（主アクセント＝選択・解放・interactive）/ `--amber #ffb347`（価格・spendable 資源）/ `--blood #ff4d4d`（危険・買えない）/ `--ink`（本文）/ `--dim`（ラベル）/ `--line #1b2420`（1px 罫線）。**teal・紫は存在しない。使わない。**
- **配色の役割**：SCRAP＝`--amber`（既存の `.sprice`/`.aprice` と同じ＝spendable）、SALVAGE＝`--toxic`（既存の `.atag`/owned と同じ＝permanent/unlock）。これで2通貨を**既存トークン内で**色分けできる（捏造色なし）。
- **フォント**：本文＝モノスペース（`SF Mono`/ui-monospace）、見出し・ボタン・大きな数字＝`--display`（Haettenschweiler 系コンデンス）。数値は `font-variant-numeric: tabular-nums`。**サンセリフ（Inter 等）を持ち込まない。**
- **行/カードは既存 `.srow` 系に倣う**：フラットな `rgba(0,0,0,.4)` 背景＋1px `--line` 罫線。選択は `.srow.sel`（toxic 罫線＋淡い緑グロー）、無効は `.off`（opacity 0.42＋価格 blood）。ARSENAL ノードは既存 `.arow` を流用。
- **過剰装飾の禁止**：グラデーション背景カード・大きな角丸（>4px）・hover の `translateY` リフト・多重 box-shadow・ピル/バッジの乱用・**絵文字は使わない**。アニメは既存の節度（`pulse`/`fadeIn`/boot flicker）の範囲に留める。
- **武器カードのアイコンは絵文字でなく `WeaponDef.viz` のベクター形状**を縮小描画（engine の shape 描画と同じ見た目）。本書のモックの絵文字（🔫🩸✚ 等）は brainstorm 用の仮であり**本番仕様ではない**。
- UI はフレームワーク無しのバニラ DOM（`ui.ts` の `el`/`show`/`hide`/`renderList`）のまま。

### 3.5.2 AI Slop にしない（QUARANTINE 固有の手触り）
- ドラフトは「無味な汎用カードメニュー」にしない。**ホラーの文脈で包む**：夜明けの演出（"Night n survived"／dread 音の継続）、SCRAP＝生存資源の希少さ、暗闇から物資をかき集めた感。`game.ts:audioAmbience` の dread を画面遷移と繋げる。
- **flat な「+X%」スティックは v1 の既知の弱点**であり、QUARANTINE 固有の個性は ①武器の実ベクター描画 ②世界観に根ざしたカード名・フレーバー ③段階追加する**振る舞い系カード**（貫通／吸血／爆発弾＝synergy が立つ）から出す。v1 で仕組みを作り、識別性は後続データで厚くする — テンプレ流用で終わらせない。
- レイアウトは「ジャンルのテンプレ」をなぞるのでなく、本作の既存オーバーレイ構図（eyebrow→title→本体→主アクション）に従わせる。

### 3.5.3 カジュアルを遠ざけない（易しい床・任意の天井）
- **易しい床（不変property・ラバーダック観点4で補強）**：毎夜の**無料1枚**だけ取って即 DEPLOY すれば SCRAP 経済を無視して遊べる。これが崩れないよう、**生存に必須な修理は SCRAP 不要**（§4.1）にし、SCRAP の「壁か銃か」は任意の Fortify／追加ピック／リロールだけに閉じる。加えて、弾薬の床は**毎ショップの `resupply()`（`shopRefillMags`）＋ kill ドロップ**で構造的に担保され、パーク（Bandolier/Scavenger 等）に依存しない — よって後述の lean start は弾切れ＝死を招かない（観点5への回答）。
- **早い達成感**：初期ランで「何かが解放できた」を作るため、**CARDS の最初の解放を安価に**する（最安ノードを SALVAGE 数ランで届く価格に）。lean start が「全部ロックで弱い」と感じさせないこと。
- **starter セットは単体で楽しいこと**：starter 3パーク＋3武器だけで1ランが成立し面白いと、プレイテストで確認する（痩せ過ぎなら starter を増やす）。
- **死のスパイラルを作らない（観点5）**：初期ランが痩せる→死亡→ salvage 少→解放遅い、の負スパイラルを避ける。担保は ①弾薬床が perk 非依存（上記）②最安解放が安価 ③無料1枚で必ず進歩。これでも体感が弱すぎればプレイテストで starter を増やす。
- **グランス性**：カードは一目で分かる短い文言。専門用語・数値の洪水にしない。トップは2ボタンのみ（解放の山は専用画面に隔離）。
- **段階的開示**：複雑さ（リロール価格上昇・追加ピック）はその場で必要になって初めて見えれば良い。チュートリアル的な過剰説明は不要。

## 4. コア経済

### 4.1 通貨

| 通貨 | 範囲 | 源泉 | 用途 | 表示 |
|---|---|---|---|---|
| **SCRAP** | ラン内 | 主に昼の探索（キャッシュ／POI）、kill でも少々 | ドラフトのリロール／追加ピック ＋ Fortify（設置物の設置）。**バリケード修理は SCRAP 不要に変更（下記）** | `--amber`（既存の価格色） |
| **SALVAGE** | ラン跨ぎ（メタ） | クリーンな game-over でバンク | アンロックツリー（武器・カード解放） | `--toxic`（既存の解放/owned 色） |

- `credits`（=`Player.money`）を **SCRAP に recast** する。個人ウォレット・bounty 分配は流用し、**意味づけのみ変える**。識別子は内部的に `money` のままでも良いが、UI 文言と概念は SCRAP に統一する。
- **修理を SCRAP から外す（ラバーダック観点4 反映）**：`siege.repairCost`（現 15）を 0 にし、バリケード修理は**時間／クールダウン（`repairCd`）でのみゲート**する純粋な労働（戦闘・探索の機会費用が対価）。`econ.repairReward`（現 12）も廃止（修理が金を生む/食う両方を断つ）。理由 — 現状 `repairReward(12) < repairCost(15)` で修理は純損失。これを SCRAP 経済に残すと「真面目に壁を維持するほどドラフトで引けない」逆インセンティブと、§3.5.3 の「易しい床」破綻を招く。**生存に必須な修理は無料、最適化（壁の増強 vs 銃）は任意枠に閉じる**。
- **コアの緊張は"任意枠"に閉じる**：SCRAP の *壁か銃か* は「Fortify（設置物：砲台/ドローン/補給station）」と「ドラフトの追加ピック／リロール」の競合に限定。どちらも生存必須ではない最適化なので、無視しても床は崩れない。
- **源泉の再チューニング方針**：昼の収集（キャッシュ／POI）を SCRAP の主な源泉に寄せ、kill 由来を相対的に下げる。ただし **co-op の収入スケーリングは現状 kill 由来の bounty 前提**（`econ.bountyRadius`/`waveCountPerPlayer`）。源泉を昼に寄せる場合、4人ランの SCRAP が単独設計と乖離しないよう、**昼の cache 収入も人数スケールさせるか**を実装前に検証する（「プレイテストで」の丸投げにしない）。
- **命名の注意**：SCRAP（ラン）と SALVAGE（メタ）は語感が近い。色（`--amber`＝SCRAP／`--toxic`＝SALVAGE・§3.5.1）とラベルで差別化する。混乱が残るならラン側を `SUPPLIES` に改名する余地を残す（実装前に最終確認）。

## 5. 毎夜のドラフト

夜を生き延びると（`openShop()` の遷移点）、従来の「店」オーバーレイ `#shop` を再構成した**ドラフト画面**を開く。新規オーバーレイは作らない。

### 5.1 提示構造
- **3枚提示**：カードプール（§6）から一様ランダムに3枚抽選。同一提示内で重複なし。プールが3未満なら在るだけ提示。
- **無料1枚**：`freePicks = 1` のトークンで、提示3枚のどれか1枚を SCRAP 消費なしで取得。破産していても必ず1歩進める。
- **追加ピック**：無料ピック後、残りの提示カードを SCRAP で購入可（価格は §6.3）。買えば即適用、そのカードは消費。
- **リロール**：未取得スロットを引き直す。コスト＝`rerollBase + rerollStep × (その夜のリロール回数)`。**夜ごとにリセット**（spam 防止）。
- **完了**：`DEPLOY → DAY n+1`。既存 `shopDeploy()` の遷移（idempotent guard 込み）を維持。

### 5.2 Fortify 枠
- 設置物3種（Supply Station / Auto-Sentry / Hunter Drone）は**ドラフト対象外**。ドラフト画面下部の別枠リストで SCRAP 購入（従来の `storeItems` の deploy ロジックを流用）。空間・戦術要素でカードと性質が違うため分離する。

### 5.3 画面（モック準拠・ただし §3.5.1 のビジュアル要件が優先）
- 見出し「Night n survived」／SCRAP 残高／「◆ 1 FREE PICK」トークン。
- 3カード（種別ラベル：Perk ／ Weapon ▸ owned）、各カードに「Pick free」ピル＋ SCRAP 価格。**武器カードのアイコンは `WeaponDef.viz` の縮小描画**（絵文字は使わない・§3.5.1）。
- `⟳ REROLL`（現コスト＋次コスト表示）。
- 下部に Fortify 帯。右下に `DEPLOY` ボタン。
- 既存オーバーレイ構図（eyebrow→title→本体→主アクション）と `game/style.css` の語彙に従う。

## 6. カードプール（v1）

データ駆動。プール = **解放済みパークカード** ＋ **所持かつ未上限の各武器の `Mk N` 強化カード**。

### 6.1 パークカード（既存 `UPGRADES` を starter/unlock に分割）
- **starter（最初からプール）**：Field Medic / Hollow Points / Adrenaline（回復・火力・機動の最小セット）。
- **SALVAGE 解放（解放でプール入り）**：Quick Hands / First Aid Cache / Bandolier / Scavenger。
- 実装：各 `Upgrade` に `starter: boolean`（または別配列 `STARTER_PERKS` / `UNLOCKABLE_CARDS`）を持たせ、プール構築時に `meta.unlocked` を参照してフィルタ。
- **トレードオフと安全性（ラバーダック観点5への回答）**：補給系（Bandolier/Scavenger）を初期ロックするが、**弾薬の床は perk でなく毎ショップの `resupply()`＋kill ドロップで担保**されるため（§3.5.3）、lean start は「弱い」ではあっても「弾切れ＝死」は招かない。負スパイラルは §3.5.3 の3点で抑える。これはローグライト的に正しい方向（リーンに始めて幅を稼ぐ）。**実装後プレイテストで初期ランの体感を確認し、痩せ過ぎなら補給系1枚を starter に繰り上げる**（即対応できるようデータ分割で持つ）。

### 6.2 武器強化カード
- 所持（STARTER_WEAPONS ＋ SALVAGE 解放武器）かつ `wlevel < maxLevel` の各武器に `WEAPON ▸ Mk(N)` カード。`storeItems` の武器強化ロジックを流用。武器を SALVAGE 解放すると、開始装備に加わると同時にその強化カードがプールに入る。

### 6.3 価格（追加ピック用）
- パーク＝`CONFIG.arsenal.perkCost`。
- 武器強化＝`levelCost(lvl)`。
- 無料ピックは価格を無視。

## 7. メタ層（アンロックツリー型・専用画面）

SALVAGE は恒久ステータス強化を**買わない**（恐怖＝脆弱性を毎ラン削らないため）。買うのは「ドラフトの引きの幅」と「開始装備」。

### 7.1 配置（採用：専用 ARSENAL 画面）
- **トップ画面は最小限**：ブランド＋ SALVAGE 残高チップ＋ `[◆ ARSENAL ▸]` と `[ENTER THE QUARANTINE]` の2ボタンのみ。
- `ARSENAL` を押すと**専用オーバーレイ**（全画面・スクロール・グループ分け）を開く。無限に増える解放ノードをトップから切り出し、「ごちゃつく／1画面に収まらない」を構造的に回避（Hades の鏡 / Dead Cells の設計図と同じ定石）。
- 現状 `#start` インラインの arsenal を、独立オーバーレイ `#arsenal`（仮）へ移す。

### 7.2 ツリーの中身（2グループ・スクロール）
- **WEAPONS**：rifle 120 / lmg 200 / magnum 280（既存価格）。解放＝開始装備に加わる＋強化カードがプール入り。
- **CARDS**：Quick Hands / First Aid Cache / Bandolier / Scavenger を SALVAGE 解放（各 ~60–100 ◆・**データで調整**）。解放＝夜のドラフトに出る。
- 今後の振る舞い系カードは CARDS グループにノードを足すだけ ＝ **事実上無限の sink**。
- ノード状態表示：解放済 / 購入可 / 資金不足 / STARTER。

### 7.3 永続化（`meta.ts`）
- `Meta.unlocked` をカードにも拡張（既存 `buyUnlock` は id 非依存に汎用なので流用可。武器とカードを id 名前空間で区別 例：`card:bandolier`）。weapon/card の両方を1つの `unlocked` マップで扱う。
- **名前空間衝突の手当て（ラバーダック観点7・見落とし反映）**：`state.ts` は `meta.unlocked` の全 id を `owned` 武器扱いで投入している（`for (id of unlocked) owned[id]=true` 相当）。`card:` 接頭辞を導入すると**カード解放が偽武器として `owned` を汚染**する。`state.ts` 側で **`card:` 接頭辞の id を `owned` 投入から除外**する（武器 id だけを owned に入れる）。カードの解放判定は `meta.unlocked["card:xxx"]` を `draftPool` のフィルタで読む。

## 8. ネット同期（co-op）

> **改訂（ラバーダックレビュー反映）**：当初は offer を host→client の reliable `HostEvent` で配る設計だったが、これは**現行のショップ同期パターンと非同型**で誤りだった。現状、`inShop` は **snapshot に載り**、クライアントはショップを reliable イベントではなく snapshot から開く（`game.ts:1233` syncShopUI「Clients open it straight from the snapshot」）。ショップ内容（`storeItems`）も reliable では送られず、クライアントが**毎フレーム自前で再構築**する — 成立するのは入力（`owned`/`wlevel`/`money`/`deployQueue`/`deployableCount`）が全て snapshot/Hello 同期済みだから。reliable には再送機構が無く、`client.ts` の reconnect は `resetNet()` で全破棄→snap 待ち。CONFIG が明示的に想定する「ショップ中＝host pause 中の再接続（`graceMs:20000`、pause 中もブロードキャスト継続）」で reliable offer は復元されず**クライアントのショップが固まる**。よって offer は snapshot に載せる（＝既存メカニズムの拡張＝CLAUDE.md 原則に忠実）。

ドラフトはプレイヤー個人ごと・ホスト権威・RNG はホストのみ（クライアントは再シミュしないので seeding 不要、既存方針と一致）。

- **per-player offer を `Player` に持たせ snapshot で配る**。`SnapPlayer` に `offerIds: int[]`（カードの安定インデックス、`ENEMY_ORDER`/`PICKUP_ORDER` と同じ int 化方式）＋ `freePickUsed: bool` ＋ `rerollsTonight: int` を追加。これは既存規約「per-player gear lives on Player and is synced in snapshots」に完全準拠。これで再接続・取りこぼし・spectate・新規 join が**既存の仕組みでタダで解決**（最新 snapshot が常に真）。
- **`syncShopUI` はモード非依存のまま**：host/client/single すべて `state.players[localId].offer` を読んでローカル再構築（二股化しない）。
- **新 `CoopEvent`（client→host の intent のみ）**：`draftPick { cardId }`（無料ピック）／`draftBuy { cardId }`（SCRAP 追加ピック）／`draftReroll`。`deploy` は流用。host→client の新 `HostEvent` は**作らない**（offer は snapshot 経由）。
- ホストは要求ピアの pid から buyer を引き、`canBuy` 検証＋**「id が buyer の現 offer に含まれるか」ガード**を加えて1回だけ適用（既存 buy/deploy と同じ idempotent な扱い、`applyBuy` を流用＝観点6）。
- **offer 生成のトリガを明示**：`openShop()` で生存中の全プレイヤーに offer を生成。さらに**ショップ中に新規 join／再 spawn したプレイヤーにも生成**（`host.ts` の spawn 経路）。これで「ショップ中入室の offer 未割当」を塞ぐ。
- **抽選は `update()` ループの外**（`openShop`／buy／reroll ハンドラ内で同期 1 回）。sim の固定順序は不変。
- **`PROTOCOL_VERSION` を bump**（`net.ts`、現 11）し、snapshot の golden byte test を更新（「変えた」ことを意識させる既存の安全網）。

## 9. single-player 不変条件
- single-player の `update()` は従来通り。ドラフトの RNG はホスト/single でのみ走り、クライアント側 sim は存在しない。
- 「店→ドラフト」化はUI/フロー層の変更が主。sim の固定順序（`sysPlayer → sysAI → …`）は不変。
- 既存テスト（waveDef / arsenal scaling / ammo / flashlight 等）を壊さないこと。

## 10. データ／CONFIG／コード変更点

- `game/config.ts`：
  - `arsenal`：`offerSize: 3`, `freePicks: 1`, `rerollBase`, `rerollStep` を追加。
  - `siege.repairCost` → 0、`econ.repairReward` 廃止（§4.1 修理を SCRAP から外す）。
- `game/data/upgrades.ts`：各 perk に starter/unlock 区分（`starter` フラグ or `STARTER_PERKS`/`UNLOCKABLE_CARDS`）。
- `game/data/weapons.ts`：`UNLOCKABLE` は据え置き（メタ武器）。
- `game/meta.ts`：`unlocked` をカードへ拡張（`buyUnlock` は汎用なので流用）。`state.ts` で `card:` 接頭辞を `owned` 投入から除外（§7.3）。
- `game/data/arsenal.ts`：
  - 新 `draftPool(state, buyer): StoreItem[]`（解放カード＋所持武器強化を **`StoreItem` として** 返す。**`CardRef` は新設しない** — 既存 `{id,canBuy,buy}` 抽象を再利用し型の二重化を避ける＝ラバーダック観点6）。
  - 新 `rollOffer(pool, n, exclude?, rng = Math.random): StoreItem[]`（一様抽選・重複なし。**rng を末尾注入**してテスト決定性を確保＝観点7。`Math.random` 直呼びの既存慣習をこの1点だけ破る）。
  - 新 `rerollCost(rerolls): number`（純関数）。
  - `storeItems` は **Fortify（設置物）専用** に縮小（武器強化・パークはドラフトへ移行）。Fortify は空間配置・`deployQueue`・place 時 cap 再チェックという別責務なので分離は正当（special-case ではない）。
- `game/game.ts`：`openShop()` をドラフト初期化（全生存者へ offer 生成）に、`renderShop`/`buyItem` をドラフト操作（pick/buy/reroll）に置換。`applyBuy` を流用し **offer 内 id ガード**を追加。`renderArsenal` を専用 `#arsenal` オーバーレイ向けに拡張（WEAPONS＋CARDS）。`renderList` のキー関数をカード行・行削除（無料ピック消費）に対応させる（既存は desc 変化のみ想定なので要確認）。
- `game/state.ts` / `game/types.ts`：`Player` に `offer`（offerIds・freePickUsed・rerollsTonight）を追加。
- `game/net/snapshot.ts`：`SnapPlayer` に offer フィールドを追加（int 化）。`PROTOCOL_VERSION` bump（`net.ts`）＋ golden byte test 更新。
- `game/net/events.ts`・`host.ts`・`client.ts`：§8 の `CoopEvent`（draftPick/draftBuy/draftReroll）追加と host 適用。ショップ中 spawn 時の offer 生成（`host.ts`）。
- `index.html` / `game/style.css`：`#shop` をドラフト＋Fortify 構成に、`#start` を最小化、`#arsenal` 専用オーバーレイ追加。

## 11. テスト（pure のみ・既存方針に従う）
- `draftPool`：解放状態・所持武器・上限到達でのフィルタリング（純関数・RNG なし）。
- `rerollCost`：回数に対する単調増加（純関数）。
- starter/unlock 分割：`meta.unlocked` を反映したプール構築。
- `rollOffer`：**固定 rng を注入**して重複なし・プール<n の縮退・件数を決定的に検証（§10 の `rng` 末尾注入。これがプロジェクト初の「RNG を含むテスト対象」なので注入が必須）。
- UI/ドラフトの feel（提示の気持ちよさ・価格感・リロール頻度）は**プレイテストで検証**（ユニットテスト対象外）。

## 12. 調整ノブ（プレイテストで詰める初期値）
- `offerSize=3`, `freePicks=1`。
- `rerollBase` / `rerollStep`（夜ごとリセット）。
- SCRAP 源泉の昼/夜配分。**昼に寄せる場合、co-op の cache 収入を人数スケールさせるか先に検証**（§4.1・kill 由来 bounty との乖離防止）。
- `siege.repairCost=0`（修理を SCRAP から外す）。床が緩すぎ／壁管理が無意味化するなら、修理を別の安価リソースに戻す余地は残す（ただし SCRAP には戻さない）。
- CARDS 解放価格（~60–100 ◆）。**最安ノードは数ランで届く価格に**（§3.5.3 早い達成感）。
- starter パークの初期配分（3枚）。**痩せ過ぎなら補給系1枚を繰り上げ**（§6.1）。

## 13. 段階リリース
1. **v1（本 spec）**：ドラフトの仕組み＋SCRAP 一本化＋アンロックツリー（既存パークの starter/unlock 分割・武器解放）＋専用 ARSENAL 画面＋co-op 同期。
2. **後続（データ追加）**：振る舞い系カード（貫通／吸血／爆発弾 等）を `data/` に足し、CARDS ノードを増やす。必要ならレアリティ／重み付き抽選を導入。
3. **別 spec**：base-building 深掘り（昼の資源採集・建築）。

## Playtest decisions (open)

- [ ] **Reroll hand-size semantics (DECISION, not just feel).** Current: reroll redraws
      `draftOffer.length` (the unclaimed hand), so take-then-reroll shrinks 3→2 and can shrink
      further on repeat. Decide between (a) keep current — reroll re-rolls only the unclaimed hand,
      order-dependent by design; (b) redraw a full `CONFIG.arsenal.offerSize` hand every reroll —
      order-independent, one-line change in `applyDraftReroll` (see its docstring). Validate which
      reads better in a real draft session before sign-off.
