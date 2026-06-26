import { CONFIG } from "./config";
import { PLAYER_COLORS } from "./data/players";
import { Audio } from "./engine/audio";
import { localPlayer } from "./engine/players";
import { Renderer } from "./engine/renderer";
import {
  buyItem,
  clientAmbience,
  draw,
  getState,
  renderArsenal,
  shopBuySelected,
  shopDeploy,
  shopMove,
  startGame,
  startNightNow,
  syncShopUI,
  toTitle,
  togglePause,
  update,
  updateHUD,
} from "./game";
import { Input } from "./input";
import { Client } from "./net/client";
import { Host } from "./net/host";
import { sampleLocalInput } from "./net/localInput";
import { Net } from "./net/net";
import { hostRoom, joinRoom } from "./net/signaling";
import { startTicker } from "./net/ticker";
import { NETLOG, createClientLink, createHostLink } from "./net/transport";
import { sysCamera } from "./systems/camera";
import { sysFx } from "./systems/fx";
import { el, hide, show } from "./ui";

// host lobby gate: host builds the world on "Host co-op" but the sim stays frozen
// (no day countdown / no spawns) until the host presses Start — see wireCoop()/frame().
let hostStarted = false;

function main(): void {
  const canvas = el<HTMLCanvasElement>("game");
  Renderer.init(canvas);
  Input.init(canvas);

  el("startBtn").onclick = startGame;
  el("restartBtn").onclick = toTitle;
  el("deployBtn").onclick = shopDeploy;
  renderArsenal(); // populate the title-screen arsenal panel on first load
  wireCoop();

  const cross = el("cross");
  const muteTag = el("mute");
  const netstat = el("netstat"); // ?netlog co-op net-stat readout
  let netAcc = 0;
  const refreshMute = (): void => {
    muteTag.textContent = Audio.isMuted() ? "♪ muted [M]" : "";
  };
  refreshMute();

  addEventListener("keydown", (e) => {
    const state = getState();
    if (e.code === "KeyM") {
      Audio.toggleMute();
      refreshMute();
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
    if ((e.code === "Escape" || e.code === "KeyP") && state.running) {
      e.preventDefault();
      togglePause();
    }
    if (e.code === "Enter" && state.running) startNightNow();
  });

  const step = 1 / CONFIG.simHz;
  const sendStep = 1 / CONFIG.net.sendHz;

  // --- host authoritative loop: driven by a background-immune Web Worker tick, so the
  // host keeps simulating + broadcasting even when its tab is hidden (rAF would pause,
  // freezing every client). onTick runs on the main thread → full DOM/Input access. ---
  let hLast = performance.now();
  let hAcc = 0;
  let hNet = 0;
  let tick = 0;
  startTicker(1000 / CONFIG.simHz, () => {
    const now = performance.now();
    const dt = Math.min((now - hLast) / 1000, 0.1);
    hLast = now;
    if (Net.mode !== "host" || !hostStarted) {
      hAcc = 0;
      hNet = 0;
      return; // only the running host sims here; single/client/lobby do not
    }
    const st = getState();
    if (st.running && !st.paused) localPlayer(st).input = sampleLocalInput(st);
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
      rAcc += Math.min(dt, 0.1);
      if (live) localPlayer(st).input = sampleLocalInput(st);
      while (rAcc >= step) {
        update(step);
        rAcc -= step;
      }
    } else if (Net.mode === "client") {
      // no authoritative sim — predict our player, interpolate the world, ship input
      const inp = live ? sampleLocalInput(st) : null;
      if (inp) Net.client?.send(inp);
      Net.client?.render(performance.now(), inp, dt);
      if (st.running) {
        sysFx(st, dt); // advance client-spawned particles/blood/damage text
        clientAmbience(dt); // dread / heartbeat / groan from the snapshot world
      }
      if (live) sysCamera(st, dt);
    }
    // host: rendering only here; sim + broadcast run on the worker tick

    // reconcile the shop overlay with state.inShop (all modes; clients open it from the
    // snapshot). After the sim/render step so single-player opens it the same frame.
    if (st.running) syncShopUI();

    draw();
    if (st.running) updateHUD();

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

    // custom crosshair (hidden while downed — you're spectating, not aiming)
    if (st.running && !st.paused && localPlayer(st).hp > 0) {
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
  const roomGo = el("lobby-room-go");
  const squad = el("lobby-squad");
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

  let hostHandle: { close(): void } | null = null;

  // status with an optional "connecting" pulse dot (CSS .busy::after)
  const setStatus = (text: string, busy = false): void => {
    status.textContent = text;
    status.classList.toggle("busy", busy);
  };
  // squad as colored chips (matches the in-game PLAYER_COLORS so teammates are recognizable)
  const chipColor = (pid: number): string => {
    const [r, g, b] = PLAYER_COLORS[pid % PLAYER_COLORS.length] ?? [0.49, 1, 0.31];
    return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  };
  const setSquad = (members: { pid: number; label: string }[]): void => {
    const row = document.createElement("div");
    row.className = "squad-row";
    for (const { pid, label } of members) {
      const chip = document.createElement("span");
      chip.className = "squad-chip";
      const dot = document.createElement("span");
      dot.className = "squad-dot";
      dot.style.background = chipColor(pid);
      const name = document.createElement("span");
      name.textContent = label;
      chip.append(dot, name);
      row.append(chip);
    }
    squad.replaceChildren(row);
  };

  const openLobby = (kind: "host" | "join"): void => {
    hide("start");
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
    hostHandle?.close();
    hostHandle = null;
    Net.mode = "single";
    Net.host = null;
    Net.client = null;
    hostStarted = false;
    hide("lobby");
    show("start");
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

  // ---- HOST ----
  el("mpHostBtn").onclick = () => {
    openLobby("host");
    role.textContent = "Hosting";
    guide.textContent = "Share the room code with your squad, then Deploy.";
    const host = new Host();
    Net.mode = "host";
    Net.host = host;
    hostStarted = false;

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
    setStatus("room open — share the code");
    hostHandle = hostRoom(
      code,
      (link) => host.add(link),
      (s) => {
        refreshSquad();
        if (s.error) setStatus(`signaling: ${s.error} — use manual connect below`);
      },
    );

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

  // ---- JOIN ----
  el("mpJoinBtn").onclick = () => {
    openLobby("join");
    role.textContent = "Joining";
    guide.textContent = "Enter the host's room code to connect.";
    roomInput.value = "";
    roomInput.focus();

    const join = async (): Promise<void> => {
      const code = roomInput.value.trim().toUpperCase(); // idFromName is case-sensitive
      if (!code) return;
      setStatus("connecting via relay…", true);
      try {
        const link = await joinRoom(code);
        Net.mode = "client";
        Net.client = new Client(link);
        setSquad([{ pid: 1, label: "You" }]);
        setStatus("establishing P2P link…", true);
        // joinRoom resolves when our ANSWER is sent, NOT when the P2P link actually opens. A
        // blocked NAT/firewall (e.g. a corporate network) then fails silently. Confirm a real
        // open via link.onOpen, surface link.onClose, and time out otherwise — so the player
        // sees "couldn't connect" instead of sitting forever on a misleading "connected".
        let opened = false;
        const failTimer = setTimeout(() => {
          if (opened) return;
          setStatus(
            "couldn't connect (network/NAT). Try a personal network, or manual connect below.",
          );
          manual.open = true;
        }, CONFIG.net.p2pOpenTimeoutMs);
        link.onOpen(() => {
          opened = true;
          clearTimeout(failTimer);
          setStatus("connected — waiting for host to deploy");
        });
        link.onClose(() => {
          clearTimeout(failTimer);
          setStatus(
            opened
              ? "disconnected from host."
              : "connection failed (network/NAT) — try manual connect below.",
          );
          if (!opened) manual.open = true;
        });
      } catch (err) {
        setStatus(`${err instanceof Error ? err.message : err} — try manual connect below`);
        manual.open = true;
      }
    };
    roomGo.onclick = () => void join();
    roomInput.onkeydown = (e) => {
      if (e.key === "Enter") void join();
    };

    // manual fallback: opening <details> hides the room-code input (mode is unambiguous)
    // and lazily wires the paste-host-code → generate-reply flow on first open.
    let manualReady = false;
    manual.ontoggle = (): void => {
      roomJoin.style.display = manual.open ? "none" : "flex";
      guide.textContent = manual.open
        ? "Manual connect — paste the host's code to get a reply."
        : "Enter the host's room code to connect.";
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
          Net.client = new Client(link);
          link.onOpen(() => setStatus("connected — waiting for host to deploy"));
          out.value = answer;
          sendBlock.style.display = "flex";
          setStatus("reply ready — send it to the host, then wait");
        } catch {
          setStatus("that host code didn't parse");
        }
      };
    };
  };
}

main();
