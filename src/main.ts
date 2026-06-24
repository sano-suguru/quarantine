import { CONFIG } from "./config";
import { Audio } from "./engine/audio";
import { Renderer } from "./engine/renderer";
import {
  chooseUpgrade,
  draw,
  getState,
  shopConfirm,
  shopMove,
  shopVisible,
  startGame,
  startNightNow,
  toggleFlashlight,
  togglePause,
  update,
  updateHUD,
  useMedkit,
} from "./game";
import { Input } from "./input";
import { el } from "./ui";

function main(): void {
  const canvas = el<HTMLCanvasElement>("game");
  Renderer.init(canvas);
  Input.init(canvas);

  el("startBtn").onclick = startGame;
  el("restartBtn").onclick = startGame;

  const cross = el("cross");
  const muteTag = el("mute");
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
    if (shopVisible()) {
      if (e.code === "Digit1") chooseUpgrade(0);
      else if (e.code === "Digit2") chooseUpgrade(1);
      else if (e.code === "Digit3") chooseUpgrade(2);
      else if (e.code === "ArrowLeft" || e.code === "KeyA") shopMove(-1);
      else if (e.code === "ArrowRight" || e.code === "KeyD") shopMove(1);
      else if (e.code === "Enter" || e.code === "Space") shopConfirm();
      return;
    }
    if ((e.code === "Escape" || e.code === "KeyP") && state.running) {
      e.preventDefault();
      togglePause();
    }
    if (e.code === "KeyF" && state.running) toggleFlashlight();
    if (e.code === "KeyH" && state.running) useMedkit();
    if (e.code === "Enter" && state.running) startNightNow();
  });

  const step = 1 / CONFIG.simHz;
  let last = performance.now();
  let acc = 0;
  function frame(now: number): void {
    const dt = (now - last) / 1000;
    last = now;
    acc += Math.min(dt, 0.1);
    while (acc >= step) {
      update(step);
      acc -= step;
    }
    draw();
    const state = getState();
    if (state.running) updateHUD();

    // custom crosshair
    if (state.running && !state.paused) {
      cross.style.opacity = "1";
      cross.style.transform = `translate(${Input.mouseX}px,${Input.mouseY}px)`;
      cross.classList.toggle("empty", state.player.dryT > 0);
      cross.classList.toggle(
        "fire",
        Input.firing && state.player.reloadT <= 0 && state.player.dryT <= 0,
      );
      cross.classList.toggle("reload", state.player.reloadT > 0);
    } else {
      cross.style.opacity = "0";
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
