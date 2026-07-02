# Co-op セッション終了（teardown）の統一設計

- **日付**: 2026-07-02
- **対象**: QUARANTINE co-op (method-C / listen-server) のセッション・ライフサイクル終了処理
- **ステータス**: 設計（実装前）

## 背景 / 問題

「join 後に Back で抜けても、ホスト側の表示に p2 が残ったまま」という不具合の調査から、
より広い **「co-op セッションの後始末が不完全・不統一」** というバグ群が判明した。

根本原因は **co-op セッションのライフサイクルに単一のオーナーが存在しない** こと。
セッション状態が 2 か所に割れて散在している:

- `game/net/net.ts` の `Net` シングルトン: `mode` / `host` / `client`
- `game/main.ts` の散在変数:
  - module-scope: `hostStarted` / `coopRoomCode` / `reconnecting` / `coopHostHandle` / `coopPublic`
  - `wireCoop` closure-scope: `hostHandle` / `coopPollTimer` / `pendingClientManualState`

「co-op から抜ける」出口が複数あり、それぞれが後始末を**手書きで部分的に**行っているため、
「P2P リンクを閉じ忘れる」「`Net.mode` をリセットし忘れる」といった漏れが発生している。

### 特定した不具合（4 件）

| # | 出口 | P2P リンクを閉じる? | Net モード/ハンドルをリセット? | 症状 |
|---|---|---|---|---|
| ① | ロビー Back（クライアント待機中）`closeLobby` | ❌ 閉じない | ✅ 部分的 | **報告済み**: ホスト側に p2 チップが残る |
| ② | ロビー Back（ホスト待機中）`closeLobby` | ❌ `hostHandle.close()` は WS のみ。接続済みクライアントの `PeerLink` は残る | ✅ | 既に P2P 接続したクライアントが「connected — waiting」のまま切れない（①の鏡像） |
| ③ | ゲームオーバー → Restart `restartBtn = toTitle` | ❌ 閉じない | ❌ 何もしない | **最も深刻**: 次のシングルプレイが壊れる/漏れる |
| ④ | タブ閉じ / 離脱 | ❌ `pagehide`/`beforeunload` ハンドラ無し | — | ICE consent タイムアウトまでゴースト残存（ホスト/クライアント両方） |

### 各出口の後始末の実態（コード根拠）

- **`closeLobby`** (`main.ts:568`): `hostHandle?.close()`（シグナリング WS のみ）+ `Net.client = null` 等。
  クライアントの `PeerLink`/`RTCPeerConnection` を閉じていない。ホストの接続済みピアリンクも閉じていない。
- **`toTitle`** (`game.ts:1406`): DOM の表示切替のみ。`Net` に一切触れない。
- **`startGame`** (`game.ts:1095`): `state = newState()` するが `Net.mode` をリセットしない。
- **フレームループ** (`main.ts:317` frame / `main.ts:267` worker tick): 分岐は **`Net.mode` のみ**に依存。

### ③がなぜ致命的か

`toTitle()` も `startGame()` も `Net.mode` を戻さないため、co-op を遊んで
ゲームオーバー → Restart → タイトル → 「start」で新規シングルを始めると:

- **client のまま終了** → フレームループが `else if (Net.mode === "client")` に入り
  **`update()` が走らず新規シングルが停止**。かつ死んだリンクへ入力送信。
- **host のまま終了** → worker tick が回り続け **broadcast 継続 + public ルーム再リスト**。

（なお reconnect watchdog は `st.running` ガードがあり debrief 中は誤発火しない = 安全。
①の直接原因は `Net.client = null` するがリンク未クローズ、で確定。）

### 既存プリミティブの欠如（根拠）

- `Host` に全ピアリンクを閉じる `dispose()`/`closeAll()` が**無い**（`grep` 済み。
  個別の `peer.link.close()`（reject/dropOld）はあるが一括終了は無い）。
- `HostRoom.close()` は `ws.close()` のみ（`signaling.ts:107`）。P2P リンクは残す。
- `Client` には `suspend()`（reconnect 用に `this.link.close()`）はあるが、
  セッション終了を意図した公開 API が無い。

## 検討した設計案

### Approach A（推奨・右サイズの根治）

散在した co-op セッション状態を **単一の module-scope ブロックに集約** し、
**唯一の `endCoop()` teardown** を導入する。加えて、欠けていたトランスポート終了
プリミティブ `Host.dispose()` / `Client.dispose()` を追加する。

- 長所: 根本原因（散在 ＆ 手書き後始末）を、限定的な変更範囲で解消。
  純粋プリミティブは単体テスト可能。
- 短所: main.ts のセッション変数を集約する編集が必要（ただし参照箇所の意味は不変）。

### Approach B（フル・カプセル化）

`game/net/session.ts` に `CoopSession` クラスを新設し、mode/host/client/roomCode/
public/hostStarted/hostHandle/reconnecting/pollTimer を完全に内包、`begin()`/`end()`
でライフサイクルを管理する。

- 長所: 最もクリーンなカプセル化。将来の co-op 拡張に強い。
- 短所: main.ts の全参照箇所（フレームループ・reconnect・host tick・lobby 配線）を
  `session.xxx` へ広範に書き換える必要があり、単発の不具合修正としては過剰・高リスク。
  単一プレイのバイト単位不変性（CLAUDE.md）を脅かしうる。

**→ Approach A を採用。** B は「将来さらにカプセル化するなら」という選択肢として記録に残す。

## 追加調査で判明した「隠れた出口」（rubber-duck レビュー反映）

初版の 4-leak 列挙は不完全だった。teardown が **同期的に閉じるだけ** では足りない。真の難所は
**「非同期の join/quickMatch/reconnect がteardown後に完了して `Net` を書き戻す」** ことと、
**「main.ts の生 `link.onClose`/timeout が無ガードで UI/セッションを触る」** こと。コード根拠:

- **join 保留中の書き戻し** (`main.ts:765-800`): `const link = await joinRoom(code)` の解決後、
  無条件に `Net.mode="client"` / `coopRoomCode=code` / `Net.client=new Client(link,…)` を設定する。
  待機中に Back（teardown）しても、解決時にこれが走り **リンクも閉じない**。
- **room-code P2P タイムアウト** (`main.ts:807-817`): `failTimer` は `setClientLobby({failed})` を出すだけで
  **リンクを閉じず `Net.mode`/`Net.client` もリセットしない** → 「失敗表示なのに Net は client のまま」。
- **生 `link.onClose`** (`main.ts:823-836`, quickMatch `1149-1161`, manual `696-716`/`948-969`):
  teardown が link を閉じるとこれらが副作用で発火し、`openHostLobby(true)` 実行や lobby UI 変更を起こす。
  これらは `Net.mode` を見ていないため `endCoop()` の早期 return では止まらない。
- **quickMatch フォールバックは terminal ではない** (`main.ts:1102-1104/1117-1124/1127-1143/1149-1161`):
  「client 失敗 → **public host になる**」という*遷移*であり、`endCoop()`（terminal）への単純置換は
  Quick Match の挙動を壊す。terminal teardown と「失敗した client 試行を捨ててホストへ移る」遷移を
  混同してはならない。
- **manual version mismatch** (`main.ts:912-926`): link は閉じるが `Net.mode`/`Net.client` を戻さない。
- **stale `createHostLink()` 完了** (`signaling.ts:80-94`, `main.ts:682-745`): teardown 後に
  `host.add(link)` が走り、破棄済み `Host` に死んだリンクを積みうる。

→ **結論**: 「散在変数を集約 + 同期 teardown」だけでは Approach A は根治にならない。
**セッション世代（epoch）によるキャンセル機構が必須**。これが「単一オーナー」を実効化する核心。

## 採用設計（Approach A + epoch）

### レイヤ 0: セッション世代トークン（epoch）— 根治の核心

module-scope に `let coopEpoch = 0` を持つ。`endCoop()` は先頭で `coopEpoch++`。

- **全非同期フロー**（`join` / `quickMatch` / `reconnectClient` / manual・signaling の `createHostLink`）は
  開始時に `const epoch = coopEpoch` を捕捉し、**各 `await`・タイマー・`link.onOpen/onClose` コールバックの
  先頭で `if (epoch !== coopEpoch) { 取得済み link があれば close(); return; }`** を実行する。
- **main.ts の生コールバック**（`link.onClose`・`failTimer`・onRoomFull 等）も同じ epoch ガードを通す。

これで「teardown 後に完了した非同期処理が `Net` を書き戻す／死んだ link を放置する」経路を全て封じる。
`Net.mode==="single"` 早期 return は *`endCoop()` 自身の* 冪等性のためのもので、
*外部コールバック* の抑止には epoch ガードが必要（両方要る）。

### レイヤ 1: トランスポート終了プリミティブ（純粋・単体テスト可）

**`Host.dispose()`** を追加:

- `private disposed = false` を持ち、`dispose()` 冒頭で `true` に。
- `this.peers` の全 `claimTimer` を `clearTimeout` してから、`this.links` の全 `PeerLink` を
  `close()`（`try/catch` で二重クローズ吸収）。
- `this.peers = []`、`this.links.length = 0`、`started = false`。
- **`add(link)` を改修**: `disposed` なら即 `link.close()` して return（stale な `createHostLink()`
  完了が破棄済み Host にリンクを積むのを防ぐ）。

**`Client.dispose()`** を追加:

- `this.link.close()`（`try/catch`）、`this.live = false`、idempotent ガード。

いずれも fake `PeerLink` を注入して単体テストする。

### レイヤ 2: 単一 teardown オーナー `endCoop()`（terminal 専用）

co-op セッションを **完全に畳む terminal な唯一の経路**。順序:

1. `coopEpoch++`（レイヤ 0。以後の stale 完了を全て無効化）。
2. **早期 return**: `Net.mode === "single"` かつ handle/timer が無ければ即 return（`endCoop()` 自身の冪等性）。
3. `Net.host?.dispose()` / `Net.client?.dispose()`（レイヤ 1）。
4. `hostHandle?.close()`（signaling WS → Room DO が public ルームを unlist）。
5. タイマー停止: `coopPollTimer`（OPEN RAIDS ポーリング）clear、`reconnecting=false`、reconnect overlay 非表示。
6. **全セッション変数を単一プレイのベースラインへ**:
   `Net.mode="single"` / `Net.host=null` / `Net.client=null` / `hostStarted=false` /
   `coopRoomCode=null` / `coopPublic=false` / `coopHostHandle=null` / `hostHandle=null` /
   `pendingClientManualState=null` / `coopPollTimer=0`。

`endCoop()` が散在変数へ到達できるよう、`wireCoop` closure 内の
`hostHandle` / `coopPollTimer` / `pendingClientManualState` を **module-scope へ引き上げて集約**する。

### レイヤ 2.5: 「試行を捨てる」遷移は terminal と分離

quickMatch の「client 失敗 → public host になる」は teardown ではない。混同を避けるため専用ヘルパを設ける:

- **`abandonClientAttempt(epoch)`**: epoch が現行なら、取得済み client link を close し、
  transient な client 状態（`Net.mode`/`Net.client`/`coopRoomCode`/失敗 timer）だけをリセット。
  lobby は畳まない。room-code P2P タイムアウト（`main.ts:807`）・manual version mismatch も本経路へ。
- **`beginPublicHostFromQuickMatch(epoch)`**: `abandonClientAttempt` 後、epoch 現行なら新規ホスト lobby を開始。
- quickMatch の各フォールバック（1102/1117/1127/1149）はこの 2 ヘルパへ置換（`endCoop()` ではない）。

これにより Quick Match の「見つからなければホストになる」挙動を壊さずに、stale/leak を封じる。

### レイヤ 3: 二重防御でバグ③を源から断つ

- **出口側（漏れを塞ぐ）**: terminal な出口＝`closeLobby` / reconnect give-up（`main.ts:99-135`）/
  `restartBtn` を `endCoop()` に統一。非-terminal な失敗遷移はレイヤ 2.5 のヘルパへ。
- **入口側の不変条件（源から断つ）**: `startGame()` を直接呼ばせず、main.ts に薄いラッパを設けて
  呼び出し側から `startGame()` 直呼びを無くす:
  - **`startSingleRun()`** → `endCoop(); startGame();`（`startBtn` はこれを呼ぶ）
  - **`startHostRun(host)`** → `assert(Net.mode==="host"); startGame(); host.start(); hostStarted=true;`
    （host deploy はこれを呼ぶ。co-op を**畳まない**）

  これで「どの入口が teardown し、どれがしないか」を呼び出し側に覚えさせず、不変条件を局所化する。
  `game.ts:startGame()` の挙動は byte-for-byte 不変のまま。

### レイヤ 4: タブ閉じ / 離脱（④）— ベストエフォート（正直な記述）

`window.addEventListener("pagehide", endCoop)` を登録。ただし **相手への通知は保証されない**:
`RTCPeerConnection.close()`（`transport.ts:197`）はローカルには同期的だが、タブ discard/モバイル遷移では
相手の `connectionstatechange→fireClose` 到達は不確実。よって:

- 通常の Back/restart/host-leave 経路では、close 前に **信頼チャネルで明示的な `leave`/`hostleft` を送る**
  ことを検討する（相手が即座にピアを落とせる。ICE consent タイムアウト待ちにならない）。
  ※ これは `NetMsg` 追加 = `PROTOCOL_VERSION` bump を伴うため、実装プラン側で採否を判断する。
- `pagehide` + `pc.close()` はあくまで**ゴースト時間の短縮**であり、最終的には transport close/ICE
  タイムアウトが保険、と位置づける。

## データフロー（terminal な後始末経路）

```
[terminal 出口（closeLobby / reconnect give-up / restartBtn）+ startSingleRun 前置]
        │
        ▼
   endCoop()  ── coopEpoch++ （stale な非同期完了を全無効化）
        │  （Net.mode==="single" かつ handle/timer 無なら no-op）
        ├─► Net.host.dispose()   → claimTimer clear → 全 PeerLink.close() → add() を封鎖
        ├─► Net.client.dispose() → PeerLink.close(), live=false
        ├─► hostHandle.close()   → signaling WS close → DO unlist
        ├─► stop timers (poll / reconnect)
        └─► reset session vars → single-player baseline
                   │
相手ピア: PeerLink close → transport.fireClose ──────┘
   host: onClose(host.ts:150) → peer 除去 + broadcast list から splice
   host: onClose(signaling.ts:87) → onState → refreshSquad（チップ更新）

[非-terminal 失敗遷移（quickMatch fallback / P2P timeout / version mismatch）]
        │
        ▼
   abandonClientAttempt(epoch) → beginPublicHostFromQuickMatch(epoch)  （epoch 現行時のみ）
```

①のチップ残存も②の「waiting のまま」も、正常な `link.close()` 経由で解消する。
③は「入口の startSingleRun 前置」で源から断つ。stale async は epoch ガードで封じる。

## エラー処理 / 冪等性 / 再入

- `endCoop()` は idempotent（`coopEpoch++` + 早期 return + 各 dispose の `disposed` ガード）。
  terminal 出口 → `pagehide` の二重発火、`startSingleRun` 前置との重複に耐える。
- **再入ハザード**: `Host.dispose()` のリンク close が既存 onClose（`host.ts:150` absent マーク /
  `signaling.ts:87` refreshSquad）を同期発火させる。`disposed=true` を **最初に立てる** ので
  再入した host 側 onClose は `this.peers` を触っても無害（直後に空へ）。teardown 中の refreshSquad は
  lobby が畳まれるため実害なし。
- 各 `close()`/`dispose()` は `try/catch` で「既に閉じている」を無害化。
- **stale コールバック**は `Net.mode` ではなく **epoch** で判定する（レイヤ 0）。

## テスト方針（CLAUDE.md のスコープ準拠 + orchestration を fake で単体化）

net の *feel* は playtest だが、**本バグ群は orchestration（タイマー/コールバック/stale async）に宿る**ので、
そこを fake で単体テスト可能にする（real WebRTC は不要）。fake: 制御可能な `onClose` を持つ `PeerLink`、
fake `HostRoom`、fake タイマー、fake `joinRoom`/`rejoinRoom`。

- **プリミティブ**:
  - `Host.dispose()`: 全 link close / 全 `claimTimer` clear / `peers`・`links` 空 / **`dispose` 後の `add()` が link を即 close** / 二重呼び安全。
  - `Client.dispose()`: link close / `live=false` / 二重呼び安全。
- **orchestration（epoch ガード）**— 高価値:
  1. `joinRoom()` 保留中に teardown → 解決しても `Net.mode` が client にならず、取得 link は close される。
  2. `endCoop()` が quickMatch link を close しても stale `openHostLobby(true)` が走らない。
  3. teardown 後に reconnect が `{status:"open"}` 完了 → 返った link を close し `rebind` を呼ばない。
  4. stale client mode のまま `startSingleRun()` → dispose 実行後 `Net.mode==="single"` で開始。
  5. room-code P2P タイムアウト → `abandonClientAttempt` 経由で link close + client 状態リセット。
- **手動 2 タブ playtest（最終確認）**: ①〜④の実機シナリオ + 単一プレイ byte-for-byte 回帰 + co-op deploy 正常。

## 変更対象ファイル（見込み）

- `game/net/host.ts` — `Host.dispose()` 追加、`add()` に disposed ガード、`claimTimer` 一括 clear。
- `game/net/client.ts` — `Client.dispose()` 追加。
- `game/net/net.ts`（+ `events.ts`）— `leave`/`hostleft` を採用する場合のみ `NetMsg` 追加 + `PROTOCOL_VERSION` bump。
- `game/main.ts` — `coopEpoch` 導入、散在変数（`hostHandle`/`coopPollTimer`/`pendingClientManualState`）を
  module-scope 集約、`endCoop()` / `abandonClientAttempt()` / `beginPublicHostFromQuickMatch()` /
  `startSingleRun()` / `startHostRun()` 追加、全非同期フローと生コールバックへ epoch ガード付与、
  terminal 出口を `endCoop()` へ・失敗遷移を専用ヘルパへ置換、`startBtn`/`deploy` をラッパ経由へ、
  `pagehide` 登録。
- `game/game.ts` — 変更なし（`startGame()` は byte-for-byte 不変。呼び出しは main.ts ラッパ経由に集約）。
- テスト: `game/net/host.test.ts` / `game/net/client.test.ts`（無ければ新規）+ orchestration の
  fake ベーステスト（`main.ts` から純粋部分を抽出できる範囲で）。

## 非対象 / YAGNI

- Approach B（`CoopSession` クラス化）は今回は実装しない（epoch + 集約で root ownership は実効化される）。
  将来さらに強いカプセル化が必要になった時の選択肢として記録に残す。
- host migration・mid-run salvage 保全などの method-C 既知の制約は本設計の対象外。
- `worker/` 側（`/rooms` の Worker ハング根本修正）は別スコープ（本件はクライアント終了処理）。
