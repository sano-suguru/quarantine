# Co-op 多重参加の修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Co-op の「host + 3 クライアント = 4人」上限を権威ホスト側で確実に保証し、4人を超える多重参加・UI からの多重 join・registry の人数過少表示を塞ぐ。

**Architecture:** method-C（listen-server）。上限はシグナリングではなくホスト browser の `Host.decideFresh` 一点で締める（全 join 経路の合流点）。スロット割当は純粋関数 `pickSlot` に抽出。満員時はゴーストを守って新規を拒否し、拒否は rel イベント `roomfull` でクライアントに通知（close 主体はクライアント）。registry 人数は権威ホストが `meta` に載せて送る。

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess) / Vite / Vitest / Bun / Cloudflare Worker + Durable Object。

## Global Constraints

- **単一プレイ（single）への影響ゼロ**: 変更は net 経路のみ。`Net.mode === "single"` の挙動はバイト単位で不変に保つ。
- **データ駆動・特例コード禁止**: 既存の seam（events/net メッセージ union、`Host`/`Client` の責務分離）に乗せる。systems は net を import しない原則を維持。
- **feel-first**: reconnect ゴーストを満員時に立ち退かせる（evict）案は **採らない**（spec 決定事項1）。
- **wire 変更時は `PROTOCOL_VERSION` を bump**（`game/net/net.ts`）。本計画は `HostEvent` union に `roomfull` を足すので 10 → 11。
- **スロット定数**: クライアント枠は pid `1..3`（host は pid `0`）。最大同時 4 人。
- テストは Vitest、co-located `*.test.ts`、`import { describe, expect, it } from "vitest"`。

---

### Task 1: `pickSlot` 純粋関数の抽出 + 単体テスト

スロット割当ロジックを副作用のない純粋関数に切り出す。これが上限判定の単一の真実。

**Files:**
- Modify: `game/net/host.ts`（`allocPid` を置換する `pickSlot` を新設・export）
- Test: `game/net/host.test.ts`（**既存ファイルに追記** — 新規作成しない）

**Interfaces:**
- Produces:
  - `export const MAX_CLIENTS = 3`
  - `export type SlotDecision = { kind: "assign"; pid: number } | { kind: "full" }`
  - `export function pickSlot(decidedPids: Iterable<number>): SlotDecision`

> ⚠️ **既存テストを壊さないこと**: `game/net/host.test.ts` は既に存在し、`FakePeerLink` クラス + 実
> `getState()`/`resetState()` を使う7テスト（identity/spawn/grace/rejoin/membership-guard）が通っている。
> **新規作成・上書きは禁止**。`vi.mock` も使わない（ファイル単位でホイストされ、既存の実 `getState`
> import と衝突して全テストが壊れる）。新しいテストは末尾に `describe` を追記し、既存の `FakePeerLink`
> /`resetState`/`getState` パターンに乗せる。

- [ ] **Step 1: 失敗するテストを書く（既存ファイルに追記）**

`game/net/host.test.ts` の `./host` import 行（6行目 `import { Host } from "./host";`）に `pickSlot` を足す:

```ts
import { Host, pickSlot } from "./host";
```

ファイル末尾（最後の `describe` の後）に純粋関数テストを追記:

```ts
describe("pickSlot", () => {
  it("assigns the lowest free client slot starting at 1", () => {
    expect(pickSlot([])).toEqual({ kind: "assign", pid: 1 });
    expect(pickSlot([1])).toEqual({ kind: "assign", pid: 2 });
    expect(pickSlot([1, 2])).toEqual({ kind: "assign", pid: 3 });
  });

  it("fills the lowest gap, not the next-highest", () => {
    expect(pickSlot([1, 3])).toEqual({ kind: "assign", pid: 2 });
    expect(pickSlot([2, 3])).toEqual({ kind: "assign", pid: 1 });
  });

  it("is full when all three client slots are occupied (held/absent peers still count)", () => {
    expect(pickSlot([1, 2, 3])).toEqual({ kind: "full" });
  });

  it("ignores the host slot (0) and never returns it", () => {
    expect(pickSlot([0])).toEqual({ kind: "assign", pid: 1 });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `bunx vitest run game/net/host.test.ts`
Expected: FAIL — `pickSlot` is not exported（import エラー / 型エラーでファイル全体が落ちる）。既存7テストはこの時点では import 解決できずまとめて失敗するが、Step 4 で全て緑に戻る。

- [ ] **Step 3: `pickSlot` を実装**

`game/net/host.ts` の先頭付近（`makeNonce` の近く、`class Host` の前）に追加:

```ts
/** Max simultaneous clients (host is pid 0; clients claim pids 1..MAX_CLIENTS). */
export const MAX_CLIENTS = 3;

export type SlotDecision = { kind: "assign"; pid: number } | { kind: "full" };

/**
 * Pure slot picker — the single source of truth for the room cap. Returns the lowest free client
 * slot (1..MAX_CLIENTS), or `full` when every slot is taken. A slot counts as occupied by ANY
 * decided peer, whether currently `open` or held `absent` for reconnect — a held body's slot is
 * reserved for its owner (we do NOT evict it; see the design doc, feel-first).
 */
export function pickSlot(decidedPids: Iterable<number>): SlotDecision {
  const used = new Set(decidedPids);
  for (let n = 1; n <= MAX_CLIENTS; n++) if (!used.has(n)) return { kind: "assign", pid: n };
  return { kind: "full" };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bunx vitest run game/net/host.test.ts`
Expected: PASS（既存7 + pickSlot 4 = 11 tests）。

- [ ] **Step 5: コミット**

```bash
git add game/net/host.ts game/net/host.test.ts
git commit -m "feat(net): extract pure pickSlot room-cap helper"
```

---

### Task 2: `roomfull` HostEvent の追加 + PROTOCOL_VERSION bump

満員拒否の通知メッセージを wire union に追加する。

**Files:**
- Modify: `game/net/events.ts:24-30`（`HostEvent` union）
- Modify: `game/net/net.ts:19`（`PROTOCOL_VERSION`）

**Interfaces:**
- Produces: `HostEvent` に `| { t: "roomfull" }` が含まれる。`PROTOCOL_VERSION === 11`。

- [ ] **Step 1: `HostEvent` に `roomfull` を追加**

`game/net/events.ts` の `HostEvent` を以下に変更:

```ts
/** Host → client notifications. */
export type HostEvent =
  | {
      t: "gameover";
      salvage: number; // this player's banked share
      day: number;
      kills: number;
      money: number;
    }
  // Room is at capacity (host + 3). The host sends this instead of assigning a slot; the client
  // tears its own link down on receipt (host doesn't close immediately — see host.ts reject()).
  | { t: "roomfull" };
```

- [ ] **Step 2: PROTOCOL_VERSION を bump**

`game/net/net.ts:19` を変更:

```ts
export const PROTOCOL_VERSION = 11;
```

- [ ] **Step 3: 型チェックと既存テストが通ることを確認**

Run: `bun run typecheck`
Expected: PASS（`net.ts` の `NetMsg` は `HostEvent` を含むので新 variant が自動で乗る）。

Run: `bunx vitest run game/net/`
Expected: PASS。`registry.test.ts` は `PROTOCOL_VERSION` を相対参照（`+1`）なので影響なし。`snapshot.test.ts` の golden はバイト列を検証するだけで、rel メッセージ union 追加では発火しない。

- [ ] **Step 4: コミット**

```bash
git add game/net/events.ts game/net/net.ts
git commit -m "feat(net): add roomfull HostEvent, bump PROTOCOL_VERSION to 11"
```

---

### Task 3: `decideFresh` に `pickSlot` と拒否パスを配線 + Host 統合テスト

ホスト側の上限を実コードに反映。満員なら `roomfull` を送り、spawn しない。

**Files:**
- Modify: `game/net/host.ts`（`decideFresh` 改修、`allocPid` 削除、`reject` 追加）
- Test: `game/net/host.test.ts`（統合テストを追記）

**Interfaces:**
- Consumes: `pickSlot`/`MAX_CLIENTS`（Task 1）、`roomfull` HostEvent（Task 2）。
- Produces: `Host.add`/`start`/`connectedPids` の挙動（4人目を拒否、`start()` は decided 分のみ spawn）。

- [ ] **Step 1: 失敗する統合テストを書く（既存 `FakePeerLink`/`resetState` パターンで追記）**

`vi.mock`・fake timer は使わない。既存の `FakePeerLink`（`sent`/`fireOpen`/`fireClose`/`recv`/`hello`）と
実 `getState()`、`beforeEach(() => resetState())`（host を player 0 として置き、`running=true`）に乗せる。
`resetState` は `s.running` を立てるだけで host の `started` フラグは別物（`host.start()` で立つ）なので、
`host.start()` を呼ばなければ lobby 経路（open 即 decideFresh）になる。

`game/net/host.test.ts` 末尾（`describe("pickSlot")` の後）に追記:

```ts
describe("Host room cap", () => {
  it("rejects a 4th client: sends roomfull, assigns no slot, spawns no body", () => {
    const s = getState();
    const host = new Host();
    const links = [new FakePeerLink(), new FakePeerLink(), new FakePeerLink(), new FakePeerLink()];
    for (const l of links) host.add(l);
    for (const l of links) l.fireOpen(); // lobby → decide a slot immediately on open
    host.start(); // Deploy

    expect(host.connectedPids().sort()).toEqual([1, 2, 3]);
    expect(s.players.map((p) => p.id).sort()).toEqual([0, 1, 2, 3]); // host(0) + 3 clients, no 4th
    for (const l of links.slice(0, 3)) {
      expect(l.hello()).toBeTruthy();
      expect(l.sent.some((m) => m.t === "roomfull")).toBe(false);
    }
    expect(links[3]?.hello()).toBeUndefined(); // 4th got no slot
    expect(links[3]?.sent.some((m) => m.t === "roomfull")).toBe(true);
  });

  it("a pre-game drop frees its slot for the next join (no held body before deploy)", () => {
    const host = new Host();
    const [a, b, c] = [new FakePeerLink(), new FakePeerLink(), new FakePeerLink()];
    for (const l of [a, b, c]) {
      host.add(l);
      l.fireOpen();
    }
    expect(host.connectedPids().sort()).toEqual([1, 2, 3]);

    a.fireClose(); // pre-game (host not started) → peer fully removed, slot 1 freed
    const d = new FakePeerLink();
    host.add(d);
    d.fireOpen();
    expect(d.hello()?.localId).toBe(1); // reuses the freed slot
    expect(d.sent.some((m) => m.t === "roomfull")).toBe(false);
  });

  it("a held (absent) ghost keeps its slot — a fresh join is refused, the ghost is NOT evicted", () => {
    const s = getState();
    const host = new Host();
    host.start();
    const links = [new FakePeerLink(), new FakePeerLink(), new FakePeerLink()];
    for (const l of links) {
      host.add(l);
      l.fireOpen();
      l.recv({ t: "join" });
    }
    expect(s.players.map((p) => p.id).sort()).toEqual([0, 1, 2, 3]);

    links[0]?.fireClose(); // pid 1 drops mid-game → body held absent, slot reserved within grace
    expect(s.players.find((p) => p.id === 1)?.absent).toBe(true);

    const fresh = new FakePeerLink();
    host.add(fresh);
    fresh.fireOpen();
    fresh.recv({ t: "join" }); // mid-game fresh join while the room is full of (live + ghost)
    expect(fresh.sent.some((m) => m.t === "roomfull")).toBe(true); // ghost protected (feel-first)
    expect(fresh.hello()).toBeUndefined();
  });
});
```

> 注: `rejoin` が枠を増やさない回帰は既存テスト「a rejoin within grace re-attaches the SAME body in place」
> （`toHaveLength(1)`）が既にカバーしているので重複追加しない。`reject()` の失敗フェイルセーフ
> `setTimeout(REJECT_CLOSE_MS)` は実タイマだがテスト後に発火しても、クロージャが捕捉した旧 `Host` の
> `peers`/`links` 配列のみ触り（`getState()` 共有状態には触れない）、`if (!this.peers.includes(peer))`
> ガードで idempotent。テスト間汚染なし。

- [ ] **Step 2: テストが失敗することを確認**

Run: `bunx vitest run game/net/host.test.ts`
Expected: FAIL — 現状の `decideFresh` は4人目に pid=4 を割り当て `roomfull` を送らないため、「rejects a 4th client」が落ちる（既存テストと pickSlot は緑のまま）。

- [ ] **Step 3: `decideFresh` を改修し `reject` を追加、`allocPid` を削除**

`game/net/host.ts` の `decideFresh` を差し替え:

```ts
  /** Assign a fresh slot + nonce, send Hello, and (if running) spawn the player. Rejects when the
   *  room is full. NOTE: must stay synchronous — pickSlot reads the live peer set and the result is
   *  applied before any other onOpen/onRel runs; an `await` here would let two joins claim one slot. */
  private decideFresh(peer: HostPeer): void {
    if (peer.decided || !this.peers.includes(peer)) return;
    if (peer.claimTimer) clearTimeout(peer.claimTimer);
    peer.claimTimer = null;
    const slot = pickSlot(this.peers.filter((p) => p.decided).map((p) => p.pid));
    if (slot.kind === "full") {
      this.reject(peer);
      return;
    }
    peer.pid = slot.pid;
    peer.nonce = makeNonce();
    peer.decided = true;
    this.sendHello(peer);
    if (this.started) this.spawnFresh(peer.pid);
  }

  /** Room is at capacity. Tell the client (it closes its own link on receipt — closing here first
   *  could drop the unsent rel from the DataChannel buffer). Keep the peer UNDECIDED so its gameplay
   *  rels are ignored, and fail-safe drop it shortly after in case an old client ignores roomfull. */
  private reject(peer: HostPeer): void {
    peer.link.sendRel({ t: "roomfull" } satisfies NetMsg);
    setTimeout(() => {
      if (!this.peers.includes(peer)) return; // client already closed → onClose untracked it
      this.peers = this.peers.filter((x) => x !== peer);
      const li = this.links.indexOf(peer.link);
      if (li >= 0) this.links.splice(li, 1);
      try {
        peer.link.close();
      } catch {
        /* already closing */
      }
    }, REJECT_CLOSE_MS);
  }
```

同ファイルの `allocPid` メソッド全体を削除:

```ts
  /** Lowest free player slot among decided peers (host is 0; clients 1..3). */
  private allocPid(): number {
    const used = new Set(this.peers.filter((p) => p.decided).map((p) => p.pid));
    for (let n = 1; n <= 3; n++) if (!used.has(n)) return n;
    return (Math.max(0, ...used) || 0) + 1; // shouldn't happen (room caps at 3 clients)
  }
```

`pickSlot` 宣言の近く（`MAX_CLIENTS` の下）にフェイルセーフ定数を追加:

```ts
/** After sending `roomfull`, give the client this long to close its own link before the host
 *  force-closes it (covers an old client that ignores the message). */
const REJECT_CLOSE_MS = 2000;
```

- [ ] **Step 4: テストが通ることを確認**

Run: `bunx vitest run game/net/host.test.ts`
Expected: PASS（既存7 + pickSlot 4 + room-cap 3 = 14 tests）。

- [ ] **Step 5: 型チェック**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 6: コミット**

```bash
git add game/net/host.ts game/net/host.test.ts
git commit -m "feat(net): enforce room cap authoritatively in Host.decideFresh"
```

---

### Task 4: クライアントの `roomfull` 受信処理

`Client` が `roomfull` を受けたら自分で link を破棄し、ロビーへ通知するフックを追加。

**Files:**
- Modify: `game/net/client.ts:79-86`（`hooks` 型に `onRoomFull`）, `client.ts:110-119`（`onRel` 分岐）

**Interfaces:**
- Consumes: `roomfull` HostEvent（Task 2）。
- Produces: `Client` constructor の `hooks.onRoomFull?: () => void`。

- [ ] **Step 1: `hooks` 型に `onRoomFull` を追加**

`game/net/client.ts` の constructor `hooks` 型（79-86 行）に1フィールド追加:

```ts
    private hooks: {
      /** persist our reconnect identity (localId + nonce from Hello) so rebind can replay it */
      onIdentity?: (pid: number, nonce: string) => void;
      /** token to claim on the next P2P open: rejoin (reconnect) vs a fresh join */
      rejoin?: { pid: number; nonce: string } | null;
      /** host runs an incompatible wire version (manual-SDP path; signaling gates the rest) */
      onVersionMismatch?: () => void;
      /** the room is full (host + 3): stop and surface a terminal "room is full" to the lobby */
      onRoomFull?: () => void;
    } = {},
```

- [ ] **Step 2: `onRel` に `roomfull` 分岐を追加**

`game/net/client.ts` の `onRel` 内、`gameover` 分岐の後（`pong` の前か後）に追加:

```ts
      } else if (msg.t === "roomfull") {
        // host turned us away (room at capacity). Stop net activity and tear down our own link
        // — the host deliberately did NOT close it (so this rel wasn't dropped from the buffer).
        this.live = false;
        this.hooks.onRoomFull?.();
        try {
          this.link.close();
        } catch {
          /* already closing */
        }
```

- [ ] **Step 3: 型チェック**

Run: `bun run typecheck`
Expected: PASS。

- [ ] **Step 4: コミット**

```bash
git add game/net/client.ts
git commit -m "feat(net): client handles roomfull (tears down link, fires onRoomFull)"
```

---

### Task 5: main.ts — join 再入ガード + `roomfull` 配線（room-code & 手動SDP）

UI からの多重 join を防ぎ、満員拒否を terminal 文言で表示する。

**Files:**
- Modify: `game/main.ts:644-704`（room-code `join()`）
- Modify: `game/main.ts:724-747`（手動SDP client 生成ブロック）

**Interfaces:**
- Consumes: `Client` の `onRoomFull` フック（Task 4）。`setClientLobby({k:"lost", msg})`（既存）。
- このタスクは UI/統合領域のため単体テスト対象外 → 型チェック + 手動プレイテストで検証。

- [ ] **Step 1: room-code `join()` にガードと `onRoomFull` を配線**

`game/main.ts` の `join` 関数（644 行〜）を以下に差し替え:

```ts
    const join = async (): Promise<void> => {
      const code = roomInput.value.trim().toUpperCase(); // idFromName is case-sensitive
      if (!code || roomGo.disabled) return; // re-entry guard: ignore double-click / Enter spam
      roomGo.disabled = true;
      let rejected = false; // roomfull set a terminal message → don't let onClose clobber it
      setClientLobby({ k: "joining" });
      try {
        const link = await joinRoom(code);
        Net.mode = "client";
        coopRoomCode = code; // arm the reconnect watchdog for this room
        Net.client = new Client(link, undefined, {
          // persist our reconnect identity each Hello so a drop can rejoin the same slot
          onIdentity: (pid, nonce) => {
            try {
              sessionStorage.setItem(`q_rejoin_${code}`, JSON.stringify({ pid, nonce }));
            } catch {
              /* sessionStorage unavailable — reconnect just falls back to a fresh slot */
            }
          },
          // host turned us away: room is full. Terminal (manual connect can't get in either), so
          // do NOT open the manual fallback — surface a clear message and re-enable Join so the
          // player can try a different code.
          onRoomFull: () => {
            rejected = true;
            clearTimeout(failTimer); // roomfull can arrive before/around open → don't let the
            // NAT-timeout later clobber this terminal message with a "failed"
            coopRoomCode = null; // don't try to reconnect to a room we were refused from
            setClientLobby({ k: "lost", msg: "room is full — the squad is already at capacity (4)." });
            roomGo.disabled = false;
          },
        });
        setClientLobby({ k: "linking" });
        // joinRoom resolves when our ANSWER is sent, NOT when the P2P link actually opens. A
        // blocked NAT/firewall (e.g. a corporate network) then fails silently. Confirm a real
        // open via link.onOpen, surface link.onClose, and time out otherwise — so the player
        // sees "couldn't connect" instead of sitting forever on a misleading "connected".
        let opened = false;
        failTimer = setTimeout(() => {
          if (opened) return;
          roomGo.disabled = false;
          setClientLobby({
            k: "failed",
            msg: failMsg(
              "couldn't connect (network/NAT). Try a personal network, or manual connect below.",
            ),
          });
        }, CONFIG.net.p2pOpenTimeoutMs);
        link.onOpen(() => {
          opened = true;
          clearTimeout(failTimer);
          setClientLobby({ k: "connected" });
        });
        link.onClose(() => {
          clearTimeout(failTimer);
          if (rejected) return; // roomfull already showed the terminal "room is full"
          roomGo.disabled = false;
          setClientLobby(
            opened
              ? { k: "lost", msg: "disconnected from host." }
              : {
                  k: "failed",
                  msg: failMsg("connection failed (network/NAT) — try manual connect below."),
                },
          );
        });
      } catch (err) {
        roomGo.disabled = false;
        setClientLobby({
          k: "failed",
          msg: `${err instanceof Error ? err.message : err} — try manual connect below`,
        });
      }
    };
```

- [ ] **Step 2: 手動SDP の client 生成にも `onRoomFull` を配線**

`game/main.ts` の手動SDP `go.onclick`（724 行〜）の `new Client(...)` を以下に差し替え:

```ts
          Net.client = new Client(link, undefined, {
            // manual SDP bypasses the signaling version gate → re-check on Hello
            onVersionMismatch: () => {
              setClientLobby({
                k: "lost",
                msg: "host is on a different version — update to play together",
              });
              link.close();
            },
            // host turned us away: room is full (the client closes its own link on this event)
            onRoomFull: () => {
              setClientLobby({
                k: "lost",
                msg: "room is full — the squad is already at capacity (4).",
              });
            },
          });
```

- [ ] **Step 3: 型チェック + lint**

Run: `bun run typecheck`
Expected: PASS。

Run: `bunx biome check game/main.ts`
Expected: 致命的エラーなし（フォーマット差分は次の commit hook が自動修正）。

- [ ] **Step 4: コミット**

```bash
git add game/main.ts
git commit -m "feat(coop-ui): guard double-join + surface roomfull as terminal message"
```

---

### Task 6: registry 人数を権威ホスト発の meta で正確化

公開ルーム一覧の人数を「確立済みピア込み」にする。`connectedPids().length`（decided 基準）を使う。

**Files:**
- Modify: `game/net/signaling.ts:48-54`（`HostRoom.setMeta` 型）, `signaling.ts:71`（`lastMeta` 型）
- Modify: `game/main.ts:269-273`（tick の setMeta）, `main.ts:591`（seed の setMeta）
- Modify: `worker/room.ts:170-176`（`Incoming` meta 型）, `room.ts:189-194`（フィールド）, `room.ts:261-267`（meta handler）, `room.ts:289-312`（`syncRegistry`）

**Interfaces:**
- Consumes: `Host.connectedPids()`（既存, decided な open ピアの pid 配列）。
- Produces: meta wire メッセージに `players: number`。DO は `this.metaPlayers` を保持。
- このタスクは worker/UI 統合領域 → 型チェック + 手動検証。

- [ ] **Step 1: `signaling.ts` の `setMeta` 型に `players` を追加**

`HostRoom` インターフェース（48-54 行）の `setMeta` シグネチャを:

```ts
  setMeta(meta: { public: boolean; phase: string; day: number; players: number }): void;
```

`hostRoom` 内の `lastMeta` 宣言（71 行付近）を:

```ts
  let lastMeta: { public: boolean; phase: string; day: number; players: number } | null = null;
```

（`setMeta` 実装本体は `{ t: "meta", ...meta }` を spread しているので変更不要。）

- [ ] **Step 2: `main.ts` の2箇所の setMeta に `players` を渡す**

tick の setMeta（269-273 行）を:

```ts
        coopHostHandle.setMeta({
          public: coopPublic,
          phase: hostStarted ? gs.phase : "lobby",
          day: gs.day,
          players: (Net.host?.connectedPids().length ?? 0) + 1, // host + decided clients
        });
```

seed の setMeta（591 行）を:

```ts
    hostHandle.setMeta({
      public: isPublic,
      phase: "lobby",
      day: 1,
      players: (Net.host?.connectedPids().length ?? 0) + 1,
    });
```

- [ ] **Step 3: `worker/room.ts` の meta 型・保持・利用を更新**

`Incoming` union の meta variant（170-176 行）を:

```ts
  | { t: "meta"; public: boolean; phase: string; day: number; players?: number };
```

`Room` クラスのフィールド（189-194 行付近、`metaDay` の隣）に追加:

```ts
  // authoritative player count from the host's meta (host + established clients). The DO can't
  // count established peers itself (clients close their signaling socket once P2P is up), so it
  // trusts the host. null until the first meta arrives → fall back to the socket count.
  private metaPlayers: number | null = null;
```

meta handler（261-267 行）に1行追加:

```ts
      } else if (m && m.t === "meta") {
        // host publishing/refreshing its public listing (also the registry liveness heartbeat)
        this.isPublic = !!m.public;
        this.metaPhase = typeof m.phase === "string" ? m.phase : "lobby";
        this.metaDay = typeof m.day === "number" ? m.day : 1;
        this.metaPlayers = typeof m.players === "number" ? m.players : null;
        void this.syncRegistry();
      }
```

`syncRegistry` の `players` 行（297 行付近）を:

```ts
          players: this.metaPlayers ?? 1 + this.clients.size, // host-reported (established peers); fallback to socket count
```

- [ ] **Step 4: 型チェック（root と worker 両方）**

Run: `bun run typecheck`
Expected: PASS。

Run: `cd worker && bunx tsc --noEmit && cd ..`
Expected: PASS（worker は独自 tsconfig）。

- [ ] **Step 5: コミット**

```bash
git add game/net/signaling.ts game/main.ts worker/room.ts
git commit -m "fix(net): registry player count from host meta (counts established peers)"
```

---

### Task 7: 全体検証

**Files:** なし（検証のみ）

- [ ] **Step 1: フルゲートを通す**

Run: `bun run typecheck && bun run test && bun run lint && bun run build`
Expected: すべて PASS。

- [ ] **Step 2: 手動プレイテスト（feel/統合領域 — CLAUDE.md feel-first）**

`bun run dev:coop` で signaling 付き起動し、以下を確認:

1. **多重参加が塞がれる**: 1ホスト + 3クライアントで満員。4人目のタブ/ブラウザでルームコード join → 「room is full」が出てゲームに入れない（lobby に留まる）。
2. **逐次 join でもれない**: クライアントを1人ずつ（前の人の P2P 確立を待ってから）join させても、4人目は拒否される（= signaling の clients.size すり抜けが塞がれている）。
3. **UI 多重 join 防止**: Join ボタン連打 / Enter 連打で2スロット占有が起きない。
4. **reconnect 正常系**: クライアントを一時切断 → 同タブで自動 rejoin → 同じ pid/装備で復帰（枠は増えない）。
5. **registry 正確化**: 公開ホストで満員にし、別ブラウザの Open Raids 一覧で当該ルームが `full` 表示になる（`1` 表示のままにならない）。
6. **単一プレイ不変**: `bun run dev` で単独プレイが従来通り（多重参加修正の副作用なし）。

- [ ] **Step 3: 結果を正直に報告**

手動テストの各項目の結果（pass/fail と観察した挙動）を記録。feel に関わるものは「コンパイルが通った」ではなく「実際に試した」結果を述べる。

---

## Self-Review 結果（spec 突合）

- **問題1（上限権威化）** → Task 1（pickSlot）+ Task 3（decideFresh 配線）。手動SDP・room-code 両経路が `host.add → onOpen → decideFresh` 合流点を通ることを Task 3 統合テストで担保。✅
- **問題2（registry 人数）** → Task 6。`connectedPids().length`（decided 基準, `connected` の open 基準ではない）を使用。✅
- **問題3（UI 多重 join）** → Task 5（再入ガード + roomGo.disabled）。✅
- **④（reconnect 一時2体）** → evict 不採用（spec 決定事項1）。grace 自己回復に委ねる旨を pickSlot のコメントに明記。「枠を増やさない」回帰は**既存**テスト（rejoin re-attach, `toHaveLength(1)`）がカバー。「満員ゴーストを evict せず拒否」は Task 3 の新 room-cap テストで担保。✅
- **テスト戦略の整合** → `game/net/host.test.ts` は**既存7テスト**（`FakePeerLink`+実`getState`/`resetState`）。新規作成・`vi.mock`・fake timer は使わず、既存パターンへ**追記**（ラバーダック指摘で修正）。✅
- **roomfull の close 主体をクライアントに** → Task 3 `reject`（host は close せずフェイルセーフのみ）+ Task 4（client が close）。✅
- **roomfull UI を `lost` terminal に** → Task 5。✅
- **手動SDP の roomfull 配線** → Task 5 Step 2。✅
- **PROTOCOL_VERSION bump** → Task 2。✅
- **pre-start 4人目 / start() 4体 spawn 防止** → Task 3 統合テスト2件で担保。✅
- **代替案A 不採用** → spec に記載済み（コード変更なし）。✅

型整合: `pickSlot`/`SlotDecision`/`MAX_CLIENTS`/`REJECT_CLOSE_MS`（host.ts）、`onRoomFull`（client.ts hooks）、`roomfull`（events.ts→net.ts NetMsg）、`players`（signaling setMeta → worker Incoming）が各タスク間で一致していることを確認済み。
