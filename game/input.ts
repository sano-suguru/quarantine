import { isEditableTarget } from "./ui";

export const Input = {
  keys: new Set<string>(),
  mouseX: 0,
  mouseY: 0,
  firing: false,
  /** accumulated mouse-wheel notch sign since the last consume (localInput drains it) */
  wheel: 0,
  /** e.timeStamp (DOMHighResTimeStamp) of the last wheel event; compared to performance.now() */
  wheelLastMs: 0,
  init(canvas: HTMLCanvasElement): void {
    addEventListener("keydown", (e) => {
      // While a text field (room-code input, manual-SDP textareas) is focused, let the
      // keystroke through untouched — otherwise the preventDefault below eats characters
      // that are valid in a room code (R, 2, 3, …).
      if (isEditableTarget(e.target)) return;
      this.keys.add(e.code);
      if (["KeyR", "Digit1", "Digit2", "Digit3"].includes(e.code)) e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    canvas.addEventListener("mousemove", (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
    });
    canvas.addEventListener("mousedown", () => {
      this.firing = true;
    });
    addEventListener("mouseup", () => {
      this.firing = false;
    });
    // Wheel = relative weapon cycle (resolved to an absolute slot in localInput). Bound to the
    // canvas so wheel over text inputs never reaches here; { passive: false } so preventDefault
    // (stop the page scrolling under the game) actually applies.
    canvas.addEventListener(
      "wheel",
      (e) => {
        this.wheel += Math.sign(e.deltaY);
        this.wheelLastMs = e.timeStamp;
        e.preventDefault();
      },
      { passive: false },
    );
    addEventListener("blur", () => {
      this.keys.clear();
      this.firing = false;
      this.wheel = 0;
    });
  },
};
