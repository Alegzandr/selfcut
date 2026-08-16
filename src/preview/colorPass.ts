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
import { frameColorSpace, frameTexSource, type TransferKind } from '../media/frameSource';
import type { ResolvedColor } from '../model';
import type { Lut } from '../types';
import { count } from '../perf/probe';

/** `uTransfer` values, matching the branch order in the fragment shader. */
const TRANSFER_CODE: Record<TransferKind, number> = { srgb: 0, pq: 1, hlg: 2, linear: 3 };

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
// Luma coefficients of the SOURCE, not a constant: BT.709 for HD and up,
// BT.601 for standard definition, BT.2020 for wide gamut. A fixed 601 matrix on
// HD footage tilts every desaturation toward red and mis-weights the key.
uniform vec3 uLuma;
// 0 = sRGB / BT.709-ish, 1 = PQ, 2 = HLG, 3 = already linear.
uniform int uTransfer;
// 1 enables the ordered dither on the 8-bit write.
uniform float uDither;

// --- Transfer functions -----------------------------------------------------
// Only the operations that are physically multiplicative in light - white
// balance and the vignette - cross into linear; the tone controls stay in the
// display-referred space where their sliders are defined and where every
// grading tool applies them. Linearizing a contrast S-curve would not make it
// "more exact", it would make it a different control.
vec3 srgbToLinear(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}
vec3 linearToSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
// SMPTE ST 2084. Normalized so 1.0 in equals 10000 nits, then scaled to the
// 100-nit SDR reference so a graded PQ frame lands in the same range as the rest.
vec3 pqToLinear(vec3 c) {
  const float m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  vec3 p = pow(clamp(c, 0.0, 1.0), vec3(1.0 / m2));
  return pow(max(p - c1, 0.0) / (c2 - c3 * p), vec3(1.0 / m1)) * 100.0;
}
vec3 linearToPq(vec3 c) {
  const float m1 = 0.1593017578125, m2 = 78.84375, c1 = 0.8359375, c2 = 18.8515625, c3 = 18.6875;
  vec3 y = pow(max(c, 0.0) / 100.0, vec3(m1));
  return pow((c1 + c2 * y) / (1.0 + c3 * y), vec3(m2));
}
// ARIB STD-B67 inverse OETF (scene light, 0..12 range).
vec3 hlgToLinear(vec3 c) {
  const float a = 0.17883277, b = 0.28466892, cc = 0.55991073;
  c = clamp(c, 0.0, 1.0);
  return mix(c * c / 3.0, (exp((c - cc) / a) + b) / 12.0, step(vec3(0.5), c));
}
vec3 linearToHlg(vec3 c) {
  const float a = 0.17883277, b = 0.28466892, cc = 0.55991073;
  c = max(c, 0.0);
  return mix(sqrt(3.0 * c), a * log(12.0 * c - b) + cc, step(vec3(1.0 / 12.0), c));
}
vec3 toLinear(vec3 c) {
  if (uTransfer == 1) return pqToLinear(c);
  if (uTransfer == 2) return hlgToLinear(c);
  if (uTransfer == 3) return c;
  return srgbToLinear(c);
}
vec3 fromLinear(vec3 c) {
  if (uTransfer == 1) return linearToPq(c);
  if (uTransfer == 2) return linearToHlg(c);
  if (uTransfer == 3) return c;
  return linearToSrgb(c);
}

// Interleaved gradient noise: a screen-space ordered dither with no texture and
// no visible pattern. Scaled to half a code value, it turns the banding a
// gentle gradient shows at 8 bits into a noise floor below the eye's threshold.
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec4 c = texture(tex, uv);
  vec3 rgb = c.rgb;
  float alpha = c.a;
  // Chroma key first, on the raw frame: keyed pixels drop to alpha 0 so lower
  // tracks show through. Matched in the Cb/Cr chroma plane (luma removed), so
  // shadows and highlights on the green screen key as one hue. Green spill on the
  // subject is pulled toward the red/blue max, the standard suppression.
  if (uKeyOn > 0.5) {
    // The Cb/Cr scale factors follow from the luma coefficients themselves
    // (Cb = (B-Y)/2(1-Kb), Cr = (R-Y)/2(1-Kr)), so the plane the key matches in
    // is the source's own chroma plane whatever its matrix.
    float kb = 2.0 * (1.0 - uLuma.b);
    float kr = 2.0 * (1.0 - uLuma.r);
    float ky = dot(uKeyColor, uLuma);
    vec2 kcc = vec2((uKeyColor.b - ky) / kb, (uKeyColor.r - ky) / kr);
    float py = dot(rgb, uLuma);
    vec2 pcc = vec2((rgb.b - py) / kb, (rgb.r - py) / kr);
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
  rgb += uBright;                               // brightness: a display lift

  // --- Linear light -----------------------------------------------------
  if (uTemp != 0.0 || uTint != 0.0 || uVignette > 0.0) {
    vec3 lin = toLinear(rgb);
    if (uTemp != 0.0 || uTint != 0.0) {
      // White balance is a set of channel GAINS - what a sensor's white point
      // actually is - not an offset. An offset in the encoded signal lifts the
      // blacks, which is why a cooled shot used to come back with blue shadows.
      vec3 gain = vec3(exp2(uTemp * 0.5), exp2(uTint * 0.35), exp2(-uTemp * 0.5));
      // Renormalized on the source's own luma, so moving the slider changes the
      // colour of white and not its brightness.
      lin *= gain / max(dot(uLuma, gain), 1e-4);
    }
    if (uVignette > 0.0) {
      float d = distance(uv, vec2(0.5));
      float v = smoothstep(0.75, 0.35, d);      // 1 at centre, 0 at corners
      lin *= mix(1.0, v, uVignette);            // a light falloff, so: in light
    }
    rgb = fromLinear(lin);
  }
  // --- Back in the display-referred space -------------------------------

  rgb = (rgb - 0.5) * (1.0 + uContrast) + 0.5;  // contrast around mid grey
  float luma = dot(rgb, uLuma);
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
  // The whole pass ran at float precision; this is the one quantization, so it
  // is the one place worth spending half a code value of noise on.
  rgb += uDither * (ign(gl_FragCoord.xy) - 0.5) / 255.0;
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
  uLuma: WebGLUniformLocation | null;
  uTransfer: WebGLUniformLocation | null;
  uDither: WebGLUniformLocation | null;
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
  /**
   * Scratch 2D canvas a frame is rasterized into before upload, for the frames
   * that cannot be handed to the GPU directly (rotated samples). Null until one
   * turns up, which on most projects is never.
   */
  private scratch: AnyCanvas | null = null;
  private scratchCtx: Ctx2D | null = null;
  private w = 0;
  private h = 0;
  /**
   * False once a half-float upload has been refused by the driver, so a
   * high-bit-depth source falls back to 8 bits permanently instead of throwing
   * on every frame.
   */
  private halfFloatOk = true;
  /** Internal format the frame texture currently holds, so a switch re-allocates. */
  private texIsHalfFloat = false;
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
      uLuma: gl.getUniformLocation(program, 'uLuma'),
      uTransfer: gl.getUniformLocation(program, 'uTransfer'),
      uDither: gl.getUniformLocation(program, 'uDither'),
    };
    gl.uniform1f(this.uniforms.uDither, 1);
  }

  /**
   * The 2D canvas a frame is rasterized into when it cannot be uploaded
   * directly. Built on first need: a session whose footage all uploads straight
   * to the GPU - every unrotated video sample and every still - never allocates
   * a full-frame scratch at all.
   */
  private ensureScratch(w: number, h: number): Ctx2D | null {
    if (!this.scratch) {
      this.scratch = new OffscreenCanvas(w, h);
      this.scratchCtx = this.scratch.getContext('2d');
    }
    if (this.scratch.width !== w || this.scratch.height !== h) {
      this.scratch.width = w;
      this.scratch.height = h;
    }
    return this.scratchCtx;
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
    this.gl.viewport(0, 0, w, h);
  }

  /**
   * Get the frame onto the GPU.
   *
   * The fast path hands WebGL the decoded frame itself - a `VideoFrame` or an
   * `ImageBitmap` - which the driver uploads (and colour-converts) without the
   * frame ever being rasterized into a canvas and read back. That removes a
   * full-frame copy AND a full-frame 8-bit quantization per graded clip per
   * frame; at 4K it is ~33 MB of traffic per clip per frame that no longer
   * happens.
   *
   * The slow path exists for frames whose rotation metadata only `draw` honours.
   */
  private upload(sample: DrawableFrame, w: number, h: number, highDepth: boolean): boolean {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);

    const wantHalf = highDepth && this.halfFloatOk;
    // A format change re-specifies the whole texture, so it must not be done
    // per frame: it is driven by the source, which is stable for a clip.
    if (wantHalf !== this.texIsHalfFloat) this.texIsHalfFloat = wantHalf;

    const direct = frameTexSource(sample);
    const source = direct ?? this.rasterize(sample, w, h);
    if (!source) return false;
    count(direct ? 'texUploadDirect' : 'texUploadCopy');
    if (wantHalf) {
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, source);
        return true;
      } catch {
        // Some drivers reject a DOM-source upload into a half-float texture.
        // Note it once and never pay the exception again.
        this.halfFloatOk = false;
        this.texIsHalfFloat = false;
      }
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return true;
  }

  private rasterize(sample: DrawableFrame, w: number, h: number): AnyCanvas | null {
    const ctx = this.ensureScratch(w, h);
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    sample.draw(ctx, 0, 0, w, h, 0, 0, w, h);
    return this.scratch;
  }

  grade(sample: DrawableFrame, w: number, h: number, adj: ResolvedColor): AnyCanvas | null {
    if (w <= 0 || h <= 0) return null;
    this.resize(w, h);

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

    // The source's own colour description drives the luma matrix and the
    // transfer function, so a BT.709 clip and a BT.601 clip are not graded with
    // the same maths just because they happen to be in the same timeline.
    const cs = frameColorSpace(sample);
    gl.uniform3f(this.uniforms.uLuma, cs.luma.r, cs.luma.g, cs.luma.b);
    gl.uniform1i(this.uniforms.uTransfer, TRANSFER_CODE[cs.transfer]);

    if (!this.upload(sample, w, h, cs.highBitDepth)) return null;
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

/**
 * The grader for this thread, and the state machine around building it.
 *
 * A GPU context is not a thing you get once. It is lost when the driver resets,
 * when the tab is backgrounded on some machines, or when another tab exhausts
 * the GPU process - and it comes back. Latching "we tried once, it failed" would
 * mean a single driver hiccup silently ungraded every clip for the rest of the
 * session, with the picture quietly wrong rather than visibly broken.
 *
 * So: a lost context tears the grader down and the next frame rebuilds it. A
 * genuine absence of WebGL2 (`unsupported`) is the only permanent state, and
 * a build that throws backs off rather than retrying 60 times a second.
 */
type GraderState = 'idle' | 'ready' | 'unsupported' | 'backoff';

let grader: ColorGrader | null = null;
let graderState: GraderState = 'idle';
/** Earliest time a `backoff` state may try again (performance.now()). */
let retryAfter = 0;
/** Backoff between rebuild attempts: long enough that a hard failure is not a per-frame cost. */
const REBUILD_BACKOFF_MS = 2000;

/** Observable for the UI: how many times the context has been lost this session. */
let contextLosses = 0;
export function graderContextLosses(): number {
  return contextLosses;
}

/** Drop the grader so the next frame rebuilds it. Exported for tests. */
export function resetGrader(): void {
  grader = null;
  graderState = 'idle';
  retryAfter = 0;
}

function getGrader(): ColorGrader | null {
  if (graderState === 'ready') return grader;
  if (graderState === 'unsupported') return null;
  if (graderState === 'backoff' && performance.now() < retryAfter) return null;
  try {
    if (typeof OffscreenCanvas === 'undefined') {
      graderState = 'unsupported';
      return null;
    }
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false });
    if (!gl) {
      graderState = 'unsupported';
      return null;
    }
    // `webglcontextlost` must be cancelled for the context to ever be restored;
    // without preventDefault the browser will not fire `webglcontextrestored`.
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      contextLosses++;
      grader = null;
      graderState = 'idle';
    });
    canvas.addEventListener('webglcontextrestored', () => {
      // The old ColorGrader holds dead texture and program handles; a rebuild
      // from `idle` on the next frame is the only safe recovery.
      grader = null;
      graderState = 'idle';
    });
    grader = new ColorGrader(gl, canvas);
    graderState = 'ready';
  } catch {
    grader = null;
    graderState = 'backoff';
    retryAfter = performance.now() + REBUILD_BACKOFF_MS;
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
    // A throw here is the context dying mid-frame in all but name: drop the
    // grader so the next frame rebuilds instead of failing forever.
    grader = null;
    graderState = 'backoff';
    retryAfter = performance.now() + REBUILD_BACKOFF_MS;
    return null;
  }
}
