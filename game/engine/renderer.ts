import { CONFIG } from "../config";
import { packFragCell } from "./fragment";
import bloodFrag from "./shaders/blood.frag?raw";
import bloodVert from "./shaders/blood.vert?raw";
import gridFrag from "./shaders/grid.frag?raw";
import gridVert from "./shaders/grid.vert?raw";
import instanceFrag from "./shaders/instance.frag?raw";
import instanceVert from "./shaders/instance.vert?raw";
import { SPRITE_ASSETS, spriteIndex, unreadyRequiredSprites } from "./spriteAssets";
import { packSprites, uvRect } from "./spritePack";

const FLOATS = 11;

/** shape flags — must match instance.frag */
export const SHAPE = { rect: 0, circle: 1, glow: 2, ring: 3, tri: 4, hex: 5, slash: 6, sprite: 16 };

let gl: WebGL2RenderingContext;
let canvas: HTMLCanvasElement;
let instProg: WebGLProgram;
let gridProg: WebGLProgram;
let bloodProg: WebGLProgram;
let gridVAO: WebGLVertexArrayObject;
let quadVBO: WebGLBuffer;
let u_cam: WebGLUniformLocation | null;
let u_half: WebGLUniformLocation | null;
let u_lightCount: WebGLUniformLocation | null;
let u_lightPos: WebGLUniformLocation | null;
let u_lightAim: WebGLUniformLocation | null;
let u_lightInt: WebGLUniformLocation | null;
let u_ambient: WebGLUniformLocation | null;
let u_lightCone: WebGLUniformLocation | null;
let u_personal: WebGLUniformLocation | null;
let u_emissive: WebGLUniformLocation | null;
let g_cam: WebGLUniformLocation | null;
let g_half: WebGLUniformLocation | null;
let g_lightCount: WebGLUniformLocation | null;
let g_lightPos: WebGLUniformLocation | null;
let g_lightAim: WebGLUniformLocation | null;
let g_lightInt: WebGLUniformLocation | null;
let g_ambient: WebGLUniformLocation | null;
let g_lightCone: WebGLUniformLocation | null;
let g_personal: WebGLUniformLocation | null;
let viewHalfX = 400;
let viewHalfY = 300;
// flashlight state — up to MAX_LIGHTS aimed cones (one per player), set each frame via
// setLightParams (shared) + beginLights()/addLight() (per player). MAX_LIGHTS mirrors the shaders.
const MAX_LIGHTS = 8;
const MAX_WALLS = 32;
let lightCount = 0;
const lightPos = new Float32Array(MAX_LIGHTS * 2);
const lightAim = new Float32Array(MAX_LIGHTS * 2);
const lightInt = new Float32Array(MAX_LIGHTS);
const lightCone = new Float32Array(MAX_LIGHTS * 2); // [cosHalf, range] per light
// shared cone/pool params (every player uses the same flashlight config)
let coneCos = 0.85;
let coneRange = 620;
let coneAmbient = 0.05;
let personalRadius = 130;
let personalMax = 0.5;
let emissiveFloor = 0.4;
let b_blood: WebGLUniformLocation | null;
let b_pulse: WebGLUniformLocation | null;
let b_time: WebGLUniformLocation | null;
let b_half: WebGLUniformLocation | null;
let bloodIntensity = 0;
let bloodPulse = 0;
let bloodTime = 0;
let u_wall: WebGLUniformLocation | null;
let u_wallCount: WebGLUniformLocation | null;
let u_shadowFloor: WebGLUniformLocation | null;
let g_wall: WebGLUniformLocation | null;
let g_wallCount: WebGLUniformLocation | null;
let g_shadowFloor: WebGLUniformLocation | null;
let g_occludeFloor: WebGLUniformLocation | null;
let g_sat: WebGLUniformLocation | null;
let g_dim: WebGLUniformLocation | null;
let u_sat: WebGLUniformLocation | null;
let u_dim: WebGLUniformLocation | null;
const wallData = new Float32Array(MAX_WALLS * 4);
let wallCount = 0;
let gradeSat = 1;
let gradeDim = 1;
const MAX_SPRITES = 32; // must match instance.frag
const SPRITE_GUTTER = 2; // px between packed sprites; pairs with uvRect's half-texel inset
let u_sprites: WebGLUniformLocation | null;
let u_spriteRects: WebGLUniformLocation | null;
let u_gridN: WebGLUniformLocation | null;
let u_atlasTexel: WebGLUniformLocation | null;
let atlasTex: WebGLTexture;
const spriteRects = new Float32Array(MAX_SPRITES * 4); // [u0,v0,uW,vH] * MAX_SPRITES, zero-init
const spriteReady: boolean[] = []; // per index, true once its texels are uploaded
let spritesReadyPromise: Promise<void> | null = null;
let atlasSize = 1; // px size of the square sprite atlas; feeds u_atlasTexel (half-texel guard)

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
  set(6, 1, 40); // a_frag (sprite sub-cell; 0 = whole sprite)
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
  u_ambient = gl.getUniformLocation(instProg, "u_ambient");
  u_lightCone = gl.getUniformLocation(instProg, "u_lightCone");
  u_wall = gl.getUniformLocation(instProg, "u_wall");
  u_wallCount = gl.getUniformLocation(instProg, "u_wallCount");
  u_shadowFloor = gl.getUniformLocation(instProg, "u_shadowFloor");
  u_personal = gl.getUniformLocation(instProg, "u_personal");
  u_emissive = gl.getUniformLocation(instProg, "u_emissive");
  u_sat = gl.getUniformLocation(instProg, "u_sat");
  u_dim = gl.getUniformLocation(instProg, "u_dim");
  u_sprites = gl.getUniformLocation(instProg, "u_sprites");
  u_spriteRects = gl.getUniformLocation(instProg, "u_spriteRects");
  u_gridN = gl.getUniformLocation(instProg, "u_gridN");
  u_atlasTexel = gl.getUniformLocation(instProg, "u_atlasTexel");
  // 1x1 transparent atlas so the sampler is COMPLETE from frame 0 (before art loads / if none).
  atlasTex = gl.createTexture() as WebGLTexture;
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

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
  g_ambient = gl.getUniformLocation(gridProg, "u_ambient");
  g_lightCone = gl.getUniformLocation(gridProg, "u_lightCone");
  g_wall = gl.getUniformLocation(gridProg, "u_wall");
  g_wallCount = gl.getUniformLocation(gridProg, "u_wallCount");
  g_shadowFloor = gl.getUniformLocation(gridProg, "u_shadowFloor");
  g_occludeFloor = gl.getUniformLocation(gridProg, "u_occludeFloor");
  g_personal = gl.getUniformLocation(gridProg, "u_personal");
  g_sat = gl.getUniformLocation(gridProg, "u_sat");
  g_dim = gl.getUniformLocation(gridProg, "u_dim");
  gridVAO = gl.createVertexArray() as WebGLVertexArrayObject;
  gl.bindVertexArray(gridVAO);
  const triVBO = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, triVBO);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  bloodProg = program(bloodVert, bloodFrag);
  b_blood = gl.getUniformLocation(bloodProg, "u_blood");
  b_pulse = gl.getUniformLocation(bloodProg, "u_pulse");
  b_time = gl.getUniformLocation(bloodProg, "u_time");
  b_half = gl.getUniformLocation(bloodProg, "u_half");

  resize();
  addEventListener("resize", resize);
  spritesReadyPromise = loadSprites();
  // Log boot asset failures for diagnostics AND mark the rejection handled so it never surfaces as
  // an unhandledrejection between commits; main() separately surfaces it in the #loading overlay.
  void spritesReadyPromise.catch((e) => console.error("[sprites]", e));
}

function resize(): void {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.floor(canvas.clientWidth * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  gl.viewport(0, 0, canvas.width, canvas.height);
  const portrait = canvas.clientHeight > canvas.clientWidth;
  const effectiveZoom =
    document.body.classList.contains("mobile") && portrait
      ? CONFIG.zoom * CONFIG.zoomMobileMul
      : CONFIG.zoom;
  viewHalfX = canvas.clientWidth / 2 / effectiveZoom;
  viewHalfY = canvas.clientHeight / 2 / effectiveZoom;
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

/** HP-driven blood vignette: intensity (0..1 HP creep), pulse (0..1 heartbeat throb), time
 *  (churn/breathe clock; pass 0 to freeze for prefers-reduced-motion). Render-only. */
function setBlood(intensity: number, pulse: number, time: number): void {
  bloodIntensity = intensity;
  bloodPulse = pulse;
  bloodTime = time;
}

/** HP-driven world grade: sat (1 = full colour, 0 = greyscale), dim (1 = normal, 0 = black).
 *  Applied to grid + instance world passes BEFORE the blood vignette. Render-only. */
function setGrade(sat: number, dim: number): void {
  gradeSat = sat;
  gradeDim = dim;
}

/** upload the static wall segments once; occlusion reads them every frame (walls never change in a run) */
export function setWalls(walls: { x1: number; y1: number; x2: number; y2: number }[]): void {
  wallCount = Math.min(walls.length, MAX_WALLS);
  for (let i = 0; i < wallCount; i++) {
    const w = walls[i] as (typeof walls)[number];
    wallData[i * 4] = w.x1;
    wallData[i * 4 + 1] = w.y1;
    wallData[i * 4 + 2] = w.x2;
    wallData[i * 4 + 3] = w.y2;
  }
  gl.useProgram(instProg);
  gl.uniform4fv(u_wall, wallData);
  gl.uniform1i(u_wallCount, wallCount);
  gl.useProgram(gridProg);
  gl.uniform4fv(g_wall, wallData);
  gl.uniform1i(g_wallCount, wallCount);
}

/** start a new frame's light list (call before addLight) */
function beginLights(): void {
  lightCount = 0;
}

/** add one aimed flashlight (one per player); silently ignored past MAX_LIGHTS */
function addLight(
  x: number,
  y: number,
  ax: number,
  ay: number,
  intens: number,
  cosHalf = coneCos,
  range = coneRange,
): void {
  if (lightCount >= MAX_LIGHTS) return;
  lightPos[lightCount * 2] = x;
  lightPos[lightCount * 2 + 1] = y;
  lightAim[lightCount * 2] = ax;
  lightAim[lightCount * 2 + 1] = ay;
  lightInt[lightCount] = intens;
  lightCone[lightCount * 2] = cosHalf;
  lightCone[lightCount * 2 + 1] = range;
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
  frag = 0,
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
  d[o + 10] = frag;
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

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`sprite load failed: ${url}`));
    img.src = url;
  });
}

/**
 * Load every discovered PNG, pack them deterministically in glob-index order (NOT completion
 * order), upload into one atlas, and record half-texel-inset UV rects. ready flips per index only
 * after its texels are uploaded, so the draw side never emits an index the shader can't sample.
 * A single PNG that fails to load is isolated (allSettled + a 1x1 placeholder slot) so the others
 * still load at their stable index — one 404 must not silently drop the whole enemy roster to SDF.
 */
async function loadSprites(): Promise<void> {
  if (SPRITE_ASSETS.length === 0) {
    throw new Error("[sprites] no sprite assets found (build/glob broken)");
  }
  const settled = await Promise.allSettled(SPRITE_ASSETS.map((a) => loadImage(a.url)));
  const imgs = settled.map((res, i) => {
    if (res.status === "fulfilled") return res.value;
    console.warn(`[sprites] "${SPRITE_ASSETS[i]?.key}" failed to load`, res.reason);
    return null;
  });
  // A failed load keeps its index (1x1 placeholder) so a neighbor's failure never shifts another
  // sprite's atlas index — the shader reads u_spriteRects[globIndex], which must stay stable.
  const sizes = imgs.map((im) => (im ? { w: im.width, h: im.height } : { w: 1, h: 1 }));
  const maxAtlas = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  const packed = packSprites(sizes, SPRITE_GUTTER, maxAtlas);
  atlasSize = packed.atlas;

  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    packed.atlas,
    packed.atlas,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    null,
  );
  for (let i = 0; i < imgs.length && i < MAX_SPRITES; i++) {
    const r = packed.rects[i];
    const im = imgs[i];
    if (!r || !im) continue;
    gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x, r.y, gl.RGBA, gl.UNSIGNED_BYTE, im);
    spriteRects.set(uvRect(r, packed.atlas), i * 4);
    spriteReady[i] = true;
  }
  // Fail loud on required assets: a required key missing from the glob (index < 0) or whose texels
  // never uploaded (spriteReady false) aborts to the load-error state rather than drawing invisibly.
  const missing = unreadyRequiredSprites((i) => spriteReady[i] === true);
  if (missing.length > 0) {
    throw new Error(`[sprites] required sprites failed to load: ${missing.join(", ")}`);
  }
}

function spriteQuad(
  x: number,
  y: number,
  w: number,
  h: number,
  rot: number,
  index: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  write(normal, x, y, w, h, rot, r, g, b, a, SHAPE.sprite + index);
}

function spriteFragQuad(
  x: number,
  y: number,
  w: number,
  h: number,
  rot: number,
  index: number,
  cx: number,
  cy: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  write(
    normal,
    x,
    y,
    w,
    h,
    rot,
    r,
    g,
    b,
    a,
    SHAPE.sprite + index,
    packFragCell(cx, cy, CONFIG.fx.gore.gridN),
  );
}

function spriteLayer(key: string): number {
  const i = spriteIndex(key);
  return i >= 0 && spriteReady[i] ? i : -1;
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

/** additive crescent slash-arc (melee swing) — `rot` points the convex leading edge */
function slash(
  x: number,
  y: number,
  rad: number,
  rot: number,
  r: number,
  g: number,
  b: number,
  a = 1,
): void {
  write(additive, x, y, rad * 2, rad * 2, rot, r, g, b, a, SHAPE.slash);
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
  // night → shadowFloor (dark, truly hides); day → coneAmbient (no harsh daylight shadows)
  const na = CONFIG.siege.nightAmbient;
  const da = CONFIG.siege.dayAmbient;
  const tPhase = Math.min(1, Math.max(0, (coneAmbient - na) / Math.max(1e-3, da - na)));
  const shadowFloorNow =
    CONFIG.flashlight.shadowFloor + (coneAmbient - CONFIG.flashlight.shadowFloor) * tPhase;

  gl.useProgram(gridProg);
  gl.uniform2f(g_cam, camX, camY);
  gl.uniform2f(g_half, viewHalfX, viewHalfY);
  gl.uniform1i(g_lightCount, lightCount);
  gl.uniform2fv(g_lightPos, lightPos);
  gl.uniform2fv(g_lightAim, lightAim);
  gl.uniform1fv(g_lightInt, lightInt);
  gl.uniform2fv(g_lightCone, lightCone);
  gl.uniform1f(g_ambient, coneAmbient);
  gl.uniform1f(g_shadowFloor, shadowFloorNow);
  gl.uniform1i(g_occludeFloor, CONFIG.flashlight.occludeFloor ? 1 : 0);
  gl.uniform2f(g_personal, personalRadius, personalMax);
  gl.uniform1f(g_sat, gradeSat);
  gl.uniform1f(g_dim, gradeDim);
  gl.bindVertexArray(gridVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.useProgram(instProg);
  gl.uniform2f(u_cam, camX, camY);
  gl.uniform2f(u_half, viewHalfX, viewHalfY);
  gl.uniform1i(u_lightCount, lightCount);
  gl.uniform2fv(u_lightPos, lightPos);
  gl.uniform2fv(u_lightAim, lightAim);
  gl.uniform1fv(u_lightInt, lightInt);
  gl.uniform2fv(u_lightCone, lightCone);
  gl.uniform1f(u_ambient, coneAmbient);
  gl.uniform1f(u_shadowFloor, shadowFloorNow);
  gl.uniform2f(u_personal, personalRadius, personalMax);
  gl.uniform1f(u_sat, gradeSat);
  gl.uniform1f(u_dim, gradeDim);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, atlasTex);
  gl.uniform1i(u_sprites, 0);
  gl.uniform4fv(u_spriteRects, spriteRects);
  gl.uniform1f(u_gridN, CONFIG.fx.gore.gridN);
  gl.uniform1f(u_atlasTexel, 1 / atlasSize);

  // normal pass (bodies, ground): fully darkened outside the light
  gl.uniform1f(u_emissive, 0);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  drawLayer(normal);
  // additive pass (glow / sparks / eyes): keep a floor so they read in the dark
  gl.uniform1f(u_emissive, emissiveFloor);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
  drawLayer(additive);

  // blood vignette (HP-driven, render-only): final full-screen pass, alpha-over on top of all.
  if (bloodIntensity > 0) {
    gl.useProgram(bloodProg);
    gl.uniform1f(b_blood, bloodIntensity);
    gl.uniform1f(b_pulse, bloodPulse);
    gl.uniform1f(b_time, bloodTime);
    gl.uniform2f(b_half, viewHalfX, viewHalfY);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(gridVAO);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  // Leave flush in the default alpha-over blend state. The framebuffer auto-clears each frame
  // (preserveDrawingBuffer is unset) and the grid pass outputs alpha=1, so it is blend-mode-
  // independent and does not rely on this reset. The unconditional blendFunc here makes the
  // end-of-flush blend state deterministic after the optional blood pass (which switches to
  // ONE_MINUS_SRC_ALPHA and may or may not run each frame), so callers get a predictable baseline.
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(null);
}

function worldToScreenHalf(): { x: number; y: number } {
  return { x: viewHalfX, y: viewHalfY };
}

function spritesReady(): Promise<void> {
  return spritesReadyPromise ?? Promise.reject(new Error("[sprites] renderer not initialized"));
}

export const Renderer = {
  init,
  begin,
  setLightParams,
  setBlood,
  setGrade,
  setWalls,
  beginLights,
  addLight,
  sprite,
  spriteQuad,
  spriteFragQuad,
  spriteLayer,
  spritesReady,
  circle,
  rect,
  ring,
  tri,
  hex,
  glow,
  slash,
  add,
  number,
  flush,
  worldToScreenHalf,
  maxLights: () => MAX_LIGHTS,
};
