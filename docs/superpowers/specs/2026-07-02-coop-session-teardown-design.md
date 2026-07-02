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

## 採用設計（Approach A）

### レイヤ 1: トランスポート終了プリミティブ（純粋・単体テスト可）

**`Host.dispose()`** を追加:

- `this.links` の全 `PeerLink` を `close()` する（`try/catch` で二重クローズを吸収）。
- `this.peers = []`、`this.links.length = 0`、`started = false` にリセット。
- idempotent ガード（`disposed` フラグ）で多重呼び出しを安全に無害化。

**`Client.dispose()`** を追加:

- `this.link.close()` を呼ぶ（`try/catch`）。
- `this.live = false` にして以後の send/render/コールバックを止める。
- idempotent ガード。

いずれも fake `PeerLink` を注入して「dispose が全リンクを閉じる／二重呼びが安全」を
単体テストする（`host.test.ts` / `client.test.ts`、または新規 test）。

### レイヤ 2: 単一 teardown オーナー `endCoop()`

co-op セッションを畳む **唯一の経路**。以下を順に行う:

1. **早期 return**: `Net.mode === "single"` なら即 return（＝ idempotent。多重・防御的呼び出しに安全）。
2. `Net.host?.dispose()` / `Net.client?.dispose()`（レイヤ 1）。
3. シグナリング handle を閉じる（`hostHandle?.close()` → Room DO が public ルームを unlist）。
4. タイマー停止: `coopPollTimer`（OPEN RAIDS ポーリング）、reconnect の `reconnecting` 解除、
   reconnect overlay 非表示。
5. **全セッション変数を単一プレイのベースラインへ**:
   `Net.mode = "single"` / `Net.host = null` / `Net.client = null` /
   `hostStarted = false` / `coopRoomCode = null` / `coopPublic = false` /
   `coopHostHandle = null` / `hostHandle = null` / `pendingClientManualState = null` /
   `coopPollTimer = 0`。

`endCoop()` が上記散在変数へ到達できるよう、`wireCoop` closure 内の
`hostHandle` / `coopPollTimer` / `pendingClientManualState` を **module-scope へ引き上げて集約**する
（これが「状態が 2 か所に割れている」根本原因への対処）。

### レイヤ 3: 二重防御でバグ③を源から断つ

- **出口側（漏れを塞ぐ）**: `closeLobby` / `restartBtn` / reconnect give-up /
  quickMatch フォールバック（onRoomFull・timeout・onClose）を **すべて `endCoop()` に置換**。
  これで①②③と reconnect 系の後始末が一本化される。
- **入口側の不変条件（源から断つ）**: `startGame()`（または `startBtn`/`deploy` の直前）で
  必ず `endCoop()` を前置し、**「新しい run は常にクリーンな単一プレイ・ベースラインから始まる」**
  を保証する。どの出口が漏らしても単一プレイは絶対に汚染されない（③の源）。
  - 注: ホストの `deploy → startGame` は co-op を**畳んではいけない**。よって
    `endCoop()` 前置は「単一プレイ開始（`startBtn`）」経路にのみ適用し、
    co-op deploy 経路（host.start 後に startGame）には適用しない。分岐は呼び出し側で明示する。

### レイヤ 4: タブ閉じ / 離脱（④）

`window.addEventListener("pagehide", endCoop)` を登録（ベストエフォート）。
`pc.close()` は同期的に ICE を閉じるため、相手側は `connectionstatechange → fireClose`
（`transport.ts:141`）で速やかにピアを除去できる。`pagehide` は bfcache/モバイルで
`beforeunload` より確実なため採用（必要なら `beforeunload` も併記可）。

## データフロー（terminal な後始末経路）

```
[出口①〜④ + startBtn 前置]  ─────────►  endCoop()
                                          │  (Net.mode==="single" なら no-op)
                                          ├─► Net.host.dispose()   → 全 PeerLink.close()
                                          ├─► Net.client.dispose() → PeerLink.close(), live=false
                                          ├─► hostHandle.close()   → signaling WS close → DO unlist
                                          ├─► stop timers (poll / reconnect)
                                          └─► reset session vars → single-player baseline
                                                     │
相手ピア: PeerLink close → transport.fireClose ──────┘
   host: onClose(host.ts:150) → peer 除去 + broadcast list から splice
   host: onClose(signaling.ts:87) → onState → refreshSquad（チップ更新）
```

これにより①のチップ残存も②の「waiting のまま」も、正常な `link.close()` 経由で解消する
（既存の close ハンドラは正しく機能しており、欠けていたのは「閉じる呼び出し」そのものだった）。

## エラー処理 / 冪等性

- `endCoop()` は **必ず idempotent**（`Net.mode==="single"` 早期 return + 各 dispose の `disposed` ガード）。
  出口 → `pagehide` の二重発火、`startBtn` 前置との重複呼び出しに耐える。
- 各 `close()`/`dispose()` は `try/catch` で「既に閉じている」を無害化。
- `Host.dispose()` 中のリンク close が発火させる既存 onClose（absent マーク等）は
  teardown 中でも無害（`disposed` 後の再入は早期 return）。

## テスト方針（CLAUDE.md のスコープ準拠）

- **単体テスト（純粋部分）**:
  - `Host.dispose()`: fake link 配列を全て閉じる / 二重呼びが安全 / `peers`・`links` を空にする。
  - `Client.dispose()`: fake link を閉じる / `live=false` / 二重呼びが安全。
  - （任意）ベースライン reset の純粋ヘルパを切り出せるなら、その出力を検証。
- **手動 2 タブ playtest（net 配線）**: リポジトリ方針どおり net の配線はプレイテスト検証。
  検証シナリオ:
  1. ①: クライアントで join → Back → ホストのスカッドから即座に消える。
  2. ②: ホストでクライアント接続後に Back → クライアントが速やかに切断表示になる。
  3. ③: co-op（client / host 双方）でゲームオーバー → Restart → タイトル → 「start」で
     新規シングルが**正常に動作**（client 残留で停止しない / host 残留で broadcast しない）。
  4. ④: 一方のタブを閉じる → 他方でピアが速やかに消える。
  5. **回帰**: 単一プレイが従来どおり（byte-for-byte）動作。co-op deploy が正常。

## 変更対象ファイル（見込み）

- `game/net/host.ts` — `Host.dispose()` 追加。
- `game/net/client.ts` — `Client.dispose()` 追加。
- `game/main.ts` — `hostHandle`/`coopPollTimer`/`pendingClientManualState` を module-scope へ集約、
  `endCoop()` 追加、`closeLobby`/`restartBtn`/reconnect give-up/quickMatch フォールバックを
  `endCoop()` へ置換、`startBtn` 前置、`pagehide` 登録。
- `game/game.ts` — （必要なら）`startGame` からの単一プレイ開始経路で `endCoop()` を呼べるよう配線。
  ただし co-op deploy 経路を畳まないよう分岐は main.ts 側で管理する。
- テスト: `game/net/host.test.ts` / `game/net/client.test.ts`（無ければ新規）に dispose のテストを追加。

## 非対象 / YAGNI

- Approach B（`CoopSession` クラス化）は今回は実装しない（記録のみ）。
- host migration・mid-run salvage 保全などの method-C 既知の制約は本設計の対象外。
- `worker/` 側（`/rooms` の Worker ハング根本修正）は別スコープ（本件はクライアント終了処理）。
