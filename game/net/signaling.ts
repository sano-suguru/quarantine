import { CONFIG } from "../../sim/config";

/** Dial URL for the authoritative arena DO (wss:// over https, ws:// over http). */
export function arenaUrl(code: string): string {
  const https = location.protocol === "https:";
  const scheme = https ? "wss" : "ws";
  const host = https ? location.host : CONFIG.net.signalUrl;
  return `${scheme}://${host}/arena/${encodeURIComponent(code.toUpperCase())}`;
}
