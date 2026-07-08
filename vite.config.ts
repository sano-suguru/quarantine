/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  // Dev only: make the game same-origin with the signaling Worker (`bun run dev:coop` runs it on
  // :8787) by proxying the HTTP endpoints. This mirrors production (one Worker serves both), so the
  // public-room browser / quick-match fetch("/rooms") works without CORS. WebSocket signaling
  // (/room) is NOT proxied — it connects directly via CONFIG.net.signalUrl (works cross-origin and
  // the existing room-code co-op relies on it; proxying WS risks regressing that).
  server: {
    proxy: {
      "/rooms": "http://127.0.0.1:8787",
      "/turn": "http://127.0.0.1:8787",
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
  },
  test: {
    environment: "node",
    include: ["game/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html"],
      // Scope coverage to pure/logic modules where a % is a meaningful signal. `all` is left at its
      // default (true): every included file is reported even if untested, so coverage gaps in pure
      // logic stay visible (not hidden behind "only what tests touched"). feel/visual/IO/render code
      // is validated by playtest, not unit tests (see CLAUDE.md), so it is excluded from the gate —
      // this is the documented testing boundary, not a way to dodge coverage on testable logic.
      include: [
        "game/data/**",
        "game/systems/**",
        "game/config.ts",
        "game/state.ts",
        "game/meta.ts",
        "game/engine/math.ts",
        "game/engine/geometry.ts",
        "game/engine/fragment.ts",
        "game/engine/spatialHash.ts",
        "game/engine/players.ts",
        "game/net/snapshot.ts",
        "game/net/ghost.ts",
        "game/net/registry.ts",
        "game/net/host.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "game/types.ts",
        // render / audio / shaders — feel, validated by playtest
        "game/engine/renderer.ts",
        "game/engine/audio.ts",
        "game/engine/shaders/**",
        // DOM / entry / orchestration+render boundaries
        "game/input.ts",
        "game/main.ts",
        "game/ui.ts",
        "game/game.ts", // ~900-line update/draw/HUD loop is feel; its one pure fn (applyBuy) is covered by game.test.ts
        // feel/visual systems — CLAUDE.md: AI movement, camera, particles are not unit-tested
        "game/systems/ai.ts",
        "game/systems/camera.ts",
        "game/systems/fx.ts",
        // the Stalker: AI movement/state machine + telegraph particles/audio — same feel boundary
        // as ai.ts/fx.ts. Its pure geometry (LOS/hearing) lives in perception.ts, which IS covered.
        "game/systems/stalker.ts",
        "game/systems/stalkerFx.ts",
        "game/systems/stalkerPhantom.ts",
        // net IO boundaries (WebRTC/WS/fetch/Worker)
        "game/net/client.ts",
        "game/net/signaling.ts",
        "game/net/transport.ts",
        "game/net/localInput.ts",
        "game/net/ticker.ts",
      ],
      // branch coverage is coarse under v8 — track lines/functions/statements only.
      // Regression floor: measured baseline (L 78.9 / F 81.0 / S 76.2) rounded down ~2pts after
      // adding pure-logic tests (upgrades/siege/wave/caches/pickups/state/meta).
      // Raise opportunistically as remaining untested pure logic (bullets hit-resolution) gains tests.
      thresholds: { lines: 77, functions: 78, statements: 74 },
    },
  },
});
