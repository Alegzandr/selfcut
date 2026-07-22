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
in vec2 uv;
out vec4 outColor;
uniform sampler2D tex;
uniform float uBright, uContrast, uSat, uTemp, uTint, uVignette;
void main() {
  vec4 c = texture(tex, uv);
  vec3 rgb = c.rgb;
  rgb += uBright;                              // exposure
  rgb.r += uTemp * 0.12;                        // white balance: warm/cool
  rgb.b -= uTemp * 0.12;
  rgb.g += uTint * 0.12;                        // green/magenta
  rgb = (rgb - 0.5) * (1.0 + uContrast) + 0.5;  // contrast around mid grey
  float luma = dot(rgb, vec3(0.299, 0.587, 0.114));
  rgb = mix(vec3(luma), rgb, 1.0 + uSat);       // saturation
  if (uVignette > 0.0) {
    float d = distance(uv, vec2(0.5));
    float v = smoothstep(0.75, 0.35, d);        // 1 at centre, 0 at corners
    rgb *= mix(1.0, v, uVignette);
  }
  outColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
}`;

interface Uniforms {
  uBright: WebGLUniformLocation | null;
  uContrast: WebGLUniformLocation | null;
  uSat: WebGLUniformLocation | null;
  uTemp: WebGLUniformLocation | null;
  uTint: WebGLUniformLocation | null;
  uVignette: WebGLUniformLocation | null;
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
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);

    this.uniforms = {
      uBright: gl.getUniformLocation(program, 'uBright'),
      uContrast: gl.getUniformLocation(program, 'uContrast'),
      uSat: gl.getUniformLocation(program, 'uSat'),
      uTemp: gl.getUniformLocation(program, 'uTemp'),
      uTint: gl.getUniformLocation(program, 'uTint'),
      uVignette: gl.getUniformLocation(program, 'uVignette'),
    };

    this.scratch = new OffscreenCanvas(1, 1);
    this.scratchCtx = this.scratch.getContext('2d')!;
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
