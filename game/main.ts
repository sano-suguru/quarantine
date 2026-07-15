import "./style.css";
import { CONFIG } from "../sim/config";
import { WORKBENCH } from "../sim/data/map";
import { localPlayer } from "../sim/engine/players";
import { reconnectDelay } from "../sim/net/reconnect";
import { emptyInput } from "../sim/playerInput";
import { sysCamera } from "../sim/systems/camera";
import { sysFx } from "../sim/systems/fx";
import { Audio } from "./engine/audio";
import { Renderer } from "./engine/renderer";
import {
  audioLoops,
  clientAmbience,
  closeArsenal,
  decayFlash,
  deployPlace,
  draftReroll,
  draftTake,
  draw,
  getState,
  isShopOpen,
  openArsenal,
  openShopOverlay,
  renderArsenal,
  shopDeploy,
  syncShopUI,
  toTitle,
  updateHUD,
} from "./game";
import { Input } from "./input";
import { applyInputMode } from "./inputMode";
import { Client } from "./net/client";
import type { PeerLink } from "./net/link";
import { sampleLocalInput } from "./net/localInput";
import { Net } from "./net/net";
import { arenaUrl } from "./net/signaling";
import { createArenaLink } from "./net/wsLink";
import { getSettings } from "./settings";
import { el, hide, isEditableTarget, show } from "./ui";

// Opt-in net diagnostics (?netlog in the URL or localStorage.netlog="1").
const NETLOG = (() => {
  try {
    return (
      (typeof location !== "undefined" && location.search.includes("netlog")) ||
      (typeof localStorage !== "undefined" && localStorage.getItem("netlog") === "1")
    );
  } catch {
    return false;
  }
})();

// Q-to-place: a small local cooldown so a held/mashed key doesn't fire several reliable place
// requests before the host's snapshot reflects the first (each would consume another queued item).
let lastPlaceAt = -1e9;

// personal options overlay (#settings): client-local, separate from the host-authoritative
// pause. While open, local input is zeroed (so you don't act blind behind the overlay).
let settingsOpen = false;

// Open the client-local shop overlay if the local player is at the fortress workbench during the
// day. Returns true if it handled the press (opened the shop) so the caller skips repair/search.
// Does NOT close — closing is the Done button / Enter (see shopDeploy).
function openWorkbenchShop(): boolean {
  const st = getState();
  if (!st.running || st.phase !== "day" || isShopOpen()) return false;
  const lp = localPlayer(st);
  if (Math.hypot(lp.x - WORKBENCH.x, lp.y - WORKBENCH.y) >= CONFIG.siege.interactRadius)
    return false;
  openShopOverlay();
  return true;
}

/**
 * Terminal teardown of the current arena session. Called on restart, tab close, and before
 * starting a new run. Disposes the client link and resets session vars. Idempotent.
 */
function endCoop(): void {
  cancelReconnect();
  hideReconnectBanner();
  reconnectId = null;
  currentLink = null;
  Net.client?.dispose();
  Net.client = null;
}

// True once Phase 1 (sprite load) completes — frame() skips the world draw until then so no
// broken/incomplete frame is shown behind the #loading overlay.
let spritesLoaded = false;
// Re-entry latch for the async Start path: a double-click must not launch two awaits / two runs.
let startingSingleRun = false;

// --- Arena auto-reconnect (M-C) ---------------------------------------------------------------
// A transient WS drop suspends the client and redials with backoff, replaying our {pid,nonce} so
// the DO re-attaches the held body in place (within graceMs) — else a fresh slot. Drop detection:
// PRIMARY = the WS onClose/onError (deterministic); BACKSTOP = the frame-loop starvation watchdog
// (a half-open socket that stays open but silent). The DO — not the client — decides in-place vs
// fresh via the grace window; hello.resumed reports which.
//
// `currentLink` is the single source of truth for "which link's events matter". Every link's
// onClose checks `link === currentLink` and ignores superseded links; startReconnect/onAttemptFail
// null it out BEFORE closing a link so that close's own onClose can't re-enter the state machine.
let reconnectId: { pid: number; nonce: string } | null = null; // our identity, persisted from Hello
let currentLink: PeerLink | null = null; // the live/attempt link; stale links' events are ignored
let reconnecting = false; // true from drop-detected until resume/give-up (guards re-entry + watchdog)
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null; // pending backoff wait
let attemptTimer: ReturnType<typeof setTimeout> | null = null; // pending per-attempt open+Hello budget
const arenaCode = (): string => new URLSearchParams(location.search).get("arena") ?? "MAIN";

function showReconnectBanner(attempt: number, max: number): void {
  el("reconnect-main").textContent = "RECONNECTING";
  el("reconnect-sub").textContent = `attempt ${attempt} / ${max}`;
  el("reconnect").classList.add("show");
}
function hideReconnectBanner(): void {
  el("reconnect").classList.remove("show");
}
function flashRespawnNote(): void {
  // grace exceeded → we came back as a fresh body at the fortress. Brief neutral note, then hide.
  el("reconnect-main").textContent = "RECONNECTED";
  el("reconnect-sub").textContent = "respawned at the fortress";
  el("reconnect").classList.add("show");
  setTimeout(hideReconnectBanner, 2500);
}

/** Cancel any in-flight reconnect (timers + flag). Called on teardown (endCoop) and on success. */
function cancelReconnect(): void {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  if (attemptTimer !== null) clearTimeout(attemptTimer);
  reconnectTimer = null;
  attemptTimer = null;
  reconnecting = false;
  reconnectAttempt = 0;
}

/** Wire a link's close so ONLY the current link's death acts: an attempt link dying → next backoff;
 *  a live (already-resumed) link dying → begin a new reconnect. Superseded links are ignored.
 *  INVARIANT: only ever call this on a FRESH link (createArenaLink result). wsLink.onClose fires the
 *  callback synchronously if the link is already closed — calling this on a closed link would
 *  re-enter the state machine. (Current callers pass only just-created links, so this holds.) */
function wireLinkClose(link: PeerLink): void {
  link.onClose(() => {
    if (link !== currentLink) return; // an old/superseded link closing → ignore
    if (reconnecting)
      onAttemptFail(link); // this attempt's link died → next backoff
    else startReconnect(); // a live link dropped → begin reconnect
  });
}

/** A drop was detected while playing. Suspend the client, show the banner, start the backoff loop.
 *  Idempotent — a second trigger (onClose + watchdog) while already reconnecting is ignored. */
function startReconnect(): void {
  if (reconnecting || !Net.client || !reconnectId) return;
  reconnecting = true;
  reconnectAttempt = 0;
  currentLink = null; // detach FIRST: the dropped link's onClose (fired by suspend) must not re-enter
  if (attemptTimer !== null) {
    clearTimeout(attemptTimer);
    attemptTimer = null;
  }
  Net.client.suspend(); // live=false, close the dead/half-open link, drop stale buffers
  scheduleAttempt();
}

/** Wait this attempt's backoff, then dial. Past the last backoff step → give up to the title. */
function scheduleAttempt(): void {
  const delay = reconnectDelay(reconnectAttempt, CONFIG.net.reconnect.backoffMs);
  if (delay === null) {
    // exhausted every attempt → the arena is unreachable. Tear down and show the terminal
    // disconnect screen (same surface as the pre-start drop) so the player isn't left in a
    // frozen limbo — endCoop nulls currentLink + disposes the client; showLoadError covers the
    // frozen frame with the #loading overlay + message (reload/re-Start to reconnect).
    cancelReconnect();
    hideReconnectBanner();
    endCoop();
    showLoadError("Disconnected from the arena.");
    return;
  }
  showReconnectBanner(reconnectAttempt + 1, CONFIG.net.reconnect.backoffMs.length);
  reconnectTimer = setTimeout(tryAttempt, delay);
}

/** One reconnect attempt: dial a fresh link (now `currentLink`), rebind (replays our rejoin token on
 *  open), and arm a per-attempt timeout. Success → onResumed (Step 6); failure → the link closing
 *  (wireLinkClose → onAttemptFail) or the timeout firing. */
function tryAttempt(): void {
  reconnectTimer = null;
  if (!Net.client || !reconnectId) return;
  const link = createArenaLink(arenaUrl(arenaCode()));
  currentLink = link;
  wireLinkClose(link);
  attemptTimer = setTimeout(() => {
    attemptTimer = null;
    if (link === currentLink && reconnecting) onAttemptFail(link); // opened-but-no-Hello / stuck dial
  }, CONFIG.net.reconnect.attemptTimeoutMs);
  Net.client.rebind(link, reconnectId); // wires the link + replays {t:"rejoin",...} on open
}

/** This attempt failed (link closed or timed out). Detach + close it, then schedule the next. Guarded
 *  so the close-and-timeout double-fire (or a stale link) can't advance the loop twice. */
function onAttemptFail(link: PeerLink): void {
  if (link !== currentLink || !reconnecting) return;
  currentLink = null; // detach BEFORE closing so this close's onClose no-ops
  if (attemptTimer !== null) {
    clearTimeout(attemptTimer);
    attemptTimer = null;
  }
  try {
    link.close();
  } catch {
    /* already closing */
  }
  reconnectAttempt++;
  scheduleAttempt();
}

/** Surface a load failure in the #loading overlay and stop (the user must reload). */
function showLoadError(msg: string): void {
  hide("start"); // an early sync throw (e.g. no WebGL2) leaves #start up — never let it compete
  show("loading");
  const errEl = el("loading-error");
  errEl.textContent = msg;
  errEl.classList.remove("hidden");
}

/**
 * Arena Start (first user gesture): open the AudioContext, wait for the required samples to decode
 * behind a brief #loading gate, then connect to the Arena DO as a DO client. Re-entry-guarded so a
 * double-click can't launch concurrent awaits or start the run twice.
 */
async function startSingleRun(): Promise<void> {
  if (startingSingleRun) return;
  startingSingleRun = true;
  const startBtn = el<HTMLButtonElement>("startBtn");
  startBtn.disabled = true;
  try {
    endCoop();
    Audio.resume(); // first gesture: opens AudioContext + kicks off sample decode
    hide("start");
    show("loading");
    await Audio.whenSamplesReady();
  } catch {
    showLoadError("Failed to load game audio. Please reload the page.");
    return;
  } finally {
    startBtn.disabled = false;
    startingSingleRun = false;
  }
  // Audio is ready — connect to the Arena DO. The world appears on the first snapshot;
  // onStart hides #loading. Use ?arena=CODE param if present, else default "MAIN".
  const code = new URLSearchParams(location.search).get("arena") ?? "MAIN";
  let arenaStarted = false;
  const link = createArenaLink(arenaUrl(code));
  // Connect-failure surfaces: timeout + early close + room-full.
  // Mirrors the spirit of the deleted method-C join() failure wiring (timeout/onOpen/onClose).
  const connectTimer = setTimeout(() => {
    if (!arenaStarted) {
      showLoadError("Couldn't reach the arena. Is it running? (check your connection and retry)");
      link.close();
    }
  }, CONFIG.net.arenaOpenTimeoutMs);
  link.onOpen(() => clearTimeout(connectTimer));
  link.onClose(() => {
    if (link !== currentLink) return; // superseded (a stale link) → ignore
    if (!arenaStarted) {
      clearTimeout(connectTimer);
      showLoadError("Disconnected from the arena.");
      return;
    }
    if (reconnecting) onAttemptFail(link);
    else startReconnect(); // post-start drop → auto-reconnect (primary trigger)
  });
  currentLink = link; // the initial link is the first "current" link
  Net.client = new Client(
    link,
    () => {
      arenaStarted = true;
      clearTimeout(connectTimer);
      hide("loading");
    },
    {
      onIdentity: (pid, nonce) => {
        reconnectId = { pid, nonce }; // persist for rebind (updated on a fresh-slot reconnect too)
      },
      onResumed: (resumed) => {
        if (!reconnecting) return; // initial connect → not a reconnect; ignore
        // success: clear timers + `reconnecting`. currentLink STAYS = the winning link (it is now
        // the live gameplay link); a future drop of it routes through wireLinkClose → startReconnect.
        cancelReconnect();
        if (resumed)
          hideReconnectBanner(); // re-attached in place → silent resume
        else flashRespawnNote(); // grace exceeded → fresh body at the fortress
      },
      onRoomFull: () => showLoadError("This arena is full (12 players). Try again later."),
    },
  );
}

async function main(): Promise<void> {
  const canvas = el<HTMLCanvasElement>("game");
  Renderer.init(canvas);
  Input.init(canvas);
  applyInputMode(getSettings().inputModeOverride);

  el("startBtn").onclick = () => void startSingleRun();

  // --- Mobile action buttons (#btn-heal, #btn-fortify, #btn-repair) ---
  // Routed through the Input seam (not keydown) so they reach sampleLocalInput.
  // Heal: one-shot pulse (set on touchstart, consumed once by sampleLocalInput).
  const btnHeal = el<HTMLButtonElement>("btn-heal");
  btnHeal.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault(); // stop scroll / ghost-click
      Input.touchHealPulse = true;
    },
    { passive: false },
  );

  // Repair: held while finger is down (touchstart → touchend/cancel).
  const btnRepair = el<HTMLButtonElement>("btn-repair");
  btnRepair.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      if (openWorkbenchShop()) return; // at the workbench by day → open the shop, not repair
      Input.touchInteract = true;
    },
    { passive: false },
  );
  const clearRepair = (e: TouchEvent): void => {
    e.preventDefault();
    Input.touchInteract = false;
  };
  btnRepair.addEventListener("touchend", clearRepair, { passive: false });
  btnRepair.addEventListener("touchcancel", clearRepair, { passive: false });

  // Fortify: calls deployPlace() with the same 300ms throttle as the Q key path.
  const btnFortify = el<HTMLButtonElement>("btn-fortify");
  btnFortify.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      const st = getState();
      if (!st.running || isShopOpen() || settingsOpen) return;
      if (localPlayer(st).hp <= 0) return;
      const now = performance.now();
      if (now - lastPlaceAt < 300) return;
      lastPlaceAt = now;
      deployPlace();
    },
    { passive: false },
  );

  el("restartBtn").onclick = () => {
    endCoop(); // game-over → title must fully drop any arena client
    toTitle();
  };
  el("deployBtn").onclick = shopDeploy;
  el("arsenalBtn").onclick = openArsenal;
  el("arsenalBackBtn").onclick = closeArsenal;
  renderArsenal(); // populate the ARSENAL overlay on first load

  const muteTag = el("mute");
  const netstat = el("netstat"); // ?netlog net-stat readout
  let netAcc = 0;

  // --- options / settings panel (#settings): personal, client-local. Reused from the title
  // (Options button) and in-game (O key). All wiring lives here so the mute toggle, the M
  // hotkey, and the #mute tag share one refresh closure (no display drift). ---
  const refreshMute = (): void => {
    muteTag.textContent = Audio.isMuted() ? "♪ muted [M]" : "";
  };
  const refreshSettings = (): void => {
    el("settingMute").textContent = Audio.isMuted() ? "ON" : "OFF";
  };
  const openSettings = (): void => {
    settingsOpen = true;
    refreshSettings();
    show("settings");
  };
  const closeSettings = (): void => {
    settingsOpen = false;
    hide("settings");
  };
  refreshMute();
  el("optionsBtn").onclick = openSettings;
  el("settingsClose").onclick = closeSettings;
  el("settingMute").onclick = () => {
    Audio.toggleMute();
    refreshMute();
    refreshSettings();
    Audio.ui(true);
  };

  addEventListener("keydown", (e) => {
    // Typing into a text field must not trigger game hotkeys.
    if (isEditableTarget(e.target)) return;
    const state = getState();
    if (e.code === "KeyE" && !e.repeat && openWorkbenchShop()) return;
    if (e.code === "KeyM") {
      Audio.toggleMute();
      refreshMute();
      refreshSettings(); // keep the options-panel mute label in sync if it's open
      return;
    }
    if (isShopOpen()) {
      const me = localPlayer(state);
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) {
        const card = me.draftOffer[Number(digit[1]) - 1];
        if (card) draftTake(card);
      } else if (e.code === "KeyR") draftReroll();
      else if (e.code === "Enter") shopDeploy();
      return;
    }
    // Q: drop the next queued deployable at your feet. Combat-time single key, so guard hard
    // (alive, running, not in the shop [early-returned above], options) and throttle (ignore
    // auto-repeat + a short cooldown) to avoid multi-placing on a held key.
    if (e.code === "KeyQ" && state.running && !settingsOpen) {
      if (e.repeat || localPlayer(state).hp <= 0) return;
      const now = performance.now();
      if (now - lastPlaceAt < 300) return;
      lastPlaceAt = now;
      deployPlace();
      return;
    }
    // O: open/close personal options in-game (title uses the Options button). Disabled in
    // the shop (handled above by the early return) and on the title/lobby (running === false).
    if (e.code === "KeyO" && state.running) {
      if (settingsOpen) closeSettings();
      else openSettings();
      return;
    }
    if (e.code === "Escape" || e.code === "KeyP") {
      // Esc/P closes the options panel (pause was removed — the DO-authoritative world never pauses).
      if (settingsOpen) {
        e.preventDefault();
        closeSettings();
      }
    }
  });

  const inputStep = 1 / CONFIG.net.inputHz;

  // --- render loop (rAF): draws always; runs client input/camera.
  // The sim runs entirely on the DO; the browser is a pure arena client. ---
  let rLast = performance.now();
  let sendAcc = 0;
  function frame(now: number): void {
    const dt = (now - rLast) / 1000;
    rLast = now;
    const st = getState();
    const live = st.running;

    // no authoritative sim — predict our player, interpolate the world, ship input.
    // While options or the shop overlay is open, send zeroed input so the host holds us idle.
    const inp = live ? (settingsOpen || isShopOpen() ? emptyInput() : sampleLocalInput(st)) : null;
    // throttle input send to ~25 Hz (latest-wins); predict & render still run every frame
    sendAcc += dt;
    if (inp && sendAcc >= inputStep) {
      sendAcc = 0;
      Net.client?.send(inp);
    }
    Net.client?.render(performance.now(), inp, dt);
    // Backstop drop detection: a half-open WS can stay open but silent (no onClose). If no
    // snap AND no rel has arrived for snapStarvationMs while running, treat the link as dead.
    // (A clean close fires onClose → startReconnect directly; this only catches the silent case.)
    if (st.running && Net.client && !reconnecting) {
      const idle = performance.now() - Net.client.lastActivityMs();
      if (idle > CONFIG.net.reconnect.snapStarvationMs) startReconnect();
    }
    if (st.running) {
      sysFx(st, dt); // advance client-spawned particles/blood/damage text
      decayFlash(dt); // decay the per-viewer damage flash (was stepSim's job pre-DO)
      clientAmbience(dt); // dread / heartbeat / groan from the snapshot world
    }
    if (live) sysCamera(st, dt);

    // reconcile the shop overlay with shopOpen (client-local overlay state).
    if (st.running) syncShopUI();

    if (spritesLoaded) draw();
    audioLoops(); // looping ambience/rummage — driven here (runs even while paused) in all modes
    if (st.running) updateHUD();

    // options panel: force-close on state transitions (gameover/shop) so it's never left stranded.
    if (settingsOpen && (isShopOpen() || !el("over").classList.contains("hidden"))) closeSettings();

    // ?netlog: live net-stat readout to drive feel-tuning
    if (NETLOG) {
      const showNet = st.running;
      netstat.style.display = showNet ? "block" : "none";
      if (showNet) {
        netAcc += dt;
        if (netAcc >= 0.25) {
          netAcc = 0;
          const s = Net.client?.netStats();
          if (s) {
            netstat.textContent = `RTT ${s.rtt}ms · loss ${s.loss}% · reord ${s.reorders} · frz ${s.freeze}% · jit ${s.jitter}ms · snap ${s.interval}ms`;
          }
        }
      }
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // PHASE 1 (no gesture needed): cover the canvas with the opaque #loading overlay and skip the
  // world draw until the sprite atlas is ready, so the first frames are never broken/incomplete.
  hide("start");
  show("loading");
  try {
    await Renderer.spritesReady();
  } catch {
    showLoadError("Failed to load game graphics. Please reload the page.");
    return;
  }
  spritesLoaded = true;
  hide("loading");
  show("start");
}

// Tab close / navigate away: best-effort teardown so the server sees us drop immediately
// instead of holding a ghost connection until a timeout.
window.addEventListener("pagehide", () => endCoop());

void main().catch(() => showLoadError("Failed to start the game. Please reload the page."));
