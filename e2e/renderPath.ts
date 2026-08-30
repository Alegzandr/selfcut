import { test } from './test';
import { type Page } from '@playwright/test';

/**
 * Whether this browser composites on a GPU - and saying so out loud.
 *
 * The millisecond budgets in the perf specs are claims about a GPU. A
 * 1920x1080 `drawImage` is a texture blit on one and a per-pixel copy through
 * the CPU on a software rasterizer, and the gap is not a percentage: the same
 * `blit` channel measures 0.04 ms on a discrete GPU and 15-25 ms under
 * SwiftShader on a hosted CI runner. An export inverts wholesale - compositing
 * is 5% of a frame with a GPU and 95% without, because the encoder never gets
 * a chance to be the bottleneck.
 *
 * So on a machine with no GPU a frame-budget assertion no longer describes the
 * code under test; it describes the absence of the GPU. The specs ask here
 * first and assert the budget only where the budget means something, which
 * keeps the structural assertions - "the frame reached the texture without a
 * copy", "a sixteenth-area mask touched a sixteenth of the frame" - running
 * everywhere, since those hold on any rasterizer.
 *
 * Chromium falls back to SwiftShader for the whole GPU process rather than per
 * API, so WebGL's unmasked renderer answers for the 2D canvas path too. Hosted
 * runners report SwiftShader; a Linux box on a Mesa software driver reports
 * llvmpipe or softpipe.
 */

const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

export interface RenderPath {
  /** Unmasked WebGL renderer, or '' when no context could be created. */
  renderer: string;
  /** True when compositing is hardware accelerated. */
  hardware: boolean;
}

export async function renderPath(page: Page): Promise<RenderPath> {
  const renderer = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl: WebGLRenderingContext | WebGL2RenderingContext | null =
      canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(
      ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    );
  });

  const hardware = renderer !== '' && !SOFTWARE.test(renderer);

  // Loud on purpose. A misdetection here silently retires a budget assertion,
  // which is the one failure mode of this helper that nothing else would catch.
  test.info().annotations.push({
    type: hardware ? 'gpu' : 'software rasterizer',
    description: renderer || 'no WebGL context',
  });
  console.log(
    `  renderer: ${renderer || 'none'}\n` +
      `  -> ${hardware ? 'hardware, frame budgets asserted' : 'SOFTWARE, frame budgets relaxed'}`,
  );

  return { renderer, hardware };
}
