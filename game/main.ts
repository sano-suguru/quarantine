import "./style.css";
import { CONFIG } from "./config";
import { PLAYER_COLORS } from "./data/players";
import { Audio } from "./engine/audio";
import { localPlayer } from "./engine/players";
import { Renderer } from "./engine/renderer";
import {
  audioLoops,
  buyItem,
  clientAmbience,
  deployPlace,
  draw,
  getState,
  renderArsenal,
  shopBuySelected,
  shopDeploy,
  shopMove,
  startGame,
  syncShopUI,
  togglePause,
  toTitle,
  update,
  updateHUD,
} from "./game";
import { Input } from "./input";
import { Client } from "./net/client";
import { Host } from "./net/host";
import { sampleLocalInput } from "./net/localInput";
import { Net } from "./net/net";
import { emptyInput } from "./net/playerInput";
import { listRooms, type RoomInfo, selectQuickMatch, versionMatches } from "./net/registry";
import { type HostRoom, hostRoom, joinRoom, rejoinRoom } from "./net/signaling";
import { startTicker } from "./net/ticker";
import { createClientLink, createHostLink, getTurnStatus, NETLOG } from "./net/transport";
import { getSettings, setAimAssist } from "./settings";
import { sysCamera } from "./systems/camera";
import { sysFx } from "./systems/fx";
import { assertNever, el, hide, isEditableTarget, renderList, show } from "./ui";

// host lobby gate: host builds the world on "Host co-op" but the sim stays frozen
// (no day countdown / no spawns) until the host presses Start — see wireCoop()/frame().
let hostStarted = false;

// client reconnect (P4): the room code to rejoin on a drop (null = solo / host / manual-SDP,
// none of which can auto-reconnect), and a re-entrancy guard so the watchdog fires one loop.
let coopRoomCode: string | null = null;
let reconnecting = false;

// Client-side lobby connection lifecycle (room-code + manual-SDP join). Makes the
// previously-implicit joining/linking/connected/failure states explicit so setClientLobby owns
// the lobby status text, squad, and the failure-only manual.open side-effect in one place.
// Scope is the lobby only: once the host deploys, startClientGame hides the lobby and Net.mode +
// state.running become the source of truth.
type ClientLobby =
  | { k: "joining" } // relay handshake (pre-link)
  | { k: "linking" } // P2P open wait (the p2pOpenTimeout window)
  | { k: "connected" } // link open; waiting for the host to deploy
  | { k: "failed"; msg: string } // connect failure → reveal the manual <details> fallback
  | { k: "lost"; msg: string }; // opened then dropped in-lobby / version mismatch → no manual
// Q-to-place: a small local cooldown so a held/mashed key doesn't fire several reliable place
// requests before the host's snapshot reflects the first (each would consume another queued item).
let lastPlaceAt = -1e9;

// public-room registry (D): the active host's signaling handle + whether it's listed publicly.
// Read by the Worker-clock tick to push registry meta (so a backgrounded public host isn't pruned).
let coopHostHandle: HostRoom | null = null;
let coopPublic = false;

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
  Net.client?.suspend();
  const overlay = el("reconnect");
  const sub = el("reconnect-sub");
  overlay.classList.add("show");
  const ladder = CONFIG.net.reconnect.backoffMs;
  for (let i = 0; i < ladder.length; i++) {
    sub.textContent = `attempt ${i + 1} of ${ladder.length}…`;
    const res = await rejoinRoom(code);
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
  }
  // gave up: end the client session and return to title (method C: no host = no session)
  overlay.classList.remove("show");
  reconnecting = false;
  coopRoomCode = null;
  Net.mode = "single";
  Net.host = null;
  Net.client = null;
  hostStarted = false;
  toTitle();
}

function main(): void {
  const canvas = el<HTMLCanvasElement>("game");
  Renderer.init(canvas);
  Input.init(canvas);

  el("startBtn").onclick = () => {
    coopRoomCode = null; // solo: no room to reconnect to (don't arm the client watchdog)
    startGame();
  };
  el("restartBtn").onclick = toTitle;
  el("deployBtn").onclick = shopDeploy;
  renderArsenal(); // populate the title-screen arsenal panel on first load
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
    // Typing into a text field (lobby room-code input, manual-SDP textareas) must not
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
      const digit = /^Digit([1-9])$/.exec(e.code);
      if (digit) buyItem(Number(digit[1]) - 1);
      else if (e.code === "ArrowUp" || e.code === "KeyW") shopMove(-1);
      else if (e.code === "ArrowDown" || e.code === "KeyS") shopMove(1);
      else if (e.code === "Space") shopBuySelected();
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
      // Armed only for room-code sessions (manual-SDP has no code to rejoin with) and while a run
      // is live; the host keeps broadcasting through pause/shop so quiet snaps mean a real drop.
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
// Room-code auto-connect is the primary path (offer/answer brokered by the signaling
// relay, see net/signaling.ts). Manual SDP copy-paste is kept as a zero-dependency
// fallback, tucked into a <details>. The game world only appears on Deploy (host) /
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
  const manual = el<HTMLDetailsElement>("lobby-manual");
  // manual-fallback elements
  const out = el<HTMLTextAreaElement>("lobby-out");
  const inEl = el<HTMLTextAreaElement>("lobby-in");
  const go = el("lobby-go");
  const sendBlock = el("lobby-send");
  const sendLabel = el("lobby-send-label");
  const recvLabel = el("lobby-recv-label");

  let hostHandle: HostRoom | null = null;
  let coopPollTimer = 0; // OPEN RAIDS poll interval id (0 = not polling)

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
  const makeChip = ({ pid, label }: { pid: number; label: string }): HTMLElement => {
    const chip = document.createElement("span");
    chip.className = "squad-chip";
    const dot = document.createElement("span");
    dot.className = "squad-dot";
    dot.style.background = chipColor(pid);
    const name = document.createElement("span");
    name.textContent = label;
    chip.append(dot, name);
    return chip;
  };
  // #lobby-squad carries .squad-row (added above), so chips render directly into it.
  const setSquad = (members: { pid: number; label: string }[]): void => {
    renderList(squad, members, (m) => `${m.pid}:${m.label}`, makeChip);
  };

  // Single owner of the client lobby's status/squad/manual derivation. Every client connection
  // event calls setClientLobby({...}) rather than poking setStatus/manual.open directly, so the
  // failure-only "open the manual fallback" side-effect lives in exactly one place (the `failed`
  // case). `lost` (opened-then-dropped / version mismatch) deliberately does NOT open manual.
  const setClientLobby = (s: ClientLobby): void => {
    switch (s.k) {
      case "joining":
        setStatus("connecting via relay…", true); // squad already cleared by openLobby
        break;
      case "linking":
        setSquad([{ pid: 1, label: "You" }]);
        setStatus("establishing P2P link…", true);
        break;
      case "connected":
        setStatus("connected — waiting for host to deploy");
        break;
      case "failed":
        setStatus(s.msg);
        manual.open = true;
        break;
      case "lost":
        setStatus(s.msg);
        break;
      default:
        assertNever(s);
    }
  };

  const openLobby = (kind: "host" | "join"): void => {
    hide("start");
    hide("coop");
    show("lobby");
    roomHost.style.display = kind === "host" ? "flex" : "none";
    roomJoin.style.display = kind === "join" ? "flex" : "none";
    deploy.style.display = "none";
    squad.replaceChildren();
    setStatus("");
    out.value = "";
    inEl.value = "";
    manual.open = false;
    manual.ontoggle = null;
  };
  const closeLobby = (): void => {
    hostHandle?.close(); // closes the signaling socket → Room DO unlists a public room
    hostHandle = null;
    coopHostHandle = null;
    coopPublic = false;
    Net.mode = "single";
    Net.host = null;
    Net.client = null;
    hostStarted = false;
    coopRoomCode = null; // disarm the reconnect watchdog
    hide("lobby");
    openCoopHub(); // back to the hub (you entered the lobby from there)
  };
  el("lobby-back").onclick = closeLobby;
  el("lobby-room-copy").onclick = () => {
    roomCode.select();
    navigator.clipboard?.writeText(roomCode.value).catch(() => {});
  };
  el("lobby-copy").onclick = () => {
    out.select();
    navigator.clipboard?.writeText(out.value).catch(() => {});
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
      });
    };

    const refreshSquad = (): void => {
      // host is player 0; each connected peer gets its pid's color/number
      setSquad([
        { pid: 0, label: "You (host)" },
        ...host.connectedPids().map((pid) => ({ pid, label: `P${pid + 1}` })),
      ]);
    };
    refreshSquad();
    deploy.style.display = "inline-block";
    deploy.textContent = "Deploy raid";
    deploy.onclick = () => {
      startGame(); // builds the fresh world + shows the HUD (hides this lobby)
      host.start(); // spawn a player for everyone already connected
      hostStarted = true; // frame loop now sims + broadcasts
    };

    const code = makeRoomCode();
    roomCode.value = code;
    setStatus(
      isPublic ? "public raid open — others can find you" : "private room — share the code",
    );
    hostHandle = hostRoom(
      code,
      (link) => host.add(link),
      (s) => {
        refreshSquad();
        if (s.error) setStatus(`signaling: ${s.error} — use manual connect below`);
      },
    );
    coopHostHandle = hostHandle; // the host tick pushes registry meta through this
    // seed the listing now; buffered in hostRoom and flushed the instant the signaling WS opens
    hostHandle.setMeta({ public: isPublic, phase: "lobby", day: 1 });

    // manual fallback: opening <details> hides the room code (so the mode is unambiguous)
    // and lazily builds an offer on first open.
    let manualReady = false;
    manual.ontoggle = (): void => {
      roomHost.style.display = manual.open ? "none" : "flex";
      guide.textContent = manual.open
        ? "Manual connect — share your code, paste their reply."
        : "Share the room code with your squad, then Deploy.";
      if (!manual.open || manualReady) return;
      manualReady = true;
      sendBlock.style.order = "-1"; // your code first, their reply below
      sendLabel.textContent = "Your code — send to a friend";
      recvLabel.textContent = "Their reply — paste it here";
      go.textContent = "Connect";
      void (async () => {
        try {
          const { link, offer, accept } = await createHostLink();
          host.add(link);
          link.onOpen(refreshSquad);
          link.onClose(refreshSquad);
          out.value = offer;
          go.onclick = async () => {
            const c = inEl.value.trim();
            if (!c) return;
            try {
              await accept(c);
              setStatus("manual peer linked ✓");
            } catch {
              setStatus("that reply code didn't parse");
            }
          };
        } catch (err) {
          setStatus(`manual offer failed: ${err}`);
        }
      })();
    };
  };

  // ---- JOIN (by code; also used by an Open Raids row with a prefilled code) ----
  const openJoinLobby = (prefill?: string): void => {
    openLobby("join");
    role.textContent = "Joining";
    guide.textContent = "Enter the host's room code to connect.";
    roomInput.value = prefill ?? "";
    roomInput.focus();

    // The room-code attempt's P2P-open timeout. Lifted to the lobby scope (not local to join) so
    // switching to the manual fallback can cancel it — otherwise a pending timer fires
    // setClientLobby({failed}) over the manual flow, clobbering its status and re-opening <details>.
    let failTimer: ReturnType<typeof setTimeout> | undefined;

    const join = async (): Promise<void> => {
      const code = roomInput.value.trim().toUpperCase(); // idFromName is case-sensitive
      if (!code || roomGo.disabled) return; // re-entry guard: ignore double-click / Enter spam
      roomGo.disabled = true;
      let rejected = false; // roomfull set a terminal message → don't let onClose clobber it
      setClientLobby({ k: "joining" });
      try {
        const link = await joinRoom(code);
        Net.mode = "client";
        coopRoomCode = code; // arm the reconnect watchdog for this room
        Net.client = new Client(link, undefined, {
          // persist our reconnect identity each Hello so a drop can rejoin the same slot
          onIdentity: (pid, nonce) => {
            try {
              sessionStorage.setItem(`q_rejoin_${code}`, JSON.stringify({ pid, nonce }));
            } catch {
              /* sessionStorage unavailable — reconnect just falls back to a fresh slot */
            }
          },
          // host turned us away: room is full. Terminal (manual connect can't get in either), so
          // do NOT open the manual fallback — surface a clear message and re-enable Join so the
          // player can try a different code.
          onRoomFull: () => {
            rejected = true;
            clearTimeout(failTimer); // roomfull can arrive before/around open → don't let the
            // NAT-timeout later clobber this terminal message with a "failed"
            coopRoomCode = null; // don't try to reconnect to a room we were refused from
            setClientLobby({
              k: "lost",
              msg: "room is full — the squad is already at capacity (4).",
            });
            roomGo.disabled = false;
          },
        });
        setClientLobby({ k: "linking" });
        // joinRoom resolves when our ANSWER is sent, NOT when the P2P link actually opens. A
        // blocked NAT/firewall (e.g. a corporate network) then fails silently. Confirm a real
        // open via link.onOpen, surface link.onClose, and time out otherwise — so the player
        // sees "couldn't connect" instead of sitting forever on a misleading "connected".
        let opened = false;
        failTimer = setTimeout(() => {
          if (opened) return;
          roomGo.disabled = false;
          setClientLobby({
            k: "failed",
            msg: failMsg(
              "couldn't connect (network/NAT). Try a personal network, or manual connect below.",
            ),
          });
        }, CONFIG.net.p2pOpenTimeoutMs);
        link.onOpen(() => {
          opened = true;
          clearTimeout(failTimer);
          setClientLobby({ k: "connected" });
        });
        link.onClose(() => {
          clearTimeout(failTimer);
          if (rejected) return; // roomfull already showed the terminal "room is full"
          roomGo.disabled = false;
          setClientLobby(
            opened
              ? { k: "lost", msg: "disconnected from host." }
              : {
                  k: "failed",
                  msg: failMsg("connection failed (network/NAT) — try manual connect below."),
                },
          );
        });
      } catch (err) {
        roomGo.disabled = false;
        setClientLobby({
          k: "failed",
          msg: `${err instanceof Error ? err.message : err} — try manual connect below`,
        });
      }
    };
    roomGo.onclick = () => void join();
    roomInput.onkeydown = (e) => {
      if (e.key === "Enter") void join();
    };
    if (prefill) void join(); // came from an Open Raids row → connect straight away

    // manual fallback: opening <details> hides the room-code input (mode is unambiguous)
    // and lazily wires the paste-host-code → generate-reply flow on first open.
    let manualReady = false;
    manual.ontoggle = (): void => {
      roomJoin.style.display = manual.open ? "none" : "flex";
      guide.textContent = manual.open
        ? "Manual connect — paste the host's code to get a reply."
        : "Enter the host's room code to connect.";
      // Switching to manual abandons the room-code attempt — cancel its timeout so it can't fire
      // setClientLobby({failed}) over the manual flow (clearTimeout(undefined) is a safe no-op).
      if (manual.open) clearTimeout(failTimer);
      if (!manual.open || manualReady) return;
      manualReady = true;
      sendBlock.style.order = ""; // host's code (recv) first, your reply (send) below
      sendBlock.style.display = "none"; // reply revealed once generated
      recvLabel.textContent = "Host's code — paste it here";
      sendLabel.textContent = "Your reply — send it back to the host";
      go.textContent = "Generate reply";
      go.onclick = async () => {
        const offer = inEl.value.trim();
        if (!offer) return;
        try {
          const { link, answer } = await createClientLink(offer);
          Net.mode = "client";
          Net.client = new Client(link, undefined, {
            // manual SDP bypasses the signaling version gate → re-check on Hello
            onVersionMismatch: () => {
              setClientLobby({
                k: "lost",
                msg: "host is on a different version — update to play together",
              });
              link.close();
            },
            // host turned us away: room is full (the client closes its own link on this event)
            onRoomFull: () => {
              setClientLobby({
                k: "lost",
                msg: "room is full — the squad is already at capacity (4).",
              });
            },
          });
          link.onOpen(() => setClientLobby({ k: "connected" }));
          out.value = answer;
          sendBlock.style.display = "flex";
          setStatus("reply ready — send it to the host, then wait");
        } catch {
          setStatus("that host code didn't parse");
        }
      };
    };
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
    coopStatus("scanning for raids…", true);
    let rooms: RoomInfo[] = [];
    let registryOk = true;
    try {
      rooms = await listRooms();
    } catch {
      registryOk = false; // browser unreachable → fall through to hosting
    }
    const top = selectQuickMatch(rooms).slice(0, 3);
    const pick = top.length ? top[Math.floor(Math.random() * top.length)] : undefined;
    if (!pick) {
      openHostLobby(true); // nothing joinable → host a public raid
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
      openHostLobby(true); // couldn't reach it (or version mismatch) → host instead
      setStatus("Couldn't reach that raid — hosting a public one instead.");
      return;
    }
    const code = pick.code;
    Net.mode = "client";
    coopRoomCode = code;
    Net.client = new Client(link, undefined, {
      onIdentity: (pid, nonce) => {
        try {
          sessionStorage.setItem(`q_rejoin_${code}`, JSON.stringify({ pid, nonce }));
        } catch {
          /* sessionStorage unavailable */
        }
      },
    });
    let opened = false;
    const t = window.setTimeout(() => {
      if (opened) return;
      try {
        link.close();
      } catch {
        /* ignore */
      }
      Net.client = null;
      Net.mode = "single";
      coopRoomCode = null;
      openHostLobby(true); // didn't connect in time → host instead
      setStatus(
        getTurnStatus() === "budget-reached"
          ? "Relay at capacity this month — hosting a public raid (same-network players only)."
          : "Couldn't connect in time — hosting a public one instead.",
      );
    }, CONFIG.net.quickMatchTimeoutMs);
    link.onOpen(() => {
      opened = true;
      clearTimeout(t);
      coopStatus("connected — waiting for host to deploy");
    });
    link.onClose(() => {
      if (opened) return; // post-open drops are the reconnect watchdog's job
      clearTimeout(t);
      Net.client = null;
      Net.mode = "single";
      coopRoomCode = null;
      openHostLobby(true);
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
    stopCoopPoll();
    hide("coop");
    show("start");
  };
  el("coop-quick").onclick = () => void quickMatch();
  el("coop-host").onclick = () => {
    stopCoopPoll();
    openHostLobby(true);
  };
  el("coop-joincode").onclick = () => {
    stopCoopPoll();
    openJoinLobby();
  };
}

main();
