import "./style.css";
import { CONFIG } from "../sim/config";
import { WORKBENCH } from "../sim/data/map";
import { localPlayer } from "../sim/engine/players";
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
  togglePause,
  toTitle,
  updateHUD,
} from "./game";
import { Input } from "./input";
import { applyInputMode } from "./inputMode";
import { Client } from "./net/client";
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
  Net.client?.dispose();
  Net.client = null;
}

// True once Phase 1 (sprite load) completes — frame() skips the world draw until then so no
// broken/incomplete frame is shown behind the #loading overlay.
let spritesLoaded = false;
// Re-entry latch for the async Start path: a double-click must not launch two awaits / two runs.
let startingSingleRun = false;

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
  Net.mode = "client";
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
    if (!arenaStarted) {
      clearTimeout(connectTimer);
      showLoadError("Disconnected from the arena.");
    }
  });
  Net.client = new Client(
    link,
    () => {
      arenaStarted = true;
      clearTimeout(connectTimer);
      hide("loading");
    },
    {
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
    const live = st.running && !st.paused;

    if (Net.mode === "client") {
      // no authoritative sim — predict our player, interpolate the world, ship input.
      // While options or the shop overlay is open, send zeroed input so the host holds us idle.
      const inp = live
        ? settingsOpen || isShopOpen()
          ? emptyInput()
          : sampleLocalInput(st)
        : null;
      // throttle input send to ~25 Hz (latest-wins); predict & render still run every frame
      sendAcc += dt;
      if (inp && sendAcc >= inputStep) {
        sendAcc = 0;
        Net.client?.send(inp);
      }
      Net.client?.render(performance.now(), inp, dt);
      if (st.running) {
        sysFx(st, dt); // advance client-spawned particles/blood/damage text
        decayFlash(dt); // decay the per-viewer damage flash (was stepSim's job pre-DO)
        clientAmbience(dt); // dread / heartbeat / groan from the snapshot world
      }
      if (live) sysCamera(st, dt);
    }

    // reconcile the shop overlay with shopOpen (client-local overlay state).
    if (st.running) syncShopUI();

    if (spritesLoaded) draw();
    audioLoops(); // looping ambience/rummage — driven here (runs even while paused) in all modes
    if (st.running) updateHUD();

    // options panel: force-close on state transitions (gameover/shop) so it's never
    // left stranded, and suppress the pause overlay underneath it so the two never stack.
    if (settingsOpen && (isShopOpen() || !el("over").classList.contains("hidden"))) closeSettings();
    if (settingsOpen) hide("pause");

    // ?netlog: live net-stat readout to drive feel-tuning
    if (NETLOG) {
      const showNet = Net.mode === "client" && st.running;
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
