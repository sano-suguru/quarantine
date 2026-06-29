# Co-op 多重参加の修正設計

- **日付**: 2026-06-30
- **対象**: QUARANTINE co-op (method-C / listen-server) のルーム参加上限とプレイヤー人数管理
- **ステータス**: 設計（実装前）

## 背景 / 問題

調査の結果、co-op の「3クライアント上限（host + 3 = 4人）」が実効的に機能しておらず、
4人を超えた参加（多重参加）が起こり得ることが判明した。根本原因は3つ。

### 問題1: 上限が権威化されていない（本命）

唯一の上限判定は `worker/room.ts` の signaling 段にある:

```ts
if (this.clients.size >= 3) { this.send(ws, { t: "full" }); ws.close(); return; }
```

しかし `this.clients` は **シグナリング中の WebSocket だけ** を保持する。クライアントは P2P
(DataChannel) が開いた瞬間にシグナリングソケットを閉じる設計のため:

- `game/net/signaling.ts` `joinRoom`: `link.onOpen(() => ws.close())`
- `worker/room.ts` `attachClient` close handler: `this.clients.delete(peerId)`

→ **確立済みの P2P ピアは `clients.size` にカウントされない**。ハンドシェイクは数秒で終わるので、
順番に join していけば毎回スロットが空き、4人目・5人目…も `"full"` にならず通る
（同時に3人がハンドシェイク中のときだけ偶然弾かれる、というレースになっている）。

ホスト側 `game/net/host.ts` にも上限がない:
- `main.ts` の `(link) => host.add(link)` は無条件でピアを受け入れる
- `allocPid()` は 1..3 が埋まると `4, 5, ...` を返す（コメントは "shouldn't happen" だが実際に起こる）
- スナップショットは `u8(players.length)` なのでクラッシュはしないが、想定外人数でゲームが成立する

### 問題2: registry（公開ルーム一覧）の人数が過少表示

`worker/room.ts` `syncRegistry` は `players: 1 + this.clients.size`。確立済みピアを数えないため、
満員ルームでも一覧上は常に host のみ（=1人）に見え、`main.ts` の `r.players >= r.max`
（満員表示 / クイックマッチのスキップ）が機能せず、問題1の多重参加を助長する。

### 問題3: UI が多重 join を防いでいない

`main.ts` の `join()` は再入ガードが無く、`roomGo.onclick = () => void join()` を連打/ダブルクリック
すると複数の `joinRoom` が走り、一人が複数スロットを占有し得る。

### （副次）reconnect 中の一時2体

grace 期間中に rejoin トークンを失って fresh join すると新 pid を取得し、旧 body は grace 満了まで
absent として残る → 一人が一時的に「生 body + ゴースト」の2体になる。問題1の修正と相互作用するため
本設計に統合して扱う（後述）。

## 設計方針

**「上限はホスト（権威）で一点に集約する」。** method-C ではホスト browser が権威なので、
signaling 段の脆いカウントに頼らず、`host.add → link.onOpen → decideFresh` という全経路
（ルームコード経由・手動SDP経由）の唯一の合流点でスロットを締める。signaling 段の `"full"` は
安価な一次フィルタとして残す。

**重要な前提（手動SDP）**: 手動SDP経路は signaling DO を一切通らない。したがって DO 段のキャップは
原理的に唯一の砦になり得ず、`decideFresh` のホスト側キャップ＋`roomfull` 通知は手動SDPのために
**どのみち必須**。これが「DO 段で確立済みピアを正確カウントする代替案A」を採らない決定的理由
（後述・代替案の検討）。

## 変更詳細

### A. 上限の権威化（`game/net/host.ts`）

スロット割り当て判定を **純粋関数に抽出**し、「満員なら拒否（reconnect ゴースト保護）」ルールを実装する。

純粋関数のシグネチャ（例）:

```ts
// peers: { pid, decided }[] の最小スナップショット（呼び出し時点の占有状況）
type SlotDecision =
  | { kind: "assign"; pid: number }   // 空き枠の最小番号
  | { kind: "full" };                 // 3枠すべて decided が占有 → 新規は拒否
function pickSlot(peers): SlotDecision
```

ルール（pid 1..3 の3枠。`decided` ピアが占有とみなす。`open` でも `absent`（grace 中ゴースト）でも占有）:
1. 空き枠があれば最小番号を `assign`。
2. 3枠すべてが `decided` で占有なら `full`。

`decideFresh` はこの判定を使い:
- `assign` → 従来通り pid 割当・Hello・(running 中なら) spawn
- `full` → **拒否パス**（下記 B）

`tryRejoin` は従来通り（既存スロットへの再アタッチなので枠を増やさない）。

**同期性の契約（明記）**: `pickSlot` は呼び出し時点の `peers` だけを見る純粋関数であり、
`pickSlot → assign 反映` までが **同期・割り込み不可**であることに依存する（JS シングルスレッド前提）。
将来 `decideFresh` 内に `await` を挟むと2つの `pickSlot` が同じ空き枠を二重 assign し得る。
このため `decideFresh` には非同期処理を入れない旨をコメントで固定する。

#### ④（reconnect一時2体）の扱い — evict は採らない

「満員時に最古ゴーストを立ち退かせる（evict）」案は採らない。理由:
- reconnect 正常系は `rejoinRoom`＋トークン replay で `tryRejoin` 再アタッチ（枠を増やさない）。
  evict が要るのは「満員＋自分のゴーストにトークン無しで fresh join」という稀ケースのみ。
- evict は CLAUDE.md の **feel-first**（切断プレイヤーが復帰枠を奪われる）に反するリスクがあり、
  実プレイ検証なしに入れるべきでない。
- evict を捨てることで後始末の複雑さ・pre-start での `removePlayer` no-op 問題も消える。

→ ④の一時2体は **grace 満了（最大 `CONFIG.net.reconnect.graceMs`）で `tickGrace` が自己回復**させる。
能動的な即解消はしない。これは意図的な割り切り。

### B. クライアント側の早期拒否（`game/net/events.ts`, `client.ts`, `main.ts`）

拒否は P2P 確立後に起きる（signaling は既に閉じている）ため rel で通知するが、**close 主体を
クライアントに置く**（ホストが即 close すると `RTCDataChannel` の未送信バッファが破棄され `roomfull`
が届かないため）:
- `HostEvent` に `{ t: "roomfull" }` を追加。
- `Host.decideFresh` の `full` 時: 当該 link に `roomfull` を rel 送信。**ホストは close しない**
  （peer は未 decided のまま input 等は弾かれる）。フェイルセーフとして短いタイマ後にホスト側 close。
- `Client` が `roomfull` を受信したら自分で link を破棄し、ロビーへ terminal 通知。
- `main.ts`: ルームコード `join()` と **手動SDP の client 生成ブロックの両方**で `roomfull` を配線する
  （手動SDPは別ブロックで `onIdentity` も未設定なので、ここを忘れると満員が NAT エラー扱いになる）。
- UI 状態は `failed`（manual fallback を開く）ではなく **`lost` 相当の terminal 文言**
  （「room is full」）に倒す（満員は manual でも入れないため）。`joinRoom` は answer 送信時に
  resolve し `link.onOpen` で一瞬 `connected` 表示になるが、直後に `roomfull` で `lost` に遷移する。
- signaling 段の `"full"`（`joinRoom` reject / 同時ハンドシェイク時）と rel の `roomfull`
  （逐次 join がすり抜けた時）の **2系統**を client 両方でハンドルし、文言を一貫させる。

### C. registry 人数の正確化（`worker/room.ts`, `main.ts`, meta 型）

DO は確立済みピアを数えられないので、権威であるホストが人数を送る:
- ホスト→relay の `meta` メッセージ（既にティック毎送信）に `players: number` を追加。
  ホストは **`host.connectedPids().length + 1`** を載せる（host + decided な接続済みクライアント）。
  ※ `host.connected`（`open` 基準）は rel 待ちの未 decided も数えてずれるため **使わない**。
- DO は `metaPlayers` を保持し、`syncRegistry` でこれを使う。未受信時のみ従来 `1 + clients.size`
  にフォールバック。host close 時は registry を deregister 済みなので失効は問題にならない。
- **既知の制約**: registry はハートビート間隔（`CONFIG.net.registryMetaMs`）ぶん stale になり得る。
  その窓でクイックマッチした4人目は `decideFresh` の `roomfull` 防衛で弾かれる（破綻はしないが
  「一覧では空き→実際は満員で拒否」体験が稀に出る）。これは許容し spec に明記する。

### D. UI/UX での多重 join 防止（`main.ts`）

- `join()` に再入ガードを追加。`joining`/`linking`/`connected` 中は `roomGo` を `disabled` にし、
  `join()` 冒頭で in-flight なら return。`failed`/`lost` でのみ再有効化。
- `quickMatch` は既存の `coop-quick` disabled ガードを踏襲（追加対応不要）。
- 自分がホストのルームへ自分でクライアント参加する経路は `Net.mode` で分離済み（追加対応不要）。

## 代替案の検討

### 代替案A: ホストが accept を DO に通知して signaling 段で正確カウント — **採らない**

`link.onOpen` でホストが signaling WS に `{t:"accepted", peerId}` を送り、DO が `establishedCount` を
持てば、4人目を P2P 確立前に弾け、registry 人数も meta なしで正確化できる。だが:
- **手動SDP経路は DO を通らない** → DO 段キャップは唯一の砦になり得ず、ホスト側 `decideFresh`
  キャップ＋`roomfull` は結局必須。代替Aを足しても `roomfull` は消せない。
- DO に二重カウント状態（増減の整合・ドリフトリスク）を増やすだけで、得られるのは「ルームコード
  経路の4人目を P2P 前に弾ける／一瞬の connected 点灯を防ぐ」UX 改善のみ。
- meta.players（数行）の方が小さく、必要な registry 正確化を満たす。

→ 本設計はホスト権威キャップ＋`roomfull`＋meta.players で統一する。

## テスト

- `game/net/host.test.ts`（新規）:
  - **`pickSlot` 純粋テスト**: 空き枠あり→最小番号 assign / 3枠 decided 占有→full /
    absent 混在でも decided なら占有として full / 1〜2枠のみ占有→残りを assign。
  - **Host 統合テスト（PeerLink・getState をモック注入し決定論化）**:
    - 4人目の `add → onOpen → decideFresh` が `full` 判定で `roomfull` を送り、その peer を
      未 decided のまま spawn しないこと。
    - **pre-start(lobby)** で4人目を decided にせず、`start()` が4体 spawn しないこと。
    - `tryRejoin` がスロットを増やさず再アタッチすること（既存 `dropOld` 後始末の回帰防止）。
  - CLAUDE.md「純粋・決定論的のみ単体テスト」はモック注入で両立。
- registry 人数 / signaling / UI ガード / reconnect feel は統合・feel 領域 → **手動プレイテスト**で検証。

## 影響範囲

- **単一プレイ（single）への影響ゼロ**: 変更はすべて net 経路のみ。
- 変更ファイル: `game/net/host.ts`, `game/net/host.test.ts`(新規), `game/net/events.ts`,
  `game/net/client.ts`, `game/net/signaling.ts`(meta 型), `worker/room.ts`, `game/main.ts`。

## 決定事項（確定済み）

1. ④の reconnect ゴースト: **evict しない**（満員なら新規拒否しゴースト保護。一時2体は grace で自己回復）。
2. signaling 段の代替案A: **含めない**（手動SDPのため `roomfull` 必須・meta.players が小さい）。
3. `roomfull` 拒否時の UI: **`lost` 相当の terminal 文言**（manual fallback は開かない）。
