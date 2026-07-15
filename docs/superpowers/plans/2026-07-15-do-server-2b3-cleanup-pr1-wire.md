# 2b③ cleanup — PR1 (B: pause + Net.mode 完全撤去) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DO 世界で常に定数化している dead な pause サブシステムと `Net.mode`/`NetMode` vestigial を完全撤去する（挙動不変・wire は semantic-only）。

**Architecture:** 2 タスク。**Task 1** = client 側の dead 撤去（togglePause / P キー / `#pause` overlay / `Net.mode`・`NetMode`）— wire 不変。**Task 2** = sim 側の `state.paused` + `Snapshot.paused` 撤去 + PROTOCOL 20→21（snapshot bit1 は reserve、repack しない → golden fnv 不変）。この順序で各タスク後も typecheck/test が green。

**Tech Stack:** TypeScript (strict, noUncheckedIndexedAccess) / Bun / Vitest / Biome (`--error-on-warnings`).

## Global Constraints

- 挙動不変。pause は常に `false`、`Net.mode` は常に `"client"` だったので観測挙動は同一。
- wire は semantic-only: **PROTOCOL_VERSION 20→21**、encode の flags byte で **bit1 を reserve（`| (snap.paused?2:0)` を削除、phase の `<< 2` は据え置き＝repack しない）**、golden `len=306 fnv=770b418f` **不変**。
- sim/ は headless（DOM/WebGL/Audio 持ち込まない）。
- ⚠ 意図的 reserve を巻き込まない: snapshot の fxEvents セクション・player flag bit0 "unused (was lightOn)"・flags bit1（paused 撤去後の reserve）は消さない。
- ⚠ タスク順序厳守（Task 1 が client reader/writer を先に消す → Task 2 で State/Snapshot から paused を消しても typecheck が落ちない）。
- テストは `!` 非null assertion 禁止（`as (typeof …)[number]` cast を使う。repo 慣習）。
- 全体ゲート: `bun run typecheck`（root+scripts+sim）・`cd worker && bunx tsc --noEmit`・`bun run lint`・`bun run test`・`bun run build`。

---

### Task 1: client 側 dead 撤去（pause UI + Net.mode/NetMode）— wire 不変

**Files:**
- Modify: `game/game.ts`（`togglePause` 削除・`audioLoops` の paused read・pause overlay show/hide・`startClientGame` の Net.mode ガード）
- Modify: `game/main.ts`（P キー caller・import・`Net.mode = "client"` writer・`live` の paused read・`if (Net.mode === "client")` unwrap・`hide("pause")`・showNet ガード）
- Modify: `game/net/net.ts`（`NetMode` 型・`Net.mode` フィールド）
- Modify: `index.html`（`#pause` overlay 要素・`Esc/P pause` ヒント）

**Interfaces:**
- Consumes: なし（既存コードの削除・簡約のみ）。
- Produces: `Net` の型は `{ client: Client | null }`（`mode` フィールド消失）。`togglePause` export 消失。他タスクは依存しない。

- [ ] **Step 1: `game/game.ts` の `togglePause` を削除**

`game/game.ts:1637-1642` の関数を丸ごと削除:
```ts
export function togglePause(): void {
  if (Net.mode === "client") return; // MVP: only the host pauses the shared sim
  if (!state.running || shopOpen) return;
  state.paused = !state.paused;
  // the overlay itself is driven by state.paused in updateHUD (so a host pause shows on
  // every client via the snapshot) — no imperative show/hide here.
}
```
（前後の `closeArsenal` / `shopVisible` は残す。）

- [ ] **Step 2: `game/game.ts` の pause overlay show/hide を削除**

`game/game.ts:1302-1306`（`updateHUD` 内）を:
```ts
  // pause overlay is state-driven (so a host pause shows on every client via the
  // snapshot); shopOpen is a client-local overlay, not a sim pause — suppress the
  // pause banner while the shop is open to avoid stacking two overlays.
  if (state.paused && !shopOpen) show("pause");
  else hide("pause");
```
→ ブロックごと削除（`#pause` 要素自体を Step 9 で消すので `hide("pause")` を残すと `el()` が throw する）。直前の `hide("action-btns")` の `}` の後、`}`（updateHUD 終端）までの間から本ブロックを除去。

- [ ] **Step 3: `game/game.ts:258` の paused read を簡約**

`audioLoops`（game.ts:258）:
```ts
  const live = state.running && !state.paused;
```
→
```ts
  const live = state.running;
```
併せて直上コメント（254-256）の pause 記述だけ更新: `so loops correctly stop during pause/shop/title/gameover` → `so loops correctly stop at title/gameover`（`single/host/client`・`single-player byte-for-byte` の語彙は PR2/A が担当するので触らない）。

- [ ] **Step 4: `game/game.ts:1694` の Net.mode ガードを簡約**

`startClientGame`（game.ts:1694）:
```ts
  if (state.running && Net.mode === "client") return;
```
→
```ts
  if (state.running) return;
```

- [ ] **Step 5: `game/main.ts` の P キー pause caller を削除**

`game/main.ts:439-449` の keydown ハンドラ:
```ts
    if (e.code === "Escape" || e.code === "KeyP") {
      // Esc closes the options panel first (without touching the host-authoritative pause)
      if (settingsOpen) {
        e.preventDefault();
        closeSettings();
        return;
      }
      if (state.running) {
        e.preventDefault();
        togglePause();
      }
    }
```
→ pause 呼び出しブロックを削除、overlay-close は残す:
```ts
    if (e.code === "Escape" || e.code === "KeyP") {
      // Esc/P closes the options panel (pause was removed — the DO-authoritative world never pauses).
      if (settingsOpen) {
        e.preventDefault();
        closeSettings();
      }
    }
```
併せて import 行 `game/main.ts:27` の `togglePause,` を削除。

- [ ] **Step 6: `game/main.ts:254` の Net.mode writer を削除**

`game/main.ts:254` の代入行を削除:
```ts
  Net.mode = "client";
```
（前後の `const code = …` / `let arenaStarted = false;` は残す。）

- [ ] **Step 7: `game/main.ts:462` の paused read を簡約**

```ts
    const live = st.running && !st.paused;
```
→
```ts
    const live = st.running;
```

- [ ] **Step 8: `game/main.ts:464` の `if (Net.mode === "client")` を unwrap + 504/508 のガード簡約**

frame 内 `if (Net.mode === "client") {`（464）は else 無し。条件を外してブロック本体（465-491）を 1 段 dedent（Biome が再フォーマットするので手動整形は最小で可）。
`game/main.ts:504` の pause 抑制:
```ts
    if (settingsOpen) hide("pause");
```
→ 削除（`#pause` 要素消失に伴い throw を防ぐ）。直上コメント（500-502）の `and suppress the pause overlay underneath it so the two never stack` を削除、`gameover/shop` の force-close 記述は残す。
`game/main.ts:508` showNet:
```ts
      const showNet = Net.mode === "client" && st.running;
```
→
```ts
      const showNet = st.running;
```

- [ ] **Step 9: `index.html` の `#pause` overlay + ヒントを削除**

`index.html:143-` の `<div id="pause" class="overlay hidden"> … </div>`（`PAUSED` 見出しを含む overlay 全体）を削除。`index.html:101` の `<span><b>Esc/P</b> pause</span>` を削除（隣の `<span><b>M</b> mute</span>` は残す）。

- [ ] **Step 10: `game/net/net.ts` の `NetMode` 型 + `mode` フィールドを削除**

`net.ts:5-6`:
```ts
/** Which role this client is playing this session. */
export type NetMode = "client";
```
→ 削除。
`net.ts:46-53`:
```ts
export const Net: {
  mode: NetMode;
  client: Client | null;
} = {
  mode: "client",
  client: null,
};
```
→
```ts
export const Net: {
  client: Client | null;
} = {
  client: null,
};
```

- [ ] **Step 11: `Net.mode`/`NetMode`/`state.paused` の client 側残存参照ゼロを確認**

Run:
```bash
grep -rn "Net\.mode\|NetMode" game/ ; grep -rn "\.paused" game/ ; grep -rn '"pause"' game/
```
Expected: 3 grep とも `game/` 側ヒットゼロ。特に `"pause"`（`show("pause")`/`hide("pause")`）の残存は Step 9 で `#pause` 要素を消した後 `el()` が throw するので、game.ts:1305-1306 + main.ts:504 が全て消えたことをここで確認（`sim/` の `state.paused` は Task 2 で消す）。

- [ ] **Step 12: typecheck / lint / build**

Run:
```bash
bun run typecheck && bun run lint && bun run build
```
Expected: いずれも exit 0（`state.paused` は sim 側にまだ在るので型は通る。client からの読み書きは消えた）。

- [ ] **Step 13: Commit**

```bash
git add game/game.ts game/main.ts game/net/net.ts index.html
git commit -m "feat(2b③-B/T1): remove dead pause UI + Net.mode/NetMode (client-side, no wire change)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0165mBZ5AdBijatR8TPa39cY"
```

---

### Task 2: sim 側 `paused` 撤去 + PROTOCOL 20→21（wire semantic-only）

**Files:**
- Modify: `sim/types.ts:542`（`State.paused`）
- Modify: `sim/state.ts:74`（init）
- Modify: `sim/step.ts:24`（ガード）
- Modify: `sim/snapshot.ts`（`Snapshot.paused` 型・capture・apply・encode bit1・decode）
- Modify: `sim/net/protocol.ts:3`（20→21）
- Test: `sim/step.test.ts:39-44`（paused アサーション撤去）、`sim/snapshot.test.ts:107-143`（golden 不変を検証）

**Interfaces:**
- Consumes: Task 1 で `game/` から `state.paused` の read/write が消えている前提。
- Produces: `Snapshot` から `paused` 消失、`State` から `paused` 消失。`PROTOCOL_VERSION === 21`。

- [ ] **Step 1: golden test を先に走らせ現状 fnv を確認（回帰基準）**

Run:
```bash
bun run test -- sim/snapshot.test.ts -t "golden"
```
Expected: PASS。inline snapshot は `"len=306 fnv=770b418f"`。撤去後もこの値が不変であることが Task 2 の安全網。

- [ ] **Step 2: `sim/step.test.ts` の paused アサーションを撤去**

`sim/step.test.ts:39-44`:
```ts
  it("returns null on a normal tick and does NOT set paused (no openShop)", () => {
    const s = newState();
    s.running = true;
    expect(stepSim(s, 1 / 60)).toBe(null);
    expect(s.paused).toBe(false);
  });
```
→ null-return 被覆は残し、paused 行とタイトルの paused 言及を除去:
```ts
  it("returns null on a normal tick", () => {
    const s = newState();
    s.running = true;
    expect(stepSim(s, 1 / 60)).toBe(null);
  });
```

- [ ] **Step 3: `bun run test -- sim/step.test.ts` を走らせ、まだ green（paused 型は残存）を確認**

Run: `bun run test -- sim/step.test.ts`
Expected: PASS（この時点では State.paused はまだ存在）。

- [ ] **Step 4: `sim/snapshot.ts` の `Snapshot.paused` を撤去（型・capture・apply・encode・decode）**

- 型（`snapshot.ts:172`）: `paused: boolean;` を削除。
- capture（`snapshot.ts:218`）: `paused: state.paused,` を削除。
- apply（`snapshot.ts:372`）: `state.paused = snap.paused;` を削除。
- encode flags コメント + 演算（`snapshot.ts:639-640`）:
```ts
  // flags: bit0 isFull, bit1 paused, bits2-3 phase index (see PHASE_ORDER)
  w.u8((snap.isFull ? 1 : 0) | (snap.paused ? 2 : 0) | (PHASE_ORDER.indexOf(snap.phase) << 2));
```
→ **bit1 を reserve（repack しない）**:
```ts
  // flags: bit0 isFull, bit1 reserved (was paused; retired 2b③), bits2-3 phase index (see PHASE_ORDER)
  w.u8((snap.isFull ? 1 : 0) | (PHASE_ORDER.indexOf(snap.phase) << 2));
```
- decode（`snapshot.ts:1244`）: `paused: (flags & 2) !== 0,` を削除（`phase: PHASE_ORDER[(flags >> 2) & 3] ?? "day"` は不変）。

- [ ] **Step 5: `sim/step.ts:24` の paused ガードを簡約**

```ts
  if (!state.running || state.paused) return null;
```
→
```ts
  if (!state.running) return null;
```

- [ ] **Step 6: `sim/types.ts` + `sim/state.ts` から `State.paused` を撤去**

- `sim/types.ts:542`: `paused: boolean;` を削除。
- `sim/state.ts:74`: `paused: false,` を削除。

- [ ] **Step 7: `sim/net/protocol.ts` を 20→21 に bump**

`sim/net/protocol.ts:3`:
```ts
export const PROTOCOL_VERSION = 20;
```
→
```ts
export const PROTOCOL_VERSION = 21;
```

- [ ] **Step 8: 全テスト + golden 不変を確認**

Run:
```bash
bun run test
```
Expected: 全 PASS。特に `sim/snapshot.test.ts` の golden が **`"len=306 fnv=770b418f"` のまま**（変化したら bit1 を誤って repack した兆候 → Step 4 を見直す）。

- [ ] **Step 9: typecheck（root+worker）/ lint / build**

Run:
```bash
bun run typecheck && (cd worker && bunx tsc --noEmit) && bun run lint && bun run build
```
Expected: いずれも exit 0。`grep -rn "paused" sim/ game/ worker/` が（`snapshot.ts` の "was paused" reserve コメント以外）ゼロ。

- [ ] **Step 10: Commit**

```bash
git add sim/types.ts sim/state.ts sim/step.ts sim/snapshot.ts sim/net/protocol.ts sim/step.test.ts
git commit -m "feat(2b③-B/T2): retire state.paused from sim + snapshot; PROTOCOL 20→21 (bit1 reserved, golden unchanged)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0165mBZ5AdBijatR8TPa39cY"
```

---

## Self-Review

- **Spec coverage (B)**: pause 撤去（togglePause T1S1・P キー T1S5・overlay T1S2/S9・state.paused T2S4-6・step ガード T2S5・snapshot T2S4・PROTOCOL T2S7）✅ / Net.mode·NetMode 撤去（型/フィールド T1S10・writer T1S6・ガード T1S3/S4/S7/S8）✅ / bit1 reserve + golden 不変（T2S4/S8）✅。
- **意図的 reserve 保護**: fxEvents / bit0 は一切触れない（T2 は flags byte の paused 項のみ削除）✅。
- **タスク順序**: T1（client reader/writer 撤去、State.paused 残す）→ T2（sim から撤去）で各タスク後 green ✅。
- **Placeholder scan**: なし。全ステップに具体コード/コマンド/期待値あり ✅。
- **Type consistency**: `Net` 型は T1 で `{client}` に、`Snapshot`/`State` は T2 で paused 消失 — 参照は各タスク内で完結 ✅。

## PR

PR1 = Task 1+2。ブランチ `feat/do-2b3-cleanup`（main から）。CI（check + worker）green → 人手 smoke（dev:coop 起動・接続・P キー無反応・golden green）→ マージ。デプロイは 2b③ 後。
