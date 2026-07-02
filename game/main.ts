import "./style.css";
import { CONFIG } from "./config";
import { PLAYER_COLORS } from "./data/players";
import { Audio } from "./engine/audio";
import { localPlayer } from "./engine/players";
import { Renderer } from "./engine/renderer";
import {
  audioLoops,
  clientAmbience,
  closeArsenal,
  deployPlace,
  draftReroll,
  draftTake,
  draw,
  getState,
  openArsenal,
  renderArsenal,
  shopDeploy,
  startGame,
  syncShopUI,
  togglePause,
  toTitle,
  update,
  updateHUD,
} from "./game";
import { Input } from "./input";
import {
  type ClientLobbyDisplayState,
  clientLobbyWaitModel,
  hostLobbyWaitModel,
  type LobbyWaitModel,
  type LobbyWaitSlot,
} from "./lobbyWait";
import { Client } from "./net/client";
import { Host } from "./net/host";
import { sampleLocalInput } from "./net/localInput";
import { Net } from "./net/net";
import { emptyInput } from "./net/playerInput";
import { listRooms, type RoomInfo, selectQuickMatch, versionMatches } from "./net/registry";
import { bumpCoopEpoch, coopEpoch, isCoopEpochCurrent } from "./net/session";
import { type HostRoom, hostRoom, joinRoom, rejoinRoom } from "./net/signaling";
import { startTicker } from "./net/ticker";
import { getTurnStatus, NETLOG, type PeerLink } from "./net/transport";
import { getSettings, setAimAssist } from "./settings";
import { sysCamera } from "./systems/camera";
import { sysFx } from "./systems/fx";
import { assertNever, el, hide, isEditableTarget, renderList, show } from "./ui";

// host lobby gate: host builds the world on "Host co-op" but the sim stays frozen
// (no day countdown / no spawns) until the host presses Start — see wireCoop()/frame().
let hostStarted = false;

// client reconnect (P4): the room code to rejoin on a drop (null = solo / host, neither of
// which can auto-reconnect), and a re-entrancy guard so the watchdog fires one loop.
let coopRoomCode: string | null = null;
let reconnecting = false;

// Client-side lobby connection lifecycle (room-code join). Makes the previously-implicit
// joining/linking/connected/failure states explicit so setClientLobby owns the lobby status text
// and squad in one place. Scope is the lobby only: once the host deploys, startClientGame hides the
// lobby and Net.mode + state.running become the source of truth.
type ClientLobby = ClientLobbyDisplayState;
// Q-to-place: a small local cooldown so a held/mashed key doesn't fire several reliable place
// requests before the host's snapshot reflects the first (each would consume another queued item).
let lastPlaceAt = -1e9;

// public-room registry (D): the active host's signaling handle + whether it's listed publicly.
// Read by the Worker-clock tick to push registry meta (so a backgrounded public host isn't pruned).
let coopHostHandle: HostRoom | null = null;
let coopPublic = false;
// OPEN RAIDS poll interval id (0 = not polling). Module scope so endCoop() can stop it.
let coopPollTimer = 0;

// personal options overlay (#settings): client-local, separate from the host-authoritative
// pause. While open, local input is zeroed (so you don't act blind behind the overlay) and
// single-player freezes the sim; co-op can't pause the shared sim, so you're idle/vulnerable.
let settingsOpen = false;

/** Stored reconnect identity for a room (written from each Hello; replayed on rejoin). */
function loadRejoinToken(code: string): { pid: number; nonce: string } | null {
  try {
    const s = sessionStorage.getItem(`q_rejoin_${code}`);
    return s ? (JSON.parse(s) as { pid: number; nonce: string }) : null;
  } catch {
    return null;
  }
}

const delayMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Drive the reconnect loop after the client's link goes silent. Suspends the existing Client
 * (keeping the running game view), then backs off through rejoinRoom attempts. On a re-open we
 * rebind the SAME Client to the new link (replaying our rejoin token so the host re-attaches our
 * held body); a terminal result (host gone) or an exhausted ladder ends the session → title.
 */
async function reconnectClient(code: string): Promise<void> {
  if (reconnecting) return;
  reconnecting = true;
  const epoch = coopEpoch(); // a lobby/tab close during the backoff must abort the rebind
  Net.client?.suspend();
  const overlay = el("reconnect");
  const sub = el("reconnect-sub");
  overlay.classList.add("show");
  const ladder = CONFIG.net.reconnect.backoffMs;
  for (let i = 0; i < ladder.length; i++) {
    sub.textContent = `attempt ${i + 1} of ${ladder.length}…`;
    const res = await rejoinRoom(code);
    if (!isCoopEpochCurrent(epoch)) {
      if (res.status === "open") res.link.close(); // teardown won mid-attempt — drop the fresh link
      return; // endCoop() already reset reconnecting + the overlay
    }
    if (res.status === "open") {
      Net.client?.rebind(res.link, loadRejoinToken(code));
      overlay.classList.remove("show");
      reconnecting = false;
      return;
    }
    if (
      res.status === "nohost" ||
      res.status === "hostgone" ||
      res.status === "full" ||
      res.status === "versionMismatch"
    )
      break;
    // retryable (timeout/unreachable): the host may be briefly unreachable (NAT blip) — back off
    await delayMs(ladder[i] ?? 1000);
    if (!isCoopEpochCurrent(epoch)) return; // teardown during the backoff — stop retrying
  }
  // gave up: end the client session and return to title (method C: no host = no session)
  endCoop(); // closes the suspended link, clears the overlay, resets Net + session vars
  toTitle();
}

/**
 * The single terminal teardown for a co-op session. Every way of leaving co-op for good — lobby
 * Back, game-over restart, tab close, reconnect give-up, or starting a solo run — routes here.
 * Bumps the session epoch first so any in-flight join/quickMatch/reconnect sees itself as stale and
 * bails (closing whatever link it obtained). Then disposes host/client links, closes the signaling
 * handle, stops timers, and resets every session var to the single-player baseline. Idempotent.
 */
function endCoop(): void {
  bumpCoopEpoch();
  Net.host?.dispose();
  Net.client?.dispose();
  coopHostHandle?.close();
  coopHostHandle = null;
  coopPublic = false;
  if (coopPollTimer) {
    clearInterval(coopPollTimer);
    coopPollTimer = 0;
  }
  reconnecting = false;
  el("reconnect").classList.remove("show");
  Net.mode = "single";
  Net.host = null;
  Net.client = null;
  hostStarted = false;
  coopRoomCode = null;
}

/** Solo Start: tear down any lingering co-op session, then build the single-player world. */
function startSingleRun(): void {
  endCoop();
  startGame();
}

/** Host Deploy: build the world and start the authoritative sim/broadcast for connected peers. */
function startHostRun(host: Host): void {
  startGame(); // builds the fresh world + shows the HUD (hides the lobby)
  host.start(); // spawn a player for everyone already connected
  hostStarted = true; // frame loop now sims + broadcasts
}

function main(): void {
  const canvas = el<HTMLCanvasElement>("game");
  Renderer.init(canvas);
  Input.init(canvas);

  el("startBtn").onclick = startSingleRun;
  el("restartBtn").onclick = () => {
    endCoop(); // game-over → title must fully drop any co-op mode/links (was leaking a ghost peer)
    toTitle();
  };
  el("deployBtn").onclick = shopDeploy;
  el("arsenalBtn").onclick = openArsenal;
  el("arsenalBackBtn").onclick = closeArsenal;
  renderArsenal(); // populate the ARSENAL overlay on first load
  wireCoop();

  const cross = el("cross");
  const muteTag = el("mute");
  const netstat = el("netstat"); // ?netlog co-op net-stat readout
  let netAcc = 0;

  // --- options / settings panel (#settings): personal, client-local. Reused from the title
  // (Options button) and in-game (O key). All wiring lives here so the mute toggle, the M
  // hotkey, and the #mute tag share one refresh closure (no display drift). ---
  const refreshMute = (): void => {
    muteTag.textContent = Audio.isMuted() ? "♪ muted [M]" : "";
  };
  const refreshSettings = (): void => {
    el("settingAimAssist").textContent = getSettings().aimAssist ? "ON" : "OFF";
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
  el("settingAimAssist").onclick = () => {
    setAimAssist(!getSettings().aimAssist);
    refreshSettings();
    Audio.ui(true);
  };
  el("settingMute").onclick = () => {
    Audio.toggleMute();
    refreshMute();
    refreshSettings();
    Audio.ui(true);
  };

  addEventListener("keydown", (e) => {
    // Typing into a text field (the lobby room-code input) must not
    // trigger game hotkeys — e.g. M would otherwise toggle mute mid-type.
    if (isEditableTarget(e.target)) return;
    const state = getState();
    if (e.code === "KeyM") {
      Audio.toggleMute();
      refreshMute();
      refreshSettings(); // keep the options-panel mute label in sync if it's open
      return;
    }
    // ?netlog test hooks for the reconnect path: J drops the client link (→ full reconnect),
    // K pauses host broadcasts ~4s (→ snap-only stall, which the rel-health gate must NOT
    // reconnect on). Gated on NETLOG so they're inert in normal play.
    if (NETLOG && e.code === "KeyJ" && Net.mode === "client") {
      Net.client?.debugDrop();
      return;
    }
    if (NETLOG && e.code === "KeyK" && Net.mode === "host") {
      Net.host?.pauseBroadcast(4000);
      return;
    }
    if (state.inShop) {
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
    // (alive, running, not in the shop [early-returned above], options, or reconnecting) and
    // throttle (ignore auto-repeat + a short cooldown) to avoid multi-placing on a held key.
    if (e.code === "KeyQ" && state.running && !settingsOpen && !reconnecting) {
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

  const step = 1 / CONFIG.simHz;
  const sendStep = 1 / CONFIG.net.sendHz;

  // --- host authoritative loop: driven by a background-immune Web Worker tick, so the
  // host keeps simulating + broadcasting even when its tab is hidden (rAF would pause,
  // freezing every client). onTick runs on the main thread → full DOM/Input access. ---
  let hLast = performance.now();
  let hAcc = 0;
  let hNet = 0;
  let hMeta = 0;
  let tick = 0;
  startTicker(1000 / CONFIG.simHz, () => {
    const now = performance.now();
    const dt = Math.min((now - hLast) / 1000, 0.1);
    hLast = now;
    // public-room registry heartbeat: refresh our listing on the Worker clock (NOT a main-thread
    // timer) so a backgrounded public host isn't throttled into a TTL prune. Runs in the lobby too
    // (phase "lobby") so the room is browsable before deploy. See signaling/room.ts meta handling.
    if (Net.mode === "host" && coopHostHandle) {
      hMeta += dt;
      if (hMeta >= CONFIG.net.registryMetaMs / 1000) {
        hMeta = 0; // periodic heartbeat (the initial publish is flushed on the signaling WS open)
        const gs = getState();
        coopHostHandle.setMeta({
          public: coopPublic,
          phase: hostStarted ? gs.phase : "lobby",
          day: gs.day,
          players: Net.host?.playerCount() ?? 1, // authoritative: occupied slots + host (= the cap)
        });
      }
    } else {
      hMeta = 0;
    }
    if (Net.mode !== "host" || !hostStarted) {
      hAcc = 0;
      hNet = 0;
      return; // only the running host sims here; single/client/lobby do not
    }
    const st = getState();
    // host sim can't pause for one player; while our options panel is open we still send
    // zeroed input so our character stands idle (not acting blind behind the overlay)
    if (st.running && !st.paused)
      localPlayer(st).input = settingsOpen ? emptyInput() : sampleLocalInput(st);
    hAcc += dt;
    while (hAcc >= step) {
      update(step);
      hAcc -= step;
    }
    hNet += dt;
    if (hNet >= sendStep) {
      hNet = 0;
      Net.host?.broadcast(tick++);
    }
    Net.host?.tickGrace(now); // retire held bodies of clients who never reconnected (P4)
  });

  // --- render loop (rAF): draws always; runs single-player sim + client input/camera.
  // Host sim/broadcast is NOT here (it's on the worker tick above) so backgrounding the
  // host tab only pauses its rendering, never the shared simulation. ---
  let rLast = performance.now();
  let rAcc = 0;
  function frame(now: number): void {
    const dt = (now - rLast) / 1000;
    rLast = now;
    const st = getState();
    const live = st.running && !st.paused;

    if (Net.mode === "single") {
      // options panel open → freeze the SP sim entirely (don't accumulate dt, so there's no
      // fast-forward catch-up on resume). state.paused is left untouched (avoids clashing
      // with shop/gameover and the Esc-pause handler).
      if (!settingsOpen) {
        rAcc += Math.min(dt, 0.1);
        if (live) localPlayer(st).input = sampleLocalInput(st);
        while (rAcc >= step) {
          update(step);
          rAcc -= step;
        }
      }
    } else if (Net.mode === "client") {
      // no authoritative sim — predict our player, interpolate the world, ship input.
      // While options is open, send zeroed input so the host holds us idle (not acting blind).
      const inp = live ? (settingsOpen ? emptyInput() : sampleLocalInput(st)) : null;
      if (inp) Net.client?.send(inp);
      Net.client?.render(performance.now(), inp, dt);
      if (st.running) {
        sysFx(st, dt); // advance client-spawned particles/blood/damage text
        clientAmbience(dt); // dread / heartbeat / groan from the snapshot world
      }
      if (live) sysCamera(st, dt);
      // reconnect watchdog: both channels silent past snapStarvationMs = a dead link → reconnect.
      // Armed only while a run is live (a client always has a room code to rejoin with);
      // the host keeps broadcasting through pause/shop so quiet snaps mean a real drop.
      if (
        coopRoomCode &&
        !reconnecting &&
        st.running &&
        Net.client &&
        now - Net.client.lastActivityMs() > CONFIG.net.reconnect.snapStarvationMs
      ) {
        void reconnectClient(coopRoomCode);
      }
    }
    // host: rendering only here; sim + broadcast run on the worker tick

    // reconcile the shop overlay with state.inShop (all modes; clients open it from the
    // snapshot). After the sim/render step so single-player opens it the same frame.
    if (st.running) syncShopUI();

    draw();
    audioLoops(); // looping ambience/rummage — driven here (runs even while paused) in all modes
    if (st.running) updateHUD();

    // options panel: force-close on state transitions (gameover/shop/reconnect) so it's never
    // left stranded, and suppress the pause overlay underneath it so the two never stack.
    // force-close only when a competing game overlay takes over: shop, reconnect, or gameover
    // (#over shown). NOT on the title — there running is also false but options must stay open.
    if (settingsOpen && (st.inShop || reconnecting || !el("over").classList.contains("hidden")))
      closeSettings();
    if (settingsOpen) hide("pause");

    // ?netlog: live co-op net-stat readout (client only) to drive feel-tuning
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

    // custom crosshair (hidden while downed — you're spectating, not aiming — or reconnecting)
    if (st.running && !st.paused && !reconnecting && !settingsOpen && localPlayer(st).hp > 0) {
      const me = localPlayer(st);
      cross.style.opacity = "1";
      cross.style.transform = `translate(${Input.mouseX}px,${Input.mouseY}px)`;
      cross.classList.toggle("empty", me.dryT > 0);
      cross.classList.toggle("fire", Input.firing && me.reloadT <= 0 && me.dryT <= 0);
      cross.classList.toggle("reload", me.reloadT > 0);
    } else {
      cross.style.opacity = "0";
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ------------------------- co-op lobby ------------------------- */
// Room-code auto-connect is the only client path (offer/answer brokered by the signaling
// relay, see net/signaling.ts). The game world only appears on Deploy (host) /
// first snapshot (client) — the lobby never shows the live world.

/** A short, human-friendly room code (no ambiguous I/O/0/1/L). */
function makeRoomCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function wireCoop(): void {
  const role = el("lobby-role");
  const guide = el("lobby-guide");
  const roomHost = el("lobby-room-host");
  const roomJoin = el("lobby-room-join");
  const roomCode = el<HTMLInputElement>("lobby-room-code");
  const roomInput = el<HTMLInputElement>("lobby-room-input");
  const roomGo = el<HTMLButtonElement>("lobby-room-go");
  const squad = el("lobby-squad");
  squad.classList.add("squad-row"); // flex layout for the chips renderList drops in directly
  const status = el("lobby-status");
  const deploy = el("lobby-deploy");
  const wait = el("lobby-wait");

  let lastClientLobbyState: ClientLobby | null = null;
  let lobbyKind: "host" | "join" = "join"; // set in openLobby(); gates the room-code entry row
  let joinAbort: AbortController | null = null; // in-flight room-code attempt (abort to abandon it)

  // status with an optional "connecting" pulse dot (CSS .busy::after)
  const setStatus = (text: string, busy = false): void => {
    status.textContent = text;
    status.classList.toggle("busy", busy);
  };
  // budget-aware connect-failure text: when the monthly TURN budget is exhausted, cross-NAT peers
  // can't relay — name that instead of a generic NAT message. prod-only (dev is always STUN-only).
  const failMsg = (generic: string): string =>
    getTurnStatus() === "budget-reached"
      ? "Relay at capacity this month — only same-network players can connect right now."
      : generic;
  // squad as colored chips (matches the in-game PLAYER_COLORS so teammates are recognizable)
  const chipColor = (pid: number): string => {
    const [r, g, b] = PLAYER_COLORS[pid % PLAYER_COLORS.length] ?? [0.49, 1, 0.31];
    return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  };
  const makeSlotChip = ({ pid, label, state }: LobbyWaitSlot): HTMLElement => {
    const chip = document.createElement("span");
    chip.className = "squad-chip";
    chip.classList.toggle("empty", state === "empty");
    chip.classList.toggle("unknown", state === "unknown");
    const dot = document.createElement("span");
    dot.className = "squad-dot";
    if (pid !== undefined && state === "filled") dot.style.background = chipColor(pid);
    const name = document.createElement("span");
    name.textContent = label;
    chip.append(dot, name);
    return chip;
  };
  const renderLobbySlots = (slots: readonly LobbyWaitSlot[]): void => {
    renderList(
      squad,
      slots,
      (slot, i) => `${i}:${slot.label}:${slot.state}:${slot.pid ?? "x"}`,
      makeSlotChip,
    );
  };
  const renderLobbyWait = (model: LobbyWaitModel): void => {
    wait.className = `lobby-wait tone-${model.tone}`;
    const stepper = document.createElement("div");
    stepper.className = "lobby-stepper";
    model.steps.forEach((step, i) => {
      const item = document.createElement("div");
      item.className = `lobby-step is-${step.state}`;
      const node = document.createElement("div");
      node.className = "lobby-step-node";
      node.textContent = step.state === "done" ? "✓" : String(i + 1);
      const title = document.createElement("div");
      title.className = "lobby-step-title";
      title.textContent = step.label;
      const detail = document.createElement("div");
      detail.className = "lobby-step-detail";
      detail.textContent = step.detail;
      item.append(node, title, detail);
      stepper.append(item);
    });

    const card = document.createElement("div");
    card.className = "lobby-wait-card";
    const title = document.createElement("div");
    title.className = "lobby-wait-title";
    title.textContent = model.headline;
    const detail = document.createElement("div");
    detail.className = "lobby-wait-detail";
    detail.textContent = model.detail;
    card.append(title, detail);

    wait.replaceChildren(stepper, card);
    renderLobbySlots(model.slots);
  };

  // Sole writer of the room-code entry-row visibility (I1): a pure function of lobby state. The row
  // shows only in Join mode, and only when idle or in a retryable state (null / failed / lost) —
  // hidden while actively connecting or connected.
  const syncEntryVisibility = (): void => {
    const k = lastClientLobbyState?.k;
    const busy = k === "joining" || k === "linking" || k === "connected";
    roomJoin.style.display = lobbyKind === "join" && !busy ? "flex" : "none";
  };

  const setClientLobby = (s: ClientLobby): void => {
    lastClientLobbyState = s;
    renderLobbyWait(clientLobbyWaitModel(s));
    switch (s.k) {
      case "joining":
        setStatus("connecting via relay…", true); // squad already cleared by openLobby
        break;
      case "linking":
        setStatus("establishing P2P link…", true);
        break;
      case "connected":
        setStatus("connected — waiting for host to deploy");
        break;
      case "failed":
        setStatus(s.msg); // no fallback panel — the message + an enabled Join button drive the retry
        break;
      case "lost":
        setStatus(s.msg);
        break;
      default:
        assertNever(s);
    }
    syncEntryVisibility();
  };

  const openLobby = (kind: "host" | "join"): void => {
    hide("start");
    hide("coop");
    show("lobby");
    roomHost.style.display = kind === "host" ? "flex" : "none";
    deploy.style.display = "none";
    squad.replaceChildren();
    wait.replaceChildren();
    setStatus("");
    lobbyKind = kind;
    syncEntryVisibility(); // sole writer of the room-code entry-row visibility
  };
  const closeLobby = (): void => {
    endCoop(); // disposes host/client links (host: no ghost peer; client: host sees us drop) + resets
    hide("lobby");
    openCoopHub(); // back to the hub (you entered the lobby from there)
  };
  el("lobby-back").onclick = closeLobby;
  el("lobby-room-copy").onclick = () => {
    roomCode.select();
    navigator.clipboard?.writeText(roomCode.value).catch(() => {});
  };

  // ---- HOST (public/private) ----
  const openHostLobby = (isPublic: boolean): void => {
    openLobby("host");
    role.textContent = "Hosting";
    guide.textContent = isPublic
      ? "Open to anyone via Quick Match — or share the code. Deploy when ready."
      : "Share the room code with your squad, then Deploy.";
    const host = new Host();
    Net.mode = "host";
    Net.host = host;
    hostStarted = false;
    // public-listing toggle (drives the registry meta pushed from the host tick)
    coopPublic = isPublic;
    const pub = el<HTMLInputElement>("lobby-public");
    pub.checked = isPublic;
    pub.onchange = () => {
      coopPublic = pub.checked;
      // reflect the change in the registry now (don't wait for the next heartbeat)
      const gs = getState();
      coopHostHandle?.setMeta({
        public: coopPublic,
        phase: hostStarted ? gs.phase : "lobby",
        day: gs.day,
        players: (Net.host?.connectedPids().length ?? 0) + 1, // host + decided clients
      });
      refreshSquad();
    };

    const refreshSquad = (): void => {
      renderLobbyWait(
        hostLobbyWaitModel({
          isPublic: coopPublic,
          peerPids: host.connectedPids(),
        }),
      );
    };
    host.onRoster = refreshSquad; // the host is the single source of truth for the squad badges —
    // refresh from its authoritative roster changes (every peer path, incl. grace expiry/reconnect),
    // NOT from incidental link/signaling events that fire before the host updates its peer state.
    refreshSquad();
    deploy.style.display = "inline-block";
    deploy.textContent = "Deploy raid";
    deploy.onclick = () => startHostRun(host);

    const code = makeRoomCode();
    roomCode.value = code;
    setStatus(
      isPublic ? "public raid open — others can find you" : "private room — share the code",
    );
    coopHostHandle = hostRoom(
      code,
      (link) => host.add(link),
      (s) => {
        if (s.error) setStatus(`signaling: ${s.error} — try again`);
      },
    );
    // seed the listing now; buffered in hostRoom and flushed the instant the signaling WS opens
    coopHostHandle.setMeta({
      public: isPublic,
      phase: "lobby",
      day: 1,
      players: (Net.host?.connectedPids().length ?? 0) + 1,
    });
  };

  // The single guarded "become a client" write-back. Every join path (room-code, quick match)
  // routes here so a teardown mid-await can't resurrect a dead session: if the captured
  // epoch is stale, close the freshly-obtained link and bail instead of wiring it into Net.
  const becomeClient = (
    epoch: number,
    link: PeerLink,
    code: string | null,
    hooks?: ConstructorParameters<typeof Client>[2],
  ): Client | null => {
    if (!isCoopEpochCurrent(epoch)) {
      try {
        link.close(); // user left during the join await — drop the link so the host sees no ghost
      } catch {
        /* already closing — ignore */
      }
      return null;
    }
    Net.mode = "client";
    coopRoomCode = code; // arm the reconnect watchdog with the room to rejoin on a drop
    const client = new Client(link, undefined, hooks);
    Net.client = client;
    return client;
  };

  // NON-terminal: a client attempt failed but the player stays in the flow (lobby stays open to
  // retry). Drop the dead client link + reset transient client state without a full endCoop().
  // Clears Net.client BEFORE dispose() so a synchronous re-entrant onClose sees no client and the
  // attempt-local `settled` latch (set by the caller) already suppresses the fallback.
  const abandonClientAttempt = (epoch: number): void => {
    if (!isCoopEpochCurrent(epoch)) return; // a real teardown already owns Net — don't fight it
    const client = Net.client;
    Net.client = null;
    Net.mode = "single";
    coopRoomCode = null; // disarm the reconnect watchdog for the abandoned room
    client?.dispose();
  };

  // NON-terminal transition: the quick-match join didn't pan out → abandon any in-flight client
  // attempt (drops its link + resets coopRoomCode/Net.mode), then become a public host.
  // (openHostLobby sets Net.mode = "host" and builds the Host.) Callers MUST set their attempt-local
  // `settled` latch BEFORE calling this so the link.close() inside abandonClientAttempt can't
  // re-enter the same fallback via onClose.
  const beginPublicHostFromQuickMatch = (epoch: number): void => {
    if (!isCoopEpochCurrent(epoch)) return; // teardown won — stay torn down
    abandonClientAttempt(epoch); // dispose the in-flight client link + reset transient client state
    if (!isCoopEpochCurrent(epoch)) return; // dispose's re-entrant onClose could have torn us down
    openHostLobby(true);
  };

  // ---- JOIN (by code; also used by an Open Raids row with a prefilled code) ----
  // I2 arbitration: abandon any in-flight room-code attempt so only one client connection flow is
  // ever live. Bumping the epoch cancels cross-await write-backs; aborting joinAbort closes joinRoom's
  // internal signaling socket immediately (in the pre-offer window no PeerLink exists yet, so epoch
  // alone can't reach it); disposing Net.client covers the post-offer window. Idempotent — safe to
  // call when nothing is live.
  const resetJoinEntry = (): void => {
    bumpCoopEpoch();
    joinAbort?.abort();
    joinAbort = null;
    Net.client?.dispose();
    Net.client = null;
    Net.mode = "single";
    coopRoomCode = null; // disarm the reconnect watchdog for the abandoned room
    lastClientLobbyState = null;
    roomGo.disabled = false;
  };

  const openJoinLobby = (prefill?: string): void => {
    resetJoinEntry(); // abandon any lingering attempt BEFORE openLobby (endCoop leaves this local state)
    openLobby("join");
    role.textContent = "Joining";
    guide.textContent = "Enter the host's room code to connect.";
    roomInput.value = prefill ?? "";
    roomInput.focus();
    // Note: resetJoinEntry() above re-enables roomGo and clears lastClientLobbyState for this fresh
    // entry (the re-entry guard is left set after a successful connect; Back doesn't clear it).

    // The room-code attempt's P2P-open timeout. Lifted to the lobby scope (not local to join) so a
    // Back / fresh lobby re-entry can cancel it — otherwise a pending timer fires
    // setClientLobby({failed}) over a superseded flow, clobbering its status.
    let failTimer: ReturnType<typeof setTimeout> | undefined;

    const join = async (): Promise<void> => {
      const code = roomInput.value.trim().toUpperCase(); // idFromName is case-sensitive
      if (!code || roomGo.disabled) return; // re-entry guard: ignore double-click / Enter spam
      roomGo.disabled = true;
      const epoch = coopEpoch(); // cancel our write-backs if the player leaves during the await
      joinAbort = new AbortController(); // lets resetJoinEntry close joinRoom's socket in the pre-offer window
      // Attempt-local latch: the FIRST terminal outcome (roomfull / timeout / link-close failure)
      // wins and every later one no-ops. This subsumes the old `rejected` flag and makes the flow
      // safe against re-entrant onClose firing when abandonClientAttempt() closes the link.
      let settled = false;
      lastClientLobbyState = null;
      setClientLobby({ k: "joining" });
      try {
        const link = await joinRoom(code, joinAbort.signal);
        const client = becomeClient(epoch, link, code, {
          // persist our reconnect identity each Hello so a drop can rejoin the same slot
          onIdentity: (pid, nonce) => {
            try {
              sessionStorage.setItem(`q_rejoin_${code}`, JSON.stringify({ pid, nonce }));
            } catch {
              /* sessionStorage unavailable — reconnect just falls back to a fresh slot */
            }
          },
          // host turned us away: room is full. Terminal — surface a clear message and re-enable Join
          // so the player can try a different code.
          onRoomFull: () => {
            if (settled || !isCoopEpochCurrent(epoch)) return; // stale/already-settled — ignore
            settled = true;
            clearTimeout(failTimer); // roomfull can arrive before/around open → don't let the
            // NAT-timeout later clobber this terminal message with a "failed"
            abandonClientAttempt(epoch); // reset client mode + dispose the refused link (nulls
            // coopRoomCode too, so we don't reconnect to a room we were turned away from)
            setClientLobby({
              k: "lost",
              step: "host",
              msg: "room is full — the squad is already at capacity (4).",
            });
            roomGo.disabled = false;
          },
        });
        if (!client) {
          roomGo.disabled = false; // player left during the await → re-enable Join for a future visit
          return; // becomeClient already closed the link
        }
        setClientLobby({ k: "linking" });
        // joinRoom resolves when our ANSWER is sent, NOT when the P2P link actually opens. A
        // blocked NAT/firewall (e.g. a corporate network) then fails silently. Confirm a real
        // open via link.onOpen, surface link.onClose, and time out otherwise — so the player
        // sees "couldn't connect" instead of sitting forever on a misleading "connected".
        let opened = false;
        failTimer = setTimeout(() => {
          if (opened || settled || !isCoopEpochCurrent(epoch)) return;
          settled = true;
          abandonClientAttempt(epoch); // close the never-opened link so the host sees no ghost
          roomGo.disabled = false;
          setClientLobby({
            k: "failed",
            step: "link",
            msg: failMsg(
              "couldn't connect (network/NAT). Check the code, or try a personal device/network.",
            ),
          });
        }, CONFIG.net.p2pOpenTimeoutMs);
        link.onOpen(() => {
          if (!isCoopEpochCurrent(epoch)) return;
          opened = true;
          clearTimeout(failTimer);
          setClientLobby({ k: "connected" });
        });
        link.onClose(() => {
          if (!isCoopEpochCurrent(epoch)) return; // teardown already closed us — don't touch the UI
          clearTimeout(failTimer);
          if (settled) return; // roomfull/timeout already rendered the terminal outcome
          settled = true;
          roomGo.disabled = false;
          setClientLobby(
            opened
              ? { k: "lost", step: "host", msg: "disconnected from host." }
              : {
                  k: "failed",
                  step: "link",
                  msg: failMsg(
                    "connection failed (network/NAT) — check the code or try a personal device/network.",
                  ),
                },
          );
        });
      } catch (err) {
        if (!isCoopEpochCurrent(epoch)) return; // lobby left / superseded — don't clobber it
        roomGo.disabled = false;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "host is on a different version — update to play together") {
          setClientLobby({ k: "lost", step: "host", msg });
          return;
        }
        if (msg === "room is full") {
          setClientLobby({
            k: "lost",
            step: "host",
            msg: "room is full — the squad is already at capacity (4).",
          });
          return;
        }
        setClientLobby({
          k: "failed",
          step: "room",
          msg: `${msg} — check the code and try again`,
        });
      }
    };
    roomGo.onclick = () => void join();
    roomInput.onkeydown = (e) => {
      if (e.key === "Enter") void join();
    };
    if (prefill) void join(); // came from an Open Raids row → connect straight away
  };

  // ---- co-op hub: quick match + a live scan of open public raids ----
  const coopStatus = (text: string, busy = false): void => {
    const s = el("coop-status");
    s.textContent = text;
    s.classList.toggle("busy", busy);
  };
  const stopCoopPoll = (): void => {
    if (coopPollTimer) {
      clearInterval(coopPollTimer);
      coopPollTimer = 0;
    }
  };
  const makeRoomRow = (r: RoomInfo): HTMLElement => {
    const joinable = versionMatches(r) && r.players < r.max;
    const row = document.createElement("div");
    row.className = `coop-row${joinable ? "" : " off"}`;
    const dots = document.createElement("div");
    dots.className = "rdots";
    dots.textContent = "●".repeat(r.players) + "·".repeat(Math.max(0, r.max - r.players));
    const info = document.createElement("div");
    info.className = "rinfo";
    const codeEl = document.createElement("div");
    codeEl.className = "rcode";
    codeEl.textContent = r.code;
    const st = document.createElement("div");
    st.className = "rstatus";
    if (!versionMatches(r)) st.textContent = "update required";
    else if (r.players >= r.max) st.textContent = "full";
    else if (r.phase === "night") {
      st.textContent = `night ${r.day} · spectate`;
      st.classList.add("spectate");
    } else st.textContent = r.phase === "day" ? `day ${r.day}` : "lobby";
    info.append(codeEl, st);
    row.append(dots, info);
    if (joinable) {
      const btn = document.createElement("button");
      btn.className = "btn lobby-btn";
      btn.textContent = "Join";
      btn.onclick = () => {
        stopCoopPoll();
        openJoinLobby(r.code);
      };
      row.append(btn);
    }
    return row;
  };
  // Key drives reuse: include every field makeRoomRow renders, but NOT lastSeen
  // (it ticks every poll and would force a full rebuild — losing Join-button hover).
  const roomKey = (r: RoomInfo): string =>
    `${r.code}:${r.v}:${r.players}:${r.max}:${r.phase}:${r.day}`;
  const renderRooms = (rooms: RoomInfo[] | null): void => {
    const box = el("coop-rooms");
    if (rooms === null) {
      box.innerHTML = `<div class="empty">Room browser unavailable — use Join by code.</div>`;
    } else if (rooms.length === 0) {
      box.innerHTML = `<div class="empty">No signals detected — start your own raid.</div>`;
    } else {
      renderList(box, rooms, roomKey, makeRoomRow);
    }
  };
  const pollRooms = (): void => {
    el("coop-scan").textContent = "↻ scanning…";
    listRooms()
      .then((rooms) => {
        el("coop-scan").textContent = "";
        renderRooms(rooms);
      })
      .catch(() => {
        el("coop-scan").textContent = "";
        renderRooms(null);
      });
  };
  // hoisted (closeLobby above references it) — returns to the hub from the lobby
  function openCoopHub(): void {
    hide("start");
    hide("lobby");
    show("coop");
    coopStatus("");
    el<HTMLButtonElement>("coop-quick").disabled = false; // single re-enable point for the QM guard
    stopCoopPoll();
    pollRooms();
    coopPollTimer = window.setInterval(pollRooms, CONFIG.net.registryPollMs);
  }
  // QUICK MATCH: join the best joinable public raid (randomized among the top few to avoid a
  // pile-up), one short-timeout attempt, else become a public host. Skips the lobby on the join
  // path — the game appears on the first snapshot (startClientGame).
  const quickMatch = async (): Promise<void> => {
    stopCoopPoll();
    el<HTMLButtonElement>("coop-quick").disabled = true; // no re-entry until we leave/return to the hub
    const epoch = coopEpoch(); // cancel our write-backs if the player leaves the hub mid-scan
    // Attempt-local latch: the first fallback-to-host wins; later callbacks (onClose re-entry after
    // the client link is disposed, a late timeout) no-op instead of opening a second host.
    let fellBack = false;
    coopStatus("scanning for raids…", true);
    let rooms: RoomInfo[] = [];
    let registryOk = true;
    try {
      rooms = await listRooms();
    } catch {
      registryOk = false; // browser unreachable → fall through to hosting
    }
    if (!isCoopEpochCurrent(epoch)) return; // left the hub during the scan
    const top = selectQuickMatch(rooms).slice(0, 3);
    const pick = top.length ? top[Math.floor(Math.random() * top.length)] : undefined;
    if (!pick) {
      fellBack = true; // synchronous fallback → latch before calling beginPublicHostFromQuickMatch
      beginPublicHostFromQuickMatch(epoch); // nothing joinable → host a public raid
      setStatus(
        registryOk
          ? "No open raids found — hosting a public one. Others can Quick Match in."
          : "Room browser unavailable — hosting a public raid instead.",
      );
      return;
    }
    coopStatus(`joining ${pick.code}…`, true);
    let link: Awaited<ReturnType<typeof joinRoom>>;
    try {
      link = await joinRoom(pick.code);
    } catch {
      fellBack = true; // synchronous fallback → latch before calling beginPublicHostFromQuickMatch
      beginPublicHostFromQuickMatch(epoch); // couldn't reach it (or version mismatch) → host instead
      setStatus("Couldn't reach that raid — hosting a public one instead.");
      return;
    }
    const code = pick.code;
    const client = becomeClient(epoch, link, code, {
      onIdentity: (pid, nonce) => {
        try {
          sessionStorage.setItem(`q_rejoin_${code}`, JSON.stringify({ pid, nonce }));
        } catch {
          /* sessionStorage unavailable */
        }
      },
      onRoomFull: () => {
        if (fellBack || !isCoopEpochCurrent(epoch)) return;
        fellBack = true;
        clearTimeout(t); // defensive — normally already cleared on open
        beginPublicHostFromQuickMatch(epoch);
        setStatus("This raid is full — hosting a public one instead.");
      },
    });
    if (!client) return; // player left during the await → becomeClient closed the link
    let opened = false;
    const t = window.setTimeout(() => {
      if (opened || fellBack || !isCoopEpochCurrent(epoch)) return;
      fellBack = true;
      beginPublicHostFromQuickMatch(epoch); // didn't connect in time → drop link + host instead
      setStatus(
        getTurnStatus() === "budget-reached"
          ? "Relay at capacity this month — hosting a public raid (same-network players only)."
          : "Couldn't connect in time — hosting a public one instead.",
      );
    }, CONFIG.net.quickMatchTimeoutMs);
    link.onOpen(() => {
      if (!isCoopEpochCurrent(epoch)) return;
      opened = true;
      clearTimeout(t);
      coopStatus("connected — waiting for host to deploy");
    });
    link.onClose(() => {
      if (opened || fellBack || !isCoopEpochCurrent(epoch)) return; // post-open → reconnect watchdog
      fellBack = true;
      clearTimeout(t);
      beginPublicHostFromQuickMatch(epoch);
      setStatus(
        getTurnStatus() === "budget-reached"
          ? "Relay at capacity this month — hosting a public raid (same-network players only)."
          : "Couldn't connect — hosting a public one instead.",
      );
    });
  };

  // ---- title + hub wiring ----
  el("mpCoopBtn").onclick = openCoopHub;
  el("coop-back").onclick = () => {
    endCoop(); // cancel any in-flight quick match + drop a partial client link; also stops the poll
    hide("coop");
    show("start");
  };
  el("coop-quick").onclick = () => void quickMatch();
  el("coop-host").onclick = () => {
    endCoop(); // cancel a pending quick match before starting a fresh host intent
    openHostLobby(true);
  };
  el("coop-joincode").onclick = () => {
    endCoop(); // cancel a pending quick match before opening the join lobby
    openJoinLobby();
  };

  // Tab close / navigate away: best-effort teardown so the host sees us drop immediately (pc.close()
  // sends the DTLS close) instead of holding a ghost peer until the ICE consent timeout. pagehide is
  // the reliable signal on mobile Safari (beforeunload is not); it's best-effort — the OS may kill
  // the tab first — but combined with the reconnect grace it covers the common case.
  window.addEventListener("pagehide", () => endCoop());
}

main();
