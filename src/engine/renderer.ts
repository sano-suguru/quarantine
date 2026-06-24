import { CONFIG } from "../config";
import gridFrag from "./shaders/grid.frag?raw";
import gridVert from "./shaders/grid.vert?raw";
import instanceFrag from "./shaders/instance.frag?raw";
import instanceVert from "./shaders/instance.vert?raw";

const FLOATS = 10;

let gl: WebGL2RenderingContext;
let canvas: HTMLCanvasElement;
let instProg: WebGLProgram;
let instVAO: WebGLVertexArrayObject;
let instVBO: WebGLBuffer;
let instData: Float32Array;
let instCount = 0;
let gridProg: WebGLProgram;
let gridVAO: WebGLVertexArrayObject;
let u_cam: WebGLUniformLocation | null;
let u_half: WebGLUniformLocation | null;
let g_cam: WebGLUniformLocation | null;
let g_half: WebGLUniformLocation | null;
let viewHalfX = 400;
let viewHalfY = 300;

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

  instVAO = gl.createVertexArray() as WebGLVertexArrayObject;
  gl.bindVertexArray(instVAO);
  const quadVBO = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVBO);
  gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  instData = new Float32Array(CONFIG.maxInstances * FLOATS);
  instVBO = gl.createBuffer() as WebGLBuffer;
  gl.bindBuffer(gl.ARRAY_BUFFER, instVBO);
  gl.bufferData(gl.ARRAY_BUFFER, instData.byteLength, gl.DYNAMIC_DRAW);
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

  gridProg = program(gridVert, gridFrag);
  g_cam = gl.getUniformLocation(gridProg, "u_cam");
  g_half = gl.getUniformLocation(gridProg, "u_half");
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
  instCount = 0;
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
  if (instCount >= CONFIG.maxInstances) return;
  const o = instCount * FLOATS;
  const d = instData;
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
  instCount++;
}

function circle(
  x: number,
  y: number,
  radius: number,
  r: number,
  g: number,
  b: number,
  a?: number,
): void {
  sprite(x, y, radius * 2, radius * 2, 0, r, g, b, a === undefined ? 1 : a, 1);
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
  a?: number,
): void {
  sprite(x, y, w, h, rot, r, g, b, a === undefined ? 1 : a, 0);
}

function flush(camX: number, camY: number): void {
  gl.useProgram(gridProg);
  gl.uniform2f(g_cam, camX, camY);
  gl.uniform2f(g_half, viewHalfX, viewHalfY);
  gl.bindVertexArray(gridVAO);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  gl.useProgram(instProg);
  gl.uniform2f(u_cam, camX, camY);
  gl.uniform2f(u_half, viewHalfX, viewHalfY);
  gl.bindVertexArray(instVAO);
  gl.bindBuffer(gl.ARRAY_BUFFER, instVBO);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, instData, 0, instCount * FLOATS);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instCount);
  gl.bindVertexArray(null);
}

function worldToScreenHalf(): { x: number; y: number } {
  return { x: viewHalfX, y: viewHalfY };
}

export const Renderer = { init, begin, sprite, circle, rect, flush, worldToScreenHalf };
