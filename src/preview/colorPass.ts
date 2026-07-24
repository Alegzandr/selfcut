/**
 * Isolated WebGL colour-grading pass.
 *
 * The Canvas 2D compositor keeps doing all geometry, compositing and
 * transitions unchanged; this pass sits in front of it. `gradeFrame` uploads a
 * clip's decoded frame, runs a fragment shader (brightness, contrast,
 * saturation, white balance, vignette) and returns a canvas the compositor
 * draws in the sample's place — a WebGL canvas is `drawImage`-able into the 2D
 * context, so the grade never touches the load-bearing compositor code.
 *
 * A single grader is memoized per thread (one for the preview on the main
 * thread, one for the export worker), sharing one WebGL2 context and one
 * texture across every clip and frame. If WebGL2 is unavailable the grader
 * yields null and the compositor draws the ungraded frame, so colour grading
 * degrades to a no-op rather than breaking playback.
 */
import type { DrawableFrame } from '../media/stillImage';
import type { ResolvedColor } from '../model';
import type { Lut } from '../types';

type AnyCanvas = OffscreenCanvas;
type Ctx2D = OffscreenCanvasRenderingContext2D;

const VERT = `#version 300 es
in vec2 p;
out vec2 uv;
void main() {
  uv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
out vec4 outColor;
uniform sampler2D tex;
uniform sampler3D uLut;
uniform sampler2D uCurve;
uniform float uBright, uContrast, uSat, uTemp, uTint, uVignette, uLutAmount, uLutSize, uCurveOn;
uniform float uKeyOn, uKeySim, uKeySmooth, uKeySpill;
uniform vec3 uKeyColor;
void main() {
  vec4 c = texture(tex, uv);
  vec3 rgb = c.rgb;
  float alpha = c.a;
  // Chroma key first, on the raw frame: keyed pixels drop to alpha 0 so lower
  // tracks show through. Matched in the Cb/Cr chroma plane (luma removed), so
  // shadows and highlights on the green screen key as one hue. Green spill on the
  // subject is pulled toward the red/blue max, the standard suppression.
  if (uKeyOn > 0.5) {
    float ky = dot(uKeyColor, vec3(0.299, 0.587, 0.114));
    vec2 kcc = vec2((uKeyColor.b - ky) / 1.772, (uKeyColor.r - ky) / 1.402);
    float py = dot(rgb, vec3(0.299, 0.587, 0.114));
    vec2 pcc = vec2((rgb.b - py) / 1.772, (rgb.r - py) / 1.402);
    float dist = distance(pcc, kcc);
    alpha *= smoothstep(uKeySim, uKeySim + uKeySmooth + 0.001, dist);
    if (uKeySpill > 0.0) {
      float m = max(rgb.r, rgb.b);
      rgb.g = mix(rgb.g, min(rgb.g, m), uKeySpill);
    }
  }
  // LUT first: the technical LOG->Rec.709 transform (or a creative grade) maps
  // the raw frame, then the sliders tune the mapped result. The half-texel
  // scale keeps the trilinear fetch centred on the LUT's grid points, so the
  // endpoints land exactly instead of drifting half a cell in.
  if (uLutAmount > 0.0) {
    vec3 luv = (rgb * (uLutSize - 1.0) + 0.5) / uLutSize;
    vec3 graded = texture(uLut, luv).rgb;
    rgb = mix(rgb, graded, uLutAmount);
  }
  rgb += uBright;                              // exposure
  rgb.r += uTemp * 0.12;                        // white balance: warm/cool
  rgb.b -= uTemp * 0.12;
  rgb.g += uTint * 0.12;                        // green/magenta
  rgb = (rgb - 0.5) * (1.0 + uContrast) + 0.5;  // contrast around mid grey
  float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
  rgb = mix(vec3(luma), rgb, 1.0 + uSat);       // saturation
  // Tone curves: a 256-wide 1D LUT holding the per-channel curves in RGB and the
  // master curve in A. Per-channel first, then the master over the result — the
  // Lightroom point-curve order. LINEAR filtering smooths the 256 steps.
  if (uCurveOn > 0.5) {
    rgb = clamp(rgb, 0.0, 1.0);
    rgb.r = texture(uCurve, vec2(rgb.r, 0.5)).r;
    rgb.g = texture(uCurve, vec2(rgb.g, 0.5)).g;
    rgb.b = texture(uCurve, vec2(rgb.b, 0.5)).b;
    rgb.r = texture(uCurve, vec2(rgb.r, 0.5)).a;
    rgb.g = texture(uCurve, vec2(rgb.g, 0.5)).a;
    rgb.b = texture(uCurve, vec2(rgb.b, 0.5)).a;
  }
  if (uVignette > 0.0) {
    float d = distance(uv, vec2(0.5));
    float v = smoothstep(0.75, 0.35, d);        // 1 at centre, 0 at corners
    rgb *= mix(1.0, v, uVignette);
  }
  outColor = vec4(clamp(rgb, 0.0, 1.0), alpha);
}`;

interface Uniforms {
  uBright: WebGLUniformLocation | null;
  uContrast: WebGLUniformLocation | null;
  uSat: WebGLUniformLocation | null;
  uTemp: WebGLUniformLocation | null;
  uTint: WebGLUniformLocation | null;
  uVignette: WebGLUniformLocation | null;
  uLutAmount: WebGLUniformLocation | null;
  uLutSize: WebGLUniformLocation | null;
  uCurveOn: WebGLUniformLocation | null;
  uKeyOn: WebGLUniformLocation | null;
  uKeyColor: WebGLUniformLocation | null;
  uKeySim: WebGLUniformLocation | null;
  uKeySmooth: WebGLUniformLocation | null;
  uKeySpill: WebGLUniformLocation | null;
}

/**
 * The LUTs currently in scope, keyed by id, kept in sync with `Project.luts` by
 * `syncLuts`. Module-level so both the preview grader (main thread) and the
 * export grader (worker) read the set their own draft was told about, without
 * threading a registry through the compositor's every call. The grader uploads
 * each one to a `sampler3D` lazily on first use and caches the GPU texture.
 */
const lutRegistry = new Map<string, Lut>();
/** Last array `syncLuts` saw, so an unchanged project skips the rebuild each frame. */
let lastLuts: Lut[] | null = null;

/**
 * Point the renderer at the project's current LUT set. Called once per frame by
 * each draw driver; a reference-equal array (the common case: nothing changed)
 * returns immediately. Ids no longer present drop out of the registry, so a
 * clip referencing a removed LUT falls back to no LUT.
 */
export function syncLuts(luts: readonly Lut[] | undefined): void {
  const next = (luts ?? []) as Lut[];
  if (next === lastLuts) return;
  lastLuts = next;
  lutRegistry.clear();
  for (const lut of next) lutRegistry.set(lut.id, lut);
}

class ColorGrader {
  private canvas: AnyCanvas;
  private gl: WebGL2RenderingContext;
  private uniforms: Uniforms;
  private texture: WebGLTexture;
  /** Scratch 2D canvas the frame is rasterized into before upload. */
  private scratch: AnyCanvas;
  private scratchCtx: Ctx2D;
  private w = 0;
  private h = 0;
  /** Uploaded LUTs, keyed by `Lut.id`. Built on first use, kept for the session. */
  private lutTextures = new Map<string, { tex: WebGLTexture; size: number }>();
  /** Bound when no LUT is active, so the `sampler3D` always has a valid texture. */
  private identityLut: WebGLTexture;
  /** Uploaded tone-curve textures, keyed by their baked bytes (stable per grade). */
  private curveTextures = new WeakMap<Uint8Array, WebGLTexture>();
  /** Bound when no curve is active, so the curve `sampler2D` is never left unbound. */
  private identityCurve: WebGLTexture;

  constructor(gl: WebGL2RenderingContext, canvas: AnyCanvas) {
    this.canvas = canvas;
    this.gl = gl;
    const program = buildProgram(gl);
    gl.useProgram(program);

    // Fullscreen triangle: three verts cover the viewport, no index buffer.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    this.texture = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    // Frame on unit 0, LUT on unit 1, tone curve on unit 2: three samplers, three
    // permanently-assigned units.
    gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'uLut'), 1);
    gl.uniform1i(gl.getUniformLocation(program, 'uCurve'), 2);
    this.identityLut = buildIdentityLut(gl);
    this.identityCurve = buildCurveTextureGl(gl, identityCurveBytes());

    this.uniforms = {
      uBright: gl.getUniformLocation(program, 'uBright'),
      uContrast: gl.getUniformLocation(program, 'uContrast'),
      uSat: gl.getUniformLocation(program, 'uSat'),
      uTemp: gl.getUniformLocation(program, 'uTemp'),
      uTint: gl.getUniformLocation(program, 'uTint'),
      uVignette: gl.getUniformLocation(program, 'uVignette'),
      uLutAmount: gl.getUniformLocation(program, 'uLutAmount'),
      uLutSize: gl.getUniformLocation(program, 'uLutSize'),
      uCurveOn: gl.getUniformLocation(program, 'uCurveOn'),
      uKeyOn: gl.getUniformLocation(program, 'uKeyOn'),
      uKeyColor: gl.getUniformLocation(program, 'uKeyColor'),
      uKeySim: gl.getUniformLocation(program, 'uKeySim'),
      uKeySmooth: gl.getUniformLocation(program, 'uKeySmooth'),
      uKeySpill: gl.getUniformLocation(program, 'uKeySpill'),
    };

    this.scratch = new OffscreenCanvas(1, 1);
    this.scratchCtx = this.scratch.getContext('2d')!;
  }

  /**
   * Upload a registered LUT to a 3D texture (once), or return the cached one.
   * Stored as `RGB8` with `LINEAR` filtering, which is core WebGL2 and gives the
   * trilinear interpolation between grid points for free — no float-texture
   * extension, and 8-bit precision is what an SDR export lands at anyway.
   */
  private lutTexture(id: string): { tex: WebGLTexture; size: number } | null {
    const cached = this.lutTextures.get(id);
    if (cached) return cached;
    const lut = lutRegistry.get(id);
    if (!lut) return null;

    const gl = this.gl;
    const n = lut.size;
    const bytes = new Uint8Array(n * n * n * 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round(lut.data[i]! * 255);

    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    // ArrayBufferView uploads ignore UNPACK_FLIP_Y, so the data's r-fastest
    // ordering maps straight onto (x=r, y=g, z=b) with no axis surprises.
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, n, n, n, 0, gl.RGB, gl.UNSIGNED_BYTE, bytes);

    const entry = { tex, size: n };
    this.lutTextures.set(id, entry);
    return entry;
  }

  /**
   * Upload a baked tone-curve texture (256×1 RGBA8) once, or return the cached
   * one. `LINEAR` filtering interpolates between the 256 code steps, so a gentle
   * curve stays smooth rather than banding.
   */
  private curveTexture(bytes: Uint8Array): WebGLTexture {
    const cached = this.curveTextures.get(bytes);
    if (cached) return cached;
    const tex = buildCurveTextureGl(this.gl, bytes);
    this.curveTextures.set(bytes, tex);
    return tex;
  }

  private resize(w: number, h: number): void {
    if (this.w === w && this.h === h) return;
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.scratch.width = w;
    this.scratch.height = h;
    this.gl.viewport(0, 0, w, h);
  }

  grade(sample: DrawableFrame, w: number, h: number, adj: ResolvedColor): AnyCanvas | null {
    if (w <= 0 || h <= 0) return null;
    this.resize(w, h);
    // Rasterize the frame into the scratch canvas, then upload it as a texture:
    // DrawableFrame only exposes a 2D draw, so this is the one universal path
    // that works for video samples and still images alike.
    this.scratchCtx.clearRect(0, 0, w, h);
    sample.draw(this.scratchCtx, 0, 0, w, h, 0, 0, w, h);

    const gl = this.gl;

    // Bind the LUT on unit 1 (or the identity, so the sampler is never unbound),
    // and only turn the LUT branch on when the clip's LUT is actually registered.
    const lut = adj.lut ? this.lutTexture(adj.lut.id) : null;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lut ? lut.tex : this.identityLut);
    gl.uniform1f(this.uniforms.uLutAmount, lut ? adj.lut!.intensity : 0);
    gl.uniform1f(this.uniforms.uLutSize, lut ? lut.size : 2);

    // Tone curve on unit 2 (or the identity ramp, so the sampler is never
    // unbound), gated on by uCurveOn only when the clip actually carries curves.
    const curveTex = adj.curve ? this.curveTexture(adj.curve) : null;
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, curveTex ?? this.identityCurve);
    gl.uniform1f(this.uniforms.uCurveOn, curveTex ? 1 : 0);

    const key = adj.chroma;
    gl.uniform1f(this.uniforms.uKeyOn, key ? 1 : 0);
    if (key) {
      gl.uniform3f(this.uniforms.uKeyColor, key.color[0], key.color[1], key.color[2]);
      gl.uniform1f(this.uniforms.uKeySim, key.similarity);
      gl.uniform1f(this.uniforms.uKeySmooth, key.smoothness);
      gl.uniform1f(this.uniforms.uKeySpill, key.spill);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.scratch);
    gl.uniform1f(this.uniforms.uBright, adj.brightness);
    gl.uniform1f(this.uniforms.uContrast, adj.contrast);
    gl.uniform1f(this.uniforms.uSat, adj.saturation);
    gl.uniform1f(this.uniforms.uTemp, adj.temperature);
    gl.uniform1f(this.uniforms.uTint, adj.tint);
    gl.uniform1f(this.uniforms.uVignette, adj.vignette);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }
}

/**
 * A 2×2×2 identity 3D LUT, bound to the LUT sampler whenever no real LUT is
 * active. `sampler3D` in GLSL always samples, even under a dead `if`, so the
 * unit must never be left without a valid texture — the identity keeps that
 * fetch harmless (and its result is discarded, since `uLutAmount` is 0 then).
 */
function buildIdentityLut(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, tex);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  // r fastest, then g, then b — the 8 corners of the colour cube.
  const d = new Uint8Array([
    0, 0, 0, 255, 0, 0, 0, 255, 0, 255, 255, 0, 0, 0, 255, 255, 0, 255, 0, 255, 255, 255, 255, 255,
  ]);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB8, 2, 2, 2, 0, gl.RGB, gl.UNSIGNED_BYTE, d);
  return tex;
}

/** The identity ramp baked to curve bytes (R=G=B=A=i), bound when no curve runs. */
function identityCurveBytes(): Uint8Array {
  const b = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    b[i * 4] = i;
    b[i * 4 + 1] = i;
    b[i * 4 + 2] = i;
    b[i * 4 + 3] = i;
  }
  return b;
}

/** Upload 256×1 RGBA8 curve bytes to a 1D-style lookup texture on unit 2. */
function buildCurveTextureGl(gl: WebGL2RenderingContext, bytes: Uint8Array): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // ArrayBufferView uploads ignore UNPACK_FLIP_Y, so the 256 entries map straight
  // to x = input code with no vertical flip to worry about on a 1px-tall texture.
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
  return tex;
}

function buildProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? 'shader compile failed');
    }
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'program link failed');
  }
  return program;
}

// null once initialisation has failed (no WebGL2), so we never retry every frame.
let grader: ColorGrader | null = null;
let tried = false;

function getGrader(): ColorGrader | null {
  if (tried) return grader;
  tried = true;
  try {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false });
    if (!gl) return null;
    grader = new ColorGrader(gl, canvas);
  } catch {
    grader = null;
  }
  return grader;
}

/**
 * Grade a frame and return a canvas the compositor can draw in its place, or
 * null when grading is unavailable (no WebGL2) or fails — the caller then draws
 * the ungraded frame. The returned canvas is reused across calls, so draw from
 * it immediately.
 */
export function gradeFrame(
  sample: DrawableFrame,
  w: number,
  h: number,
  adj: ResolvedColor,
): AnyCanvas | null {
  const g = getGrader();
  if (!g) return null;
  try {
    return g.grade(sample, w, h, adj);
  } catch {
    return null;
  }
}
