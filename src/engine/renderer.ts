import { CONFIG } from "../config";
import gridFrag from "./shaders/grid.frag?raw";
import gridVert from "./shaders/grid.vert?raw";
import instanceFrag from "./shaders/instance.frag?raw";
import instanceVert from "./shaders/instance.vert?raw";

const FLOATS = 10;

/** shape flags — must match instance.frag */
export const SHAPE = { rect: 0, circle: 1, glow: 2, ring: 3, tri: 4, hex: 5 };

let gl: WebGL2RenderingContext;
let canvas: HTMLCanvasElement;
let instProg: WebGLProgram;
let gridProg: WebGLProgram;
let gridVAO: WebGLVertexArrayObject;
let quadVBO: WebGLBuffer;
let u_cam: WebGLUniformLocation | null;
let u_half: WebGLUniformLocation | null;
let u_lightCount: WebGLUniformLocation | null;
let u_lightPos: WebGLUniformLocation | null;
let u_lightAim: WebGLUniformLocation | null;
let u_lightInt: WebGLUniformLocation | null;
let u_cone: WebGLUniformLocation | null;
let u_personal: WebGLUniformLocation | null;
let u_emissive: WebGLUniformLocation | null;
let g_cam: WebGLUniformLocation | null;
let g_half: WebGLUniformLocation | null;
let g_lightCount: WebGLUniformLocation | null;
let g_lightPos: WebGLUniformLocation | null;
let g_lightAim: WebGLUniformLocation | null;
let g_lightInt: WebGLUniformLocation | null;
let g_cone: WebGLUniformLocation | null;
let g_personal: WebGLUniformLocation | null;
let viewHalfX = 400;
let viewHalfY = 300;
// flashlight state — up to MAX_LIGHTS aimed cones (one per player), set each frame via
// setLightParams (shared) + beginLights()/addLight() (per player). MAX_LIGHTS mirrors the shaders.
const MAX_LIGHTS = 4;
let lightCount = 0;
const lightPos = new Float32Array(MAX_LIGHTS * 2);
const lightAim = new Float32Array(MAX_LIGHTS * 2);
const lightInt = new Float32Array(MAX_LIGHTS);
// shared cone/pool params (every player uses the same flashlight config)
let coneCos = 0.85;
let coneRange = 620;
let coneAmbient = 0.05;
let personalRadius = 130;
let personalMax = 0.5;
let emissiveFloor = 0.4;

interface Layer {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  data: Float32Array;
  count: number;
}
let normal: Layer;
let additive: Layer;

function compile(type: number, src: string): WebGLShader {
  const s = gl.createShader(type) as WebGLShader;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "");
  return s;
}

function program(vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram() as WebGLProgram;
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "");
  return p;
}

const QUAD = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);

function makeLayer(): Layer {
  const vao = gl.createVertexArray() as WebGLVertexArrayObject;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const data = new Float32Array(CONFIG.maxInstances * FLOATS);
  const vbo = gl.createBuffer() as WebGLBuffer;
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  const stride = FLOATS * 4;
  const set = (loc: number, size: number, off: number): void => {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
    gl.vertexAttribDivisor(loc, 1);
  };
  set(1, 2, 0);
  set(2, 2, 8);
  set(3, 1, 16);
  set(4, 4, 20);
  set(5, 1, 36);
  gl.bindVertexArray(null);
  return { vao, vbo, data, count: 0 };
}

function init(cv: HTMLCanvasElement): void {
  canvas = cv;
  const ctx = canvas.getContext("webgl2", { antialias: true, alpha: false });
  if (!ctx) throw new Error("WebGL2 not supported");
  gl = ctx;
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  instProg = program(instanceVert, instanceFrag);
  u_cam = gl.getUniformLocation(instProg, "u_cam");
  u_half = gl.getUniformLocation(instProg, "u_half");
  u_lightCount = gl.getUniformLocation(instProg, "u_lightCount");
  u_lightPos = gl.getUniformLocation(instProg, "u_lightPos");
  u_lightAim = gl.getUniformLocation(instProg, "u_lightAim");
  u_lightInt = gl.getUniformLocation(instProg, "u_lightInt");
  u_cone = gl.getUniformLocation(instProg, "u_cone");
  u_personal = gl.getUniformLocation(instProg, "u_personal");
  u_emissive = gl.getUniformLocation(instProg, "u_emissive");

  quadVBO = gl.createBuffer() as WebGLBuffer;
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);

  normal = makeLayer();
  additive = makeLayer();

  gridProg = program(gridVert, gridFrag);
  g_cam = gl.getUniformLocation(gridProg, "u_cam");
  g_half = gl.getUniformLocation(gridProg, "u_half");
  g_lightCount = gl.getUniformLocation(gridProg, "u_lightCount");
  g_lightPos = gl.getUniformLocation(gridProg, "u_lightPos");
  g_lightAim = gl.getUniformLocation(gridProg, "u_lightAim");
  g_lightInt = gl.getUniformLocation(gridProg, "u_lightInt");
  g_cone = gl.getUniformLocation(gridProg, "u_cone");
  g_personal = gl.getUniformLocation(gridProg, "u_personal");
  gridVAO = gl.createVertexArray() as WebGLVertexArrayObject;
  gl.bindVertexArray(gridVAO);
  const triVBO = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, triVBO);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  resize();
  addEventListener("resize", resize);
}

function resize(): void {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
  viewHalfX = canvas.clientWidth / 2 / CONFIG.zoom;
  viewHalfY = canvas.clientHeight / 2 / CONFIG.zoom;
}

function begin(): void {
  normal.count = 0;
  additive.count = 0;
}

/** configure the shared flashlight cone/pool params for this frame (same for all players) */
function setLightParams(
  cosHalf: number,
  range: number,
  ambient: number,
  personalR: number,
  personalM: number,
  emissive: number,
): void {
  coneCos = cosHalf;
  coneRange = range;
  coneAmbient = ambient;
  personalRadius = personalR;
  personalMax = personalM;
  emissiveFloor = emissive;
}

/** start a new frame's light list (call before addLight) */
function beginLights(): void {
  lightCount = 0;
}

/** add one aimed flashlight (one per player); silently ignored past MAX_LIGHTS */
function addLight(x: number, y: number, ax: number, ay: number, intens: number): void {
  if (lightCount >= MAX_LIGHTS) return;
  lightPos[lightCount * 2] = x;
  lightPos[lightCount * 2 + 1] = y;
  lightAim[lightCount * 2] = ax;
  lightAim[lightCount * 2 + 1] = ay;
  lightInt[lightCount] = intens;
  lightCount++;
}

function write(
  layer: Layer,
  x: number,
  y: number,
  sx: number,
  sy: number,
  rot: number,
  r: number,
  g: number,
  b: number,
  a: number,
  shape: number,
): void {
  if (layer.count >= CONFIG.maxInstances) return;
  const o = layer.count * FLOATS;
  const d = layer.data;
  d[o] = x;
  d[o + 1] = y;
  d[o + 2] = sx;
  d[o + 3] = sy;
  d[o + 4] = rot;
  d[o + 5] = r;
  d[o + 6] = g;
  d[o + 7] = b;
  d[o + 8] = a;
  d[o + 9] = shape;
  layer.count++;
}

function sprite(
  x: number,
  y: number,
  sx: number,
  sy: number,
  rot: number,
  r: number,
  g: number,
  b: number,
  a: number,
  shape: number,
): void {
  write(normal, x, y, sx, sy, rot, r, g, b, a, shape);
}

function circle(x: number, y: number, rad: number, r: number, g: number, b: number, a = 1): void {
  write(normal, x, y, rad * 2, rad * 2, 0, r, g, b, a, SHAPE.circle);
}

function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  rot: number,
  r: number,
  g: number,
  b: number,
  a = 1,
): void {
  write(normal, x, y, w, h, rot, r, g, b, a, SHAPE.rect);
}

function ring(x: number, y: number, rad: number, r: number, g: number, b: number, a = 1): void {
  write(normal, x, y, rad * 2, rad * 2, 0, r, g, b, a, SHAPE.ring);
}

function tri(
  x: number,
  y: number,
  rad: number,
  rot: number,
  r: number,
  g: number,
  b: number,
  a = 1,
): void {
  write(normal, x, y, rad * 2, rad * 2, rot, r, g, b, a, SHAPE.tri);
}

function hex(
  x: number,
  y: number,
  rad: number,
  rot: number,
  r: number,
  g: number,
  b: number,
  a = 1,
): void {
  write(normal, x, y, rad * 2, rad * 2, rot, r, g, b, a, SHAPE.hex);
}

/** additive soft glow (neon halo / light) */
function glow(x: number, y: number, rad: number, r: number, g: number, b: number, a = 1): void {
  write(additive, x, y, rad * 2, rad * 2, 0, r, g, b, a, SHAPE.glow);
}

/** generic additive instance (sparks, tracers) */
function add(
  x: number,
  y: number,
  sx: number,
  sy: number,
  rot: number,
  r: number,
  g: number,
  b: number,
  a: number,
  shape: number,
): void {
  write(additive, x, y, sx, sy, rot, r, g, b, a, shape);
}

/* ---- 7-segment vector numbers (drawn as rects, world space) ---- */
// segments: a b c d e f g  →  bit 0..6
const SEG: number[] = [
  0b0111111, // 0  a b c d e f
  0b0000110, // 1  b c
  0b1011011, // 2  a b d e g
  0b1001111, // 3  a b c d g
  0b1100110, // 4  b c f g
  0b1101101, // 5  a c d f g
  0b1111101, // 6  a c d e f g
  0b0000111, // 7  a b c
  0b1111111, // 8  all
  0b1101111, // 9  a b c d f g
];

function digit(
  cx: number,
  cy: number,
  d: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const m = SEG[d] ?? 0;
  const w = h * 0.56; // cell width
  const t = h * 0.13; // stroke thickness
  const hw = w / 2;
  const hh = h / 2;
  const qh = h / 4;
  const on = (bit: number, x: number, y: number, sw: number, sh: number): void => {
    if (m & bit) rect(x, y, sw, sh, 0, r, g, b, a);
  };
  on(0b0000001, cx, cy - hh, w, t); // a top
  on(0b0000010, cx + hw, cy - qh, t, hh - t); // b top-right
  on(0b0000100, cx + hw, cy + qh, t, hh - t); // c bottom-right
  on(0b0001000, cx, cy + hh, w, t); // d bottom
  on(0b0010000, cx - hw, cy + qh, t, hh - t); // e bottom-left
  on(0b0100000, cx - hw, cy - qh, t, hh - t); // f top-left
  on(0b1000000, cx, cy, w, t); // g middle
}

/** draw a non-negative integer centered at (x,y) */
function number(
  x: number,
  y: number,
  value: number,
  h: number,
  r: number,
  g: number,
  b: number,
  a = 1,
): void {
  const s = String(Math.max(0, Math.round(value)));
  const adv = h * 0.72;
  let cx = x - (adv * (s.length - 1)) / 2;
  for (let i = 0; i < s.length; i++) {
    digit(cx, y, s.charCodeAt(i) - 48, h, r, g, b, a);
    cx += adv;
  }
}

function drawLayer(layer: Layer): void {
  if (layer.count === 0) return;
  gl.bindVertexArray(layer.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, layer.vbo);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, layer.data, 0, layer.count * FLOATS);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, layer.count);
}

function flush(camX: number, camY: number): void {
  gl.useProgram(gridProg);
  gl.uniform2f(g_cam, camX, camY);
  gl.uniform2f(g_half, viewHalfX, viewHalfY);
  gl.uniform1i(g_lightCount, lightCount);
  gl.uniform2fv(g_lightPos, lightPos);
  gl.uniform2fv(g_lightAim, lightAim);
  gl.uniform1fv(g_lightInt, lightInt);
  gl.uniform3f(g_cone, coneCos, coneRange, coneAmbient);
  gl.uniform2f(g_personal, personalRadius, personalMax);
  gl.bindVertexArray(gridVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.useProgram(instProg);
  gl.uniform2f(u_cam, camX, camY);
  gl.uniform2f(u_half, viewHalfX, viewHalfY);
  gl.uniform1i(u_lightCount, lightCount);
  gl.uniform2fv(u_lightPos, lightPos);
  gl.uniform2fv(u_lightAim, lightAim);
  gl.uniform1fv(u_lightInt, lightInt);
  gl.uniform3f(u_cone, coneCos, coneRange, coneAmbient);
  gl.uniform2f(u_personal, personalRadius, personalMax);

  // normal pass (bodies, ground): fully darkened outside the light
  gl.uniform1f(u_emissive, 0);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  drawLayer(normal);
  // additive pass (glow / sparks / eyes): keep a floor so they read in the dark
  gl.uniform1f(u_emissive, emissiveFloor);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  drawLayer(additive);
  gl.bindVertexArray(null);
}

function worldToScreenHalf(): { x: number; y: number } {
  return { x: viewHalfX, y: viewHalfY };
}

export const Renderer = {
  init,
  begin,
  setLightParams,
  beginLights,
  addLight,
  sprite,
  circle,
  rect,
  ring,
  tri,
  hex,
  glow,
  add,
  number,
  flush,
  worldToScreenHalf,
};
