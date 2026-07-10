import { isEditableTarget } from "./ui";

/** Normalized virtual-stick vector from touch input. `active` is true while a stick finger is
 *  held. `dx`/`dy` are in [-1, 1] (magnitude ≤ 1). */
export interface TouchStick {
  active: boolean;
  dx: number;
  dy: number;
}

/** Maximum pixel radius for the full-deflection stick drag. Beyond this distance dx/dy are
 *  clamped to magnitude 1 rather than growing past it. */
const STICK_RADIUS_PX = 60;

export const Input = {
  keys: new Set<string>(),
  /** accumulated mouse-wheel notch sign since the last consume (localInput drains it) */
  wheel: 0,
  /** e.timeStamp (DOMHighResTimeStamp) of the last wheel event; compared to performance.now() */
  wheelLastMs: 0,
  /** Virtual movement stick driven by touch events on the left half of the canvas. */
  touch: { active: false, dx: 0, dy: 0 } as TouchStick,
  /** One-shot heal pulse from the #btn-heal touch button. Set true on tap, consumed (reset to false)
   *  by the next sampleLocalInput call so a single tap = exactly one heal. */
  touchHealPulse: false,
  /** True while #btn-repair is held (touchstart→touchend/cancel). Ored into interactHeld. */
  touchInteract: false,
  /** One-shot hotbar tap: absolute WEAPON_ORDER index to switch to. Set by a slot tap in
   *  game.ts, consumed (reset to null) by the next sampleLocalInput call. */
  touchWeaponSlot: null as number | null,

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
      this.wheel = 0;
    });

    // ---- Virtual movement stick (touch) ----
    // Only touches that START in the LEFT half of the canvas anchor the stick. Touches that
    // start in the right half are reserved for HUD buttons (Task 12/13) and are ignored here.
    // We track the active stick finger by `Touch.identifier` so a right-half or unrelated
    // finger releasing cannot accidentally clear the stick.

    /** The Touch.identifier of the finger currently driving the stick, or -1 when none. */
    let stickId = -1;
    /** Canvas-relative origin (anchor) of the current stick drag. */
    let originX = 0;
    let originY = 0;

    const isLeftHalf = (clientX: number): boolean => {
      const rect = canvas.getBoundingClientRect();
      return clientX - rect.left < rect.width / 2;
    };

    const updateStick = (touch: Touch): void => {
      const rect = canvas.getBoundingClientRect();
      const rawDx = touch.clientX - rect.left - originX;
      const rawDy = touch.clientY - rect.top - originY;
      const dist = Math.sqrt(rawDx * rawDx + rawDy * rawDy);
      if (dist === 0) {
        this.touch.dx = 0;
        this.touch.dy = 0;
      } else {
        const scale = Math.min(dist, STICK_RADIUS_PX) / dist;
        this.touch.dx = (rawDx * scale) / STICK_RADIUS_PX;
        this.touch.dy = (rawDy * scale) / STICK_RADIUS_PX;
      }
    };

    canvas.addEventListener(
      "touchstart",
      (e) => {
        e.preventDefault(); // stop scroll/zoom on the canvas (HUD buttons are separate DOM)
        if (stickId !== -1) return; // stick already anchored — ignore additional fingers
        for (const touch of Array.from(e.changedTouches)) {
          if (isLeftHalf(touch.clientX)) {
            stickId = touch.identifier;
            const rect = canvas.getBoundingClientRect();
            originX = touch.clientX - rect.left;
            originY = touch.clientY - rect.top;
            this.touch.active = true;
            this.touch.dx = 0;
            this.touch.dy = 0;
            break; // only the first left-half finger becomes the stick
          }
        }
      },
      { passive: false },
    );

    canvas.addEventListener(
      "touchmove",
      (e) => {
        e.preventDefault();
        if (stickId === -1) return;
        for (const touch of Array.from(e.changedTouches)) {
          if (touch.identifier === stickId) {
            updateStick(touch);
            break;
          }
        }
      },
      { passive: false },
    );

    const clearStick = (e: TouchEvent): void => {
      e.preventDefault();
      if (stickId === -1) return;
      for (const touch of Array.from(e.changedTouches)) {
        if (touch.identifier === stickId) {
          stickId = -1;
          this.touch.active = false;
          this.touch.dx = 0;
          this.touch.dy = 0;
          break;
        }
      }
    };

    canvas.addEventListener("touchend", clearStick, { passive: false });
    canvas.addEventListener("touchcancel", clearStick, { passive: false });
  },
};
