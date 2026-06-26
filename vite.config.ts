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
    include: ["src/**/*.test.ts"],
  },
});
