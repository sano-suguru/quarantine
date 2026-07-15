# 2b③ cleanup — PR2 (A stale コメント + C dead export + D 改名 + E test 回収) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** post-2b② arena の現実にコメント・命名・export・テストを一致させる（挙動ゼロ変更・wire 変更なし）。

**Architecture:** 4 タスク。**T1** stale コメント一掃（host→DO/server 語彙・single-player/method-C/WebRTC/manual-SDP/signaling/P2P 撤去）。**T2** dead export 削除 + un-export。**T3** `signal`→`worker` 改名。**T4** ledger deferred test/doc minors 回収（verify-then-add-missing）。相互に独立、順序任意。

**Tech Stack:** TypeScript / Bun / Vitest / Biome (`--error-on-warnings`).

**前提:** ブランチは **PR1 マージ後の main** から切る（`feat/do-2b3-cleanup-pr2`）。PR1 が既に消す行（`game.ts:1302/1638/1641`, `main.ts:439` の pause コメント）は本 PR の対象外。

## Global Constraints

- 挙動ゼロ変更・wire 変更なし（PROTOCOL は PR1 の 21 のまま触らない）。
- ⚠ false-stale を書き換えない: `game/net/signaling.ts:7-8` の `const host = …` は WS ホスト名の**変数**であってコメント語彙ではない — 触らない。
- ⚠ 意図的 reserve のコメントは残す: snapshot fxEvents / bit0 "was lightOn" / bit1 "was paused" reserve。
- 全体ゲート: `bun run typecheck` ・ `cd worker && bunx tsc --noEmit` ・ `bun run lint` ・ `bun run test` ・ `bun run build`。

---

### Task 1: stale コメント一掃 (A)

**Files:** `game/game.ts`・`game/main.ts`・`game/net/{net,client,events,link}.ts`・`game/systems/{stalkerFx,stalkerPhantom}.ts`・`game/input.ts`・`game/ui.ts`。

**Interfaces:** コメントのみ。コードは 1 バイトも変えない（型・関数・挙動は不変）。

**書き換えルール（vocab 置換）:**
- `host`（＝権威の意味）→ `DO` / `the server` / `authority`。`host-authoritative` → `DO-authoritative`。`host & client` → `the DO & clients`。`host-only` → `server-only`。
- `single-player stays byte-for-byte` / `single-player safe` / `single/host/client` → 削除ないし `client/DO で一貫` へ（single-player モードはもう無い）。
- `method-C` / `WebRTC` / `P2P` / `manual-SDP` / `signaling`（レイヤとしての）→ 撤去し現実（single-WS + DO、version gate は hello.v の client-side self-eject のみ）へ。
- 記述が今も正しいコメントは触らない（判定基準 = 対象コードの現在の挙動を正確に述べているか）。

- [ ] **Step 1: 最優先 stale（挙動を誤記述）を正す — `game/net/net.ts:9-12`**

現状:
```ts
 * Co-op wire-protocol version. Host and client MUST match or they desync silently (the snapshot
 * binary layout + NetMsg/CoopEvent shapes are not self-describing). Sent on the signaling URL
 * (`&v=`) so a mismatch is rejected BEFORE P2P, and echoed in Hello so the manual-SDP path (which
 * bypasses signaling) re-checks after open.
```
→
```ts
 * Wire-protocol version. The DO and every client MUST match or they desync silently (the snapshot
 * binary layout + NetMsg/CoopEvent shapes are not self-describing). The DO echoes its version in
 * the Hello; the client re-checks it after the arena WS opens and self-ejects on a mismatch
 * (see client.ts onVersionMismatch). There is no separate signaling/handshake layer.
```

- [ ] **Step 2: `game/net/net.ts:32` と `:40` の signaling/host 語彙を正す**

`:32`:
```ts
       *  wire-version mismatch (defence-in-depth alongside the signaling version gate). */
```
→
```ts
       *  wire-version mismatch after the arena WS opens. */
```
`:40`:
```ts
  | { t: "ping"; id: number } // client→host RTT probe (rel channel); host echoes pong
```
→
```ts
  | { t: "ping"; id: number } // client→DO RTT probe (rel channel); the DO echoes pong
```

- [ ] **Step 3: `game/net/link.ts:1` の "(removed) WebRTC" を正す**

```ts
/** Minimal contract shared by the Arena WebSocket adapter and (removed) WebRTC PeerLink. */
```
→
```ts
/** Minimal contract the Arena WebSocket adapter implements (the client talks to the DO through it). */
```

- [ ] **Step 4: `game/net/client.ts` の signaling/host 語彙を一掃**

対象行（vocab ルール適用）: `:33`(ships it to the host→to the DO)・`:35`(host presses Deploy→the DO deploys / the first snapshot)・`:39`(host's authoritative→the DO's authoritative)・`:58`・`:68`(host-authoritative→DO-authoritative)・`:97`(`signaling gates the rest`→削除ないし `the DO runs an incompatible wire version — the client self-ejects`)・`:118`(`wire-version gate (signaling gates room-code / quick-match)`→`wire-version gate (client-side, after the arena WS opens)`)・`:167`(host has deployed→the world is live)・`:303`(host-only→server-only)・`:335/:338`(the host fires→the DO fires; matching the host→matching the DO)・`:411/:415/:422/:477/:513/:522/:555/:573/:588/:605`(host→DO/the server, host-authoritative→DO-authoritative)。各行の意味は保持したまま語彙のみ差し替え。

- [ ] **Step 5: `game/game.ts` の host/single-player 語彙を一掃**

対象行: `:39`(single-player boot state→client boot state)・`:101`(single-player stays→client stays)・`:122`(single-player safe→client-safe: not in state.particles)・`:132`(advances on host & client→on the DO & clients)・`:214`(single/host/client all call this→every client calls this)・`:254-255`(consistent across single/host/client / single-player byte-for-byte→consistent across clients / reads state only)・`:367-368`(single-player stays byte-for-byte / advances on host & client→client-safe / advances on the DO & clients)・`:436`(advances on host via update + client via snapshot→advances via the DO's snapshots)・`:450`(on the host and on a client victim→on the DO and on a client victim)・`:899`(local, host,→local & remote)・`:1104-1105`(synced on host & client / no host-only state→synced via the DO / no server-only state)・`:1685/:1688`(the host drives the world / host's Hello→the DO drives the world / the DO's Hello)・`:1711`(the host's Hello→the DO's Hello)。

- [ ] **Step 6: `game/main.ts` の host/method-C 語彙を一掃**

`:55`(host's snapshot→the DO's snapshot)・`:58`(host-authoritative→DO-authoritative)・`:258`(`Mirrors the spirit of the deleted method-C join() failure wiring`→`Connect-failure surfaces: timeout + early close + room-full.` に統合ないし method-C 参照を削除)・`:466`(so the host holds us idle→so the DO holds us idle)。※`:439` は PR1 が処理済みなので対象外。

- [ ] **Step 7: `game/systems/{stalkerFx,stalkerPhantom}.ts`・`game/input.ts`・`game/ui.ts`・`game/net/events.ts`**

- `stalkerFx.ts:12`(Single-player stays byte-for-byte safe→client-safe: re-derived from the snapshot)・`:14`(runs on host, client, and single-player alike→runs on every client)。
- `stalkerPhantom.ts:10`(Single-player stays byte-for-byte safe→client-safe: NOTHING synced)。
- `input.ts:34`(room-code input, manual-SDP textareas→room-code input)。
- `ui.ts:16`(room-code input, manual-SDP textareas→room-code input)。
- `events.ts:12`(host picks the→the DO picks the)。

- [ ] **Step 8: grep で stale vocab の残存ゼロを確認**

Run:
```bash
grep -rniE "single.?player|\bhost\b|method.?c|webrtc|manual.?sdp|\bP2P\b" --include="*.ts" game/ | grep -viE "hostname|localhost|ghost|const host|\? location.host"
```
Expected: ヒットゼロ（`signaling.ts` の変数 `host` は grep 除外パターンで落ちる）。`signaling`（レイヤ言及）も別途 `grep -rn "signaling" game/ | grep -v "signaling.ts:"` でゼロ確認（import パスの `./net/signaling` はファイル名なので別カウント＝残ってよい）。

- [ ] **Step 9: typecheck / lint / build（コード不変の担保）**

Run:
```bash
bun run typecheck && bun run lint && bun run build
```
Expected: exit 0。コメントのみの変更なのでテストも当然 green（走らせるなら `bun run test`）。

- [ ] **Step 10: Commit**

```bash
git add game/
git commit -m "docs(2b③-A): sweep stale host/single-player/signaling comments to DO reality

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0165mBZ5AdBijatR8TPa39cY"
```

---

### Task 2: dead export 削除 + un-export (C)

**Files:** `game/settings.ts`（削除）・`game/engine/audioAssets.ts`・`game/engine/renderer.ts`・`game/game.ts`（un-export）。

**Interfaces:** `setInputModeOverride` export 消失。他 5 個は named export → module-local に降格（呼び出し側は不変）。

- [ ] **Step 1: `setInputModeOverride` が真に未使用であることを再確認**

Run:
```bash
grep -rn "setInputModeOverride" game/ index.html
```
Expected: `game/settings.ts:59` の宣言のみ（他ゼロ）。

- [ ] **Step 2: `game/settings.ts` の `setInputModeOverride` 関数を削除**

`game/settings.ts:59` の `export function setInputModeOverride(m: InputMode | null): void { … }` を丸ごと削除（関数本体まで）。削除後に未使用になる import/型があれば併せて除去。

- [ ] **Step 3: 5 個を un-export（named export → module-local）**

各宣言の先頭 `export ` キーワードのみ削除（本体・呼び出しは不変）:
- `game/engine/audioAssets.ts:100` `export function missingRequiredSamples(` → `function missingRequiredSamples(`（呼び出し `:159` は同一 module 内で有効）。
- `game/engine/renderer.ts:284` `export function setWalls(` → `function setWalls(`（`Renderer` object member `:726` と `game.ts:1696` の `Renderer.setWalls` は object 経由なので不変）。
- `game/game.ts:58` `export function closeShopOverlay(` → `function closeShopOverlay(`（`:1464` 呼び出しは同 module）。
- `game/game.ts:191` `export function audioAmbience(` → `function audioAmbience(`（`:430` 呼び出しは同 module）。
- `game/game.ts:1429` `export function buyItem(` → `function buyItem(`（`:1423` 呼び出しは同 module）。

- [ ] **Step 4: typecheck / lint / build / knip**

Run:
```bash
bun run typecheck && bun run lint && bun run build && bun run knip
```
Expected: typecheck/lint/build exit 0。`knip` の "Unused exports" から上記 6 個が消える（`setInputModeOverride` 完全消失、他 5 個は un-export で non-export 化）。

- [ ] **Step 5: Commit**

```bash
git add game/settings.ts game/engine/audioAssets.ts game/engine/renderer.ts game/game.ts
git commit -m "refactor(2b③-C): delete dead setInputModeOverride; un-export 5 module-local fns

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0165mBZ5AdBijatR8TPa39cY"
```

---

### Task 3: `signal` → `worker` 改名 (D)

**Files:** `package.json`・`scripts/ensure-signal-port.ts`（→`ensure-worker-port.ts`）・`CLAUDE.md`。

**Interfaces:** npm script `signal` → `worker`。`bun run worker` / `bun run dev:coop` は挙動同一（arena worker のポート番 + wrangler dev）。

- [ ] **Step 1: スクリプトファイルを rename**

Run:
```bash
git mv scripts/ensure-signal-port.ts scripts/ensure-worker-port.ts
```

- [ ] **Step 2: rename したファイルの signaling 語彙を worker/arena へ**

`scripts/ensure-worker-port.ts` の冒頭 JSDoc（`Preflight guard for the arena worker dev port (\`bun run signal\` / \`dev:coop\`).`）の `bun run signal` → `bun run worker`。本文の "signaling" 語彙は既に "arena worker" 中心なので、`bun run signal` 参照だけ確実に更新。

- [ ] **Step 3: `package.json` の script を改名**

現状:
```json
    "signal": "bun run scripts/ensure-signal-port.ts && cd worker && bunx wrangler dev --port 8787",
    "dev:coop": "concurrently -k -n game,signal -c green,cyan \"vite\" \"bun run signal\"",
```
→
```json
    "worker": "bun run scripts/ensure-worker-port.ts && cd worker && bunx wrangler dev --port 8787",
    "dev:coop": "concurrently -k -n game,worker -c green,cyan \"vite\" \"bun run worker\"",
```

- [ ] **Step 4: `CLAUDE.md` の `bun run signal` 参照を更新**

`CLAUDE.md` の Commands 節と Run/deploy 節の `bun run signal` を `bun run worker` に、説明文の "just the worker … The old WebRTC signaling relay was deleted in 2b-0." の文面は保ちつつ script 名参照を合わせる（`bun run signal` の 2 箇所）。

Run（確認）:
```bash
grep -rn "bun run signal\|ensure-signal-port\|-n game,signal" package.json CLAUDE.md scripts/
```
Expected: ヒットゼロ。

- [ ] **Step 5: 改名後にスクリプトが解決することを確認**

Run:
```bash
bun run worker &
sleep 3; jobs
kill %1 2>/dev/null || true
```
Expected: `ensure-worker-port.ts` が走り（ポート空きなら exit 0 で通過）wrangler dev が起動を試みる（8787 が空いていれば起動、埋まっていれば preflight が PID を報告して非ゼロ終了 — どちらも「スクリプトが解決した」証左）。※CI では走らせない、ローカル確認のみ。

- [ ] **Step 6: typecheck（scripts tsconfig）**

Run:
```bash
bun run typecheck
```
Expected: exit 0（`scripts/tsconfig.json` は `include:["."]` なのでファイル名変更に追従不要）。

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/ensure-worker-port.ts CLAUDE.md
git commit -m "chore(2b③-D): rename 'signal' script → 'worker' (signaling relay retired in 2b-0)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0165mBZ5AdBijatR8TPa39cY"
```

---

### Task 4: deferred test/doc minors 回収 (E)

**Files:** `sim/systems/siege.test.ts`・`sim/systems/siegeEdge.test.ts`・`sim/systems/siege.ts`（JSDoc）。

**方針: verify-then-add-missing。** 各 ledger minor を現コードで確認し、本当に欠けているものだけ追加。既に被覆済み/価値の低いものは落とす。

- [ ] **Step 1: T5b — 冗長な "still fires DAY" テストを削除**

`sim/systems/siegeEdge.test.ts:33-37` の `it("still fires DAY on the normal night→day dawn", …)`（`.some()` を使う）は、`:11-16` の `it("night→day yields DAY banner + dawn sting")`（`toEqual` で完全被覆）と重複。`:33-37` の `it` ブロックを削除。

- [ ] **Step 2: T1a — enterBreached 後に breachT===0 を pin するアサーションを追加**

`sim/systems/siege.test.ts` の breach 発火テスト（`expect(out).toBe("breached")` を含む `it`、~206-211 付近）に、breachT がリセットされることの pin を追加:
```ts
    expect(s.breachT).toBe(0); // enterBreached zeroes the accumulator on the transition frame
```
（`enterBreached`（siege.ts:33）が breachT を 0 にしていることの回帰保護。既存の phaseT アサーションの直後に足す。）

- [ ] **Step 3: T1b — sub-threshold で breachT が nonzero に積む→decay するテスト（cheap なら追加、高コストなら skip）**

既存の "does not fire when interior empty (breachT decays)" は indoor===0 の decay しか見ていない。indoor が閾値未満で nonzero に積んでから decay する経路を安価に組めるなら 1 ケース追加、`nightState()` ヘルパでの indoor 配置が煩雑なら本 minor は **skip**（ledger 上 optional）。判断は実装者が実コードで行い、skip したら commit メッセージに理由を1行残す。

- [ ] **Step 4: seedRoamers JSDoc に両 caller を明記**

`sim/systems/siege.ts:69-70`:
```ts
/** Seed the day's sparse wanderers. Extracted from startDay so thaw can re-seed without
 *  re-running startDay's phaseT reset + cache restock. */
```
→
```ts
/** Seed the day's sparse wanderers. Callers: startDay (fresh day) and rearmThaw (persistence
 *  thaw — re-seeds without re-running startDay's phaseT reset + cache restock). */
```

- [ ] **Step 5: T4 (per-phase it split) は落とす**

snapshot phase の per-phase `it` split は cosmetic で回帰価値なし。**対応しない**（本 step はレビュー時の「なぜ E に無いか」の記録）。

- [ ] **Step 6: テスト green を確認**

Run:
```bash
bun run test -- sim/systems/siege.test.ts sim/systems/siegeEdge.test.ts
```
Expected: PASS（削除で件数減・追加で件数増、全 green）。続けて `bun run test` で全体 green も確認。

- [ ] **Step 7: lint（`!` 非null禁止・warnings=error）**

Run:
```bash
bun run lint
```
Expected: exit 0（追加テストで `!` を使わない。必要なら `as (typeof …)[number]` cast）。

- [ ] **Step 8: Commit**

```bash
git add sim/systems/siege.test.ts sim/systems/siegeEdge.test.ts sim/systems/siege.ts
git commit -m "test(2b③-E): collect deferred minors — drop redundant DAY test, pin breachT reset, seedRoamers JSDoc

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0165mBZ5AdBijatR8TPa39cY"
```

---

## Self-Review

- **Spec coverage (PR2)**: A stale コメント（T1、net.ts 最優先含む・false-stale 除外・PR1 済み行除外）✅ / C dead export 削除 + un-export（T2）✅ / D signal→worker（T3、package.json + file rename + CLAUDE.md）✅ / E deferred minors（T4、verify-then-add）✅。
- **false-stale 保護**: `signaling.ts:7-8` の変数 `host` は grep 除外 + 明記で除外 ✅。意図的 reserve コメント（fxEvents/bit0/bit1）は A 対象外 ✅。
- **Placeholder scan**: A は vocab ルール + 全サイト列挙 + 最優先の exact rewrite。E の T1b のみ条件付き（cheap なら追加、skip 可を明記）— これは placeholder ではなく明示的な judgment gate ✅。
- **Type consistency**: コード API 不変（コメント/export キーワード/script 名/テストのみ）✅。

## PR

PR2 = Task 1-4。ブランチ `feat/do-2b3-cleanup-pr2`（PR1 マージ後の main から）。CI（check + worker）green → マージ → 2b③ DONE。以降デプロイ（deploy-worker.yml 手動）= ユーザ確定「2b③ 後」。
