# 設計：マウスホイールで武器切り替え

- 日付: 2026-07-01
- ステータス: 承認済み（実装前）

## 目的

マウスホイールで所持武器を巡回切り替えできるようにする。既存の数字キー（1/2/3）による切り替えを補完する、より素早い操作手段。

> 本仕様はラバーダック（外部レビュアー視点）の検証を反映済み。主な反映点: トラックパッド慣性による過剰ステップ対策（1サンプル1ステップ + クールダウン）、非ライブフレームでのホイール蓄積リセット、ナイフ（melee）巡回除外、`{ passive: false }` 明示、型注釈の実態合わせ、co-op 相対解決の予測ズレ許容の明記。

## 非目標 (YAGNI)

- ホイールでの武器以外の操作（ズーム等）は対象外。
- 武器切り替えアニメーションやクイックスワップ演出の追加は対象外（既存の `Audio.switchWeapon()` / 速度ランプをそのまま利用）。

## データフロー（プロトコル変更なし）

ホイールイベントを `Input` シングルトンに蓄積し、`localInput.ts`（唯一の DOM 境界）が既存の絶対値 `weaponSlot: number | null` に変換する。`sysPlayer` は数字キーと全く同じ経路で適用する。

`PlayerInput` / スナップショット / `sysPlayer` は変更不要。ホイールはクライアントローカルで解決され、ワイヤーを渡るのは解決済みの `weaponSlot`（int）のみ。したがって **co-op はそのまま動作**する（ホスト権威・クライアントは意図のみ送信、という規約を維持）。ホストのローカルプレイヤーも `sampleLocalInput` 経由で同一経路を通るため、ホスト/クライアントで解決ロジックは同一。

**co-op の相対解決に関する注意（許容する挙動）:** 数字キーは絶対スロット指定なので現在装備に依存しないが、ホイールは相対（現在装備を起点に前/次）で解決する。クライアントはローカルプレイヤーの装備を**予測値**で持つため、切り替え直後にスナップショットの reconcile が届く前に連続ホイールすると、起点となる `p.weapon` が一瞬ずれ、解決先スロットが 1 つずれ得る。ただし最終的にはホスト権威で `owned` 検証込みに確定し self-correcting なので、これは許容する（プレイテストの確認項目に含める）。

## 操作仕様

- **ホイール下（`deltaY > 0`）= 次の武器**（スロット番号を進める、ラップあり）。
- **ホイール上（`deltaY < 0`）= 前の武器**（スロット番号を戻す、ラップあり）。
- 巡回対象は **所持済み かつ 非 melee 武器のみ**（`state.owned[id] && !WEAPONS[id].melee`）。未所持スロット・melee 武器（ナイフ）はスキップ。ナイフは「絶望の最終手段」という設計意図（`weapons.ts` 参照）を守り、ホイールで不意に装備されないようにする。数字キーでは従来どおりナイフも選択可能。
- 端ではラップアラウンド（最後→最初、最初→最後）。
- 巡回可能武器（所持済み非 melee）が 1 つ以下なら何もしない。
- **1 ホイールバースト＝最大 1 ステップ（バーストデバウンス）**：切り替えは `Input.wheel` に溜まったノッチ合計の符号（`Math.sign`）で 1 ステップだけ進める。かつ、**同一の連続ホイール操作（バースト）中は 1 回しか切り替えない**。バーストの終了は「一定の無操作ギャップ（`CONFIG.input.wheelBurstGapMs`、初期値 120ms 目安、プレイテストで調整）以上ホイールイベントが来ないこと」で判定し、それを満たすと次のホイールで再び切り替え可能になる（re-arm）。
  - **なぜ固定クールダウンではダメか**: トラックパッドの慣性スクロールや高精細ホイールは 1 回の物理操作で `wheel` イベントを ~1 秒間多発させる。固定クールダウン（例 120ms）だと 1 秒の慣性で ~8 回切り替わり、指 1 本のスワイプで武器を一周してしまう。バーストデバウンスなら「1 ジェスチャ＝1 切り替え」に収まる。マウスのノッチをゆっくり刻めば（ギャップ > 閾値）1 ノッチ = 1 切り替え、速く回すと（ギャップ < 閾値）1 バースト = 1 切り替え。数字キーは従来どおり直接指定できるので、確実に狙った武器へ行きたい場合の逃げ道は残る（feel-first のトレードオフ）。
  - ※ ラバーダック検証前の旧案「溜まったノッチ数だけ複数ステップ」は撤回。慣性スクロール暴発のため。
- **数字キー優先**：同一フレームで数字キーによるスロット選択がある場合、ホイールは無視（`weaponSlot` が `null` の時のみホイール解決）。競合回避。ただし数字キーが優先されたフレームでも `Input.wheel` は 0 リセットして溜め込まない。
- ダウン中/観戦中はホイールを無視。`localInput` が早期 `emptyInput()` を返す全経路（`hp<=0`・設定オープン等）でも **`Input.wheel = 0` にリセット**して、非ライブ中に溜まったノッチが復帰 1 フレーム目で暴発しないようにする。
- **フェーズ遷移でのリセット**：sim が回らない shop/pause 中に `wheel` イベントが溜まり、復帰時に一気に消費される穴を塞ぐため、`openShop` / `startNight`（deploy）/ pause 開始などの遷移で `Input.wheel = 0` をクリアする。クールダウン + 1 ステップクランプにより最悪でも 1 回の誤切り替えに抑えられるが、遷移リセットで完全に防ぐ。

## 変更点

### 1. `game/input.ts`

- `wheel: 0`（number, ノッチ符号の蓄積）と `wheelLastMs: 0`（number, 最後の wheel イベント時刻 = `e.timeStamp`。`performance.now()` と同一基準の DOMHighResTimeStamp なので直接比較できる）を追加。
- canvas の `wheel` イベントを **`{ passive: false }` を明示指定**して登録し、ハンドラ内で `this.wheel += Math.sign(e.deltaY); this.wheelLastMs = e.timeStamp; e.preventDefault();`（`preventDefault` でページスクロール抑制）。canvas 要素へのバインドなので input/textarea 上のホイールはそもそも届かず、テキスト入力フォーカス時の誤作動は自然に回避される。
- 既存の `blur` ハンドラで keys/firing をクリアするのと同じ箇所で `this.wheel = 0` にリセット（`wheelLastMs` は時刻なのでリセット不要）。

### 2. 純粋ヘルパー（新規、ユニットテスト対象）

巡回可能武器を巡回してスロットインデックスを解決する純粋関数を切り出す。型は実コードの実態に合わせ **`string` ベース**（`WEAPON_ORDER: string[]`, `owned: Record<string, boolean>`。`WeaponId` という名前付き型は現状存在しないため導入しない＝YAGNI）。

```
cycleWeaponSlot(
  order: readonly string[],          // WEAPON_ORDER
  eligible: (id: string) => boolean, // 巡回対象判定: owned[id] && !WEAPONS[id].melee
  currentId: string,
  step: number,                      // 呼び出し側で ±1 にクランプ済み
): number | null
```

- `order` 内で `eligible(id)` を満たすインデックス列を作り、`currentId` の位置から `step`（±1）分だけラップ移動した先の**絶対**スロットインデックス（`order` 上の index）を返す。
- 巡回可能武器が 1 つ以下、または移動先が現在と同じ場合は `null`。
- **`currentId` が巡回可能列に含まれない場合**（例: 数字キーでナイフを装備中にホイールした、理論上の reconcile ズレ）: `-1` 扱いにせず、`step > 0` なら列の先頭、`step < 0` なら列の末尾から開始する（＝現在位置に最も近い巡回可能武器へ入る）。この契約を関数ドキュメントに明記。
- melee 除外を呼び出し側の `eligible` 述語で表現することで、ナイフ id をヘルパーにハードコードせずデータ駆動（`WeaponDef.melee`）を維持。既存の `upgradeableWeaponId`（`!w.melee`）と同じ流儀。

配置先は既存のテスト方針（純粋・決定的コードのみ）に沿い、`game/data/arsenal.ts` 近傍（`WEAPON_ORDER`・武器解決ロジックが集約されている場所）。`*.test.ts` を co-locate。

### 3. `game/net/localInput.ts`

- モジュールローカル状態 `wheelArmed = true`（`prevKeys` / `aimTargetId` と同じ流儀）を追加。
- 既存の数字キー解決の後、`weaponSlot` がまだ `null` の場合のみホイールを解決する。
- `const w = Input.wheel; Input.wheel = 0;`（**読み取り後、必ず 0 リセット**。数字キー優先で使わなかった場合も溜め込まない）。
- バースト終了判定で re-arm: `if (performance.now() - Input.wheelLastMs > CONFIG.input.wheelBurstGapMs) wheelArmed = true;`
- `if (wheelArmed && w !== 0)` のとき `cycleWeaponSlot(WEAPON_ORDER, (id) => !!state.owned[id] && isUpgradeableWeapon(id), p.weapon, Math.sign(w))` を呼び、結果が非 `null` なら `weaponSlot` に代入し `wheelArmed = false`（同一バースト中の再切り替えを止める）。
  - 巡回対象述語は既存の `isUpgradeableWeapon`（`weapons.ts`、`WEAPONS[id] != null && !w.melee`）を再利用。「所持済み かつ 銃器（非 melee）」を、melee 判定をハードコードせずデータ駆動で表す。`isUpgradeableWeapon` を `localInput` に import する。
- `emptyInput()` を返す早期 return 経路（`p.hp<=0` 等）に入る前に `Input.wheel = 0` をリセットして、非ライブ中の蓄積を捨てる（`wheelArmed` はそのままでよい — 次に切り替える時は re-arm 済み）。

### 4. フェーズ遷移でのリセット（`game/game.ts`）

- sim が停止する shop/pause 中に溜まった `wheel` を復帰時に暴発させないため、`openShop` / `shopDeploy`（deploy→night）/ pause 開始のフェーズ遷移で `Input.wheel = 0` をクリアする。
- 実装時、これらの遷移が `Input` を直接触るのが `game.ts` の既存の責務分離（systems は Input を読まない）に反しないか確認する。反する場合は、遷移フラグを見て `localInput` 側でリセットする形に寄せる。**1 ステップクランプ + クールダウンにより最悪でも 1 回の誤切り替えに抑えられている**ため、この遷移リセットは保険であり、配置は実装時に最もクリーンな方へ。

### 5. `game/config.ts`

- 新規トップレベルブロック `input: { wheelBurstGapMs: 120 }` を追加（既存の `feel` / `assist` と同列）。ホイールバーストの無操作ギャップ閾値（ms）。CLAUDE.md の「チューニングは CONFIG で」に従う。

## テスト

- `cycleWeaponSlot` のユニットテスト：
  - 通常の次/前移動（`step` = ±1）。
  - 端でのラップ（最後→最初、最初→最後）。
  - 未所持スロットのスキップ（`eligible` false）。
  - melee（ナイフ）のスキップ（`eligible` が `!melee` を含む前提の述語で検証）。
  - 巡回可能武器が 1 個以下 → `null`。
  - 移動先が現在と同じ → `null`。
  - `currentId` が巡回可能列に含まれない場合の契約（`step>0`→先頭、`step<0`→末尾）。
- **操作感（プレイテスト必須項目、feel-first。コンパイル/テスト通過だけでは done としない）:**
  - 戦闘中のスクロール切り替えが気持ちいいか、数字キーとの競合が無いか。
  - **トラックパッド/慣性スクロールで武器が一周しないか**（クランプ + クールダウンの効き）。クールダウン値（初期 ~120ms）を実機で調整。
  - shop/pause/ダウン復帰の 1 フレーム目で意図しない切り替えが起きないか。
  - co-op で切り替え直後に連続ホイールした時のスロットずれが気にならない範囲か。
