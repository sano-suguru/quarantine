# 2b③ cleanup — post-2b② arena の後片付け (design/spec)

**Sub-project 2b, final slice.** 2a (DO authority) → 2b-0 (method-C 掃除) → 2b① (living loop/shop/reconnect) → 2b② (soft-reset #60 + persistence #61) が積み上がった後に残った **stale コメント / dead code** を掃除し、コードを post-2b② arena の現実へ一致させる。

## Goal & non-goal

- **Goal**: DO-authoritative・single-WS・no-host-as-peer・no-single-player の現実にコードとコメントを一致させる。dead な pause / `Net.mode` vestigial を撤去する。
- **Non-goal**: 新機能・feel 変更・挙動変更は一切なし。観測可能な挙動は掃除前後で同一。唯一の wire 変更は **semantic-only**（PROTOCOL bump のみ、バイト列不変）。

## 支配的不変条件 (bind every task)

1. **挙動不変。** A/C/D/E はコメント・命名・dead export・テストのみ。B（pause / `Net.mode` 撤去）は「常に `false` / 常に `"client"`」という定数を消すだけで、観測挙動は同一。
2. **wire 変更は semantic-only。** `paused` を snapshot から外すが、**bit1 は reserve（repack しない）**。`paused` は常に `false` だったのでバイト列は不変 → **golden `len=306 fnv=770b418f` 不変**を検証で担保。**PROTOCOL_VERSION 20→21**（field 撤去 = decode shape 変更なので bump。inShop 撤去 18→19 の precedent と同型）。
3. **削除前に実コードで live/dead を裏取り。** 「stale に見えて実は live」を壊さない。rubber-duck で妥当性を裏取りする。
4. **sim/ は headless 維持**（DOM/WebGL/Audio を持ち込まない）。
5. **feel-first は該当しない**（挙動不変の掃除）。ただし dev:coop での smoke（起動・接続・pause キー無反応化・golden test green）で観測挙動不変を確認する。
6. **⚠ 意図的 reserve を巻き込まない（duck 指摘）。** B の勢いで以下を消さないこと — これらは plumbed-but-unused の**意図的 reserve** であり、消すと golden が動く/将来の復活を壊す:
   - snapshot の **fxEvents セクション**（wire にゼロ個しか乗らないが format は plumbed & tested。CLAUDE.md 記載）。
   - snapshot player flag byte の **bit0 "unused (was lightOn)"**（`snapshot.ts:688/969`）。
   - flags byte の **bit1**（本 slice で paused を外した後の reserve — `inShop` の bit3 同様、repack しない）。

## スコープ (5 カテゴリ)

### A. Stale コメント一掃 (挙動ゼロ変更)

DO cutover で消えた語彙を post-DO の現実へ書き換える。`host`（host-as-peer の意味の）/ `single-player` / `SP` / `method-C` / `WebRTC` / `manual-SDP` / `signaling` / `MVP: only the host pauses` など。

- 対象: `game/game.ts`・`game/main.ts`・`game/net/*.ts`（`events.ts`/`net.ts`/`client.ts`/`link.ts`/`ghost.ts`）・`game/systems/stalkerFx.ts`/`stalkerPhantom.ts`・`game/input.ts`・`game/ui.ts`（duck 実測で stale vocab **~41 行**。当初見積り「~25-30」は過小）。
- **最優先の stale（duck 特定・挙動を誤記述）**: `game/net/net.ts:11-16` の PROTOCOL コメント — 「Sent on the signaling URL (`&v=`) so a mismatch is rejected BEFORE P2P … the manual-SDP path」と書くが、実際は `arenaUrl`（`signaling.ts`）は `&v=` を付けず、P2P も manual-SDP も存在しない。version gate は今や **client 側 `client.ts:120` の hello.v チェックのみ**。この一節を現実（hello-echoed version、client-side self-eject）へ書き換える。`game/net/link.ts:1` の "(removed) WebRTC PeerLink" も対象。
- ⚠ 各コメントを実コードと突き合わせる。`host & client` が「現在 client のみだが将来のため」ではなく「今 client だけ」なら client 語彙へ。`single-player stays byte-for-byte`（`stalkerFx.ts:12/14`・`stalkerPhantom.ts:10`・`game.ts:39/101/122/255/367` 等）のような「もう存在しないモードの保証」は削除ないし「client/DO で一貫」へ書き換え。
- **判定基準**: コメントが記述する対象コードの現在の挙動を正確に述べているか。stale なら現実へ、記述が今も正しいなら触らない。

### B. dead な pause + `Net.mode` の完全撤去

**B1. pause サブシステム撤去（inShop 撤去 = M-B T6 と同型）**

`state.paused` の唯一の writer は `togglePause`（`game.ts`）で、それ自体が `if (Net.mode === "client") return;` で常に即 return する dead。サーバ側は不変条件「DO never globally pauses」で決して書かない。ゆえに `state.paused` は**常に `false`**。

撤去対象:
- `togglePause()`（`game/game.ts`）と P/Esc の pause caller（`game/main.ts` の keydown）。Esc の overlay-close は残す（pause とは別責務）。
- `#pause` overlay（`index.html`）と `Esc/P pause` のキーヒント。
- `state.paused`: `sim/types.ts` の `State.paused`、`sim/state.ts` の init、`sim/step.ts:24` のガード（`|| state.paused` を落とす）、`game/game.ts` の pause overlay show（1305）と `state.running && !state.paused` の read（258, main.ts:462）。
- snapshot: `Snapshot.paused`（`sim/snapshot.ts` の型・capture・apply・encode・decode）を撤去。**encode の flags byte で bit1 を reserve（`| (paused?2)` を削除、phase は `<< 2` のまま repack しない）**。decode も `paused` を落とし phase の `(flags >> 2) & 3` は不変。
- **PROTOCOL_VERSION 20→21**（`sim/net/protocol.ts`）。
- golden test: `paused` fixture=false なので `len=306 fnv=770b418f` は**不変**。golden test の inline snapshot はそのまま green のはず（変化したら bit1 repack の誤り）。

**B2. `Net.mode` / `NetMode` 撤去**

`NetMode = "client"` は単一値型、`Net.mode` は定数 `"client"`。全 `=== "client"` ガードは常真。

- `game/net/net.ts` の `NetMode` 型（`:6`）と `Net.mode` フィールド（`:47/:50`）を削除。
- **⚠ writer も撤去（duck 必須指摘）**: `game/main.ts:254` の `Net.mode = "client";` 代入行を削除（フィールドを消すなら typecheck が落ちる）。
- 常真ガードを無条件化: `game/main.ts:464`（`if (Net.mode === "client")` の分岐を展開）・`main.ts:508`（`Net.mode === "client" && st.running` → `st.running`）・`game/game.ts:1694`（`state.running && Net.mode === "client"` → `state.running`）。※`game.ts:1638`/`1637` は B1 で `togglePause` ごと消えるので該当なし。
- ⚠ `Net.mode`/`NetMode` を読む全箇所を grep で洗い、漏れなく無条件化してから型/フィールドを消す（worker 側・test 側の参照はゼロと確認済み）。

### C. 本物の dead export 削除 + knip un-export

- **削除**: `setInputModeOverride`（`game/settings.ts`）— どこからも未使用の真の dead。
- **un-export**（file 内使用のみ = `export` が冗長。同 PR で一緒に）: `missingRequiredSamples`（`audioAssets.ts`）・`setWalls`（`renderer.ts`; ただし `Renderer` object member としては live なので named export だけ外す）・`closeShopOverlay`・`audioAmbience`・`buyItem`（`game.ts`）。⚠ test が import していないか確認してから外す。

### D. signal→worker 改名

signaling relay は 2b-0 で削除済み。`signal` 命名は「arena worker のポート番」の実体と乖離。

- `package.json`: script `signal` → `worker`、`dev:coop` の `concurrently ... -n game,signal` → `-n game,worker`（色は据え置き可）。
- `scripts/ensure-signal-port.ts` → `scripts/ensure-worker-port.ts`（中身のコメント "signaling" 語彙も worker/arena へ）。参照する `package.json` のパスも更新。
- `CLAUDE.md` の `bun run signal` 参照（Commands 節・Run/deploy 節）を `bun run worker` へ。
- ⚠ `scripts/tsconfig.json` の include にファイル名固定があれば更新。

### E. ledger deferred test/doc minors 回収

planning 時に実コードで再確認して束ねる（存在しなければ落とす）:
- T1a: `breachT === 0` after `enterBreached` を pin するテスト（`sim/systems/siege.test.ts`）。
- T1b: sub-threshold で breachT が nonzero に decay するテスト（現状 indoor===0 のみ）。
- T4: snapshot phase の per-phase `it` split（cosmetic; 価値低ければ落とす）。
- T5b: 冗長な "still fires DAY" テストの削除（`siegeEdge.test.ts`）。
- seedRoamers JSDoc に両 caller（startDay / rearmThaw）を明記（`sim/systems/siege.ts`）。
- applyCycle の silent-partial（将来の map 変更時）の注記 — SCHEMA_VERSION bump プロセスに委ねる旨のコメント（`sim/net/persist.ts`）。

## テスト戦略

- **B が唯一のテスト面**: golden snapshot（`fnv` 不変を pin）・`sim/step.test.ts`（`paused` アサーション撤去）。既存の pure テストは green 維持。
- E で追加する pure テスト（breachT / siegeEdge）。
- A/C/D はコンパイル + lint + 既存テスト green で担保（コメント/命名/dead export はテスト不要）。
- 全体ゲート: `typecheck`（root + scripts + sim + worker）・`lint`（`--error-on-warnings`）・`test`・`build`。dev:coop smoke（起動・接続・P キー無反応・golden green）。

## リスクと緩和

- **golden fnv が変わる** → bit1 を誤って repack した兆候。reserve（`<< 2` 据え置き）を守れば不変。テストで即検知。
- **PROTOCOL bump 漏れ** → 旧クライアントが silent desync。20→21 を確実に。hello v-gate が stale client を弾く（既存機構）。
- **stale に見えて live なコメントを誤削除** → 各コメントを対象コードと突き合わせ、duck で裏取り。
- **un-export した symbol を test が import していた** → grep 確認後に外す。

## PR 分割 (duck 推奨・ユーザ確定 — 2 PR)

2b① の cleanup→feature 2 分割 precedent に倣い、**wire 変更を純掃除ノイズから隔離**する:

- **PR1 = B（pause + Net.mode 完全撤去）** — 唯一の wire 変更（PROTOCOL 20→21）+ テスト面（golden 不変の pin・step.test の paused アサーション撤去）。golden-invariant の証明を孤立させる。
- **PR2 = A + C + D + E（コメント / dead export / 改名 / test 回収）** — 挙動ゼロ変更。相互に独立で順序任意。

B を先に land（golden 不変が clean に示せる）→ PR2。両 PR とも main から独立に切れる（PR2 は PR1 に依存しないが、順序は PR1→PR2）。

## process

短い spec（本書）→ rubber-duck 盲点レビュー（実 netcode/DO/CF 接地・**済み**：4 指摘フォールド済み）→ writing-plans → SDD（`.superpowers/sdd/progress.md` に ledger）→ subagent-driven-development（タスクごと実装＋2段階レビュー、最後に opus 全体レビュー）→ PR → CI（check + worker 両 required）→ マージ。実装は `feat/do-2b3-cleanup`（main から；PR2 用に別ブランチを切る）。デプロイ（deploy-worker.yml 手動）は **2b③ 後**（ユーザ確定済み）。
