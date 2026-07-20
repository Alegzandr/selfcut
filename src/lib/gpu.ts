/**
 * Software-rendering detection.
 *
 * WebCodecs still works without a GPU, but every decode/encode falls back to
 * the CPU: preview stutters and exports take several times longer. There is no
 * API that reports "hardware acceleration is off", so we probe the WebGL
 * renderer string - the same signal chrome://gpu reports - and match the known
 * software rasterizers.
 */

const SOFTWARE_RENDERERS = [
  'swiftshader', // Chrome/Edge software GL
  'llvmpipe', // Mesa software rasterizer (Linux)
  'softpipe',
  'software rasterizer',
  'microsoft basic render driver', // Windows WARP fallback
  'generic renderer',
  'apple software renderer',
];

/**
 * True when the browser is rendering through a software rasterizer, or cannot
 * get a GL context at all. Returns false when the renderer cannot be read -
 * an unknown GPU is not evidence of a missing one, and a false alarm here is
 * worse than a missed one.
 */
export function isSoftwareRendering(): boolean {
  let canvas: HTMLCanvasElement;
  try {
    canvas = document.createElement('canvas');
  } catch {
    return false;
  }

  const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
  // No GL context at all: acceleration is off or blocklisted.
  if (!gl) return true;

  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '',
    ).toLowerCase();
    if (!renderer) return false;
    return SOFTWARE_RENDERERS.some((name) => renderer.includes(name));
  } catch {
    return false;
  } finally {
    // Free the context immediately: probing must not hold a GL slot open.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
