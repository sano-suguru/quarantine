export const Input = {
  keys: new Set<string>(),
  mouseX: 0,
  mouseY: 0,
  firing: false,
  init(canvas: HTMLCanvasElement): void {
    addEventListener("keydown", (e) => {
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
    addEventListener("blur", () => {
      this.keys.clear();
      this.firing = false;
    });
  },
};
