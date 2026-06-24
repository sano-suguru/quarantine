import { CONFIG } from "./config";
import { Renderer } from "./engine/renderer";
import { chooseUpgrade, draw, getState, shopVisible, startGame, update, updateHUD } from "./game";
import { Input } from "./input";
import { el } from "./ui";

function main(): void {
  const canvas = el<HTMLCanvasElement>("game");
  Renderer.init(canvas);
  Input.init(canvas);

  el("startBtn").onclick = startGame;
  el("restartBtn").onclick = startGame;

  addEventListener("keydown", (e) => {
    const state = getState();
    if (state.paused && shopVisible()) {
      if (e.code === "Digit1") chooseUpgrade(0);
      if (e.code === "Digit2") chooseUpgrade(1);
      if (e.code === "Digit3") chooseUpgrade(2);
    }
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
    if (getState().running) updateHUD();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
