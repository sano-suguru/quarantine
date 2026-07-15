/**
 * Preflight guard for the arena worker dev port (`bun run worker` / `dev:coop`).
 *
 * The game always dials the arena at CONFIG.net.devArenaHost (127.0.0.1:8787). Wrangler, however,
 * SILENTLY falls back to a random free port when 8787 is already taken — so a stale/zombie worker
 * squatting 8787 leaves the fresh worker on some other port while the game keeps talking to the
 * dead one ("connecting to the arena…" forever). This guard makes that situation fail loudly
 * instead: if 8787 is occupied it prints the offending PID + how to clear it, and exits non-zero
 * so the worker never starts on the wrong port.
 */
import { execFileSync } from "node:child_process";

const PORT = 8787;

function listenerPids(port: number): string[] {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    // lsof exits non-zero when nothing matches (port is free) or isn't available (e.g. non-macOS).
    return [];
  }
}

const pids = listenerPids(PORT);
if (pids.length === 0) {
  process.exit(0);
}

let detail = "";
try {
  detail = execFileSync("ps", ["-o", "pid=,command=", "-p", pids.join(",")], {
    encoding: "utf8",
  }).trimEnd();
} catch {
  detail = pids.join(", ");
}

console.error(
  `\n✖ Arena dev port ${PORT} is already in use — refusing to start on a fallback port.\n` +
    `  The game only talks to 127.0.0.1:${PORT}; a worker on any other port is invisible to it.\n\n` +
    `  Offending process(es):\n${detail}\n\n` +
    `  If this is a stale/zombie worker (e.g. from a previous run or a renamed dir), clear it:\n` +
    `    kill ${pids.join(" ")}      # then re-run; use kill -9 if it survives\n`,
);
process.exit(1);
