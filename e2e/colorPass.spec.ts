import { test, expect } from '@playwright/test';
import { appModuleUrl } from './appModule';

/**
 * What the colour pass actually computes.
 *
 * The grade runs in a fragment shader, so none of it can be reached from a unit
 * test - there is no WebGL2 in Node. It is also the part of the renderer where a
 * wrong constant is invisible: a desaturation weighted with the wrong luma
 * matrix looks like a desaturation, and a white balance that lifts the blacks
 * looks like a white balance. So the shader is driven here, in a real browser,
 * with inputs whose correct outputs can be worked out on paper.
 *
 * Three claims are checked:
 *  - luma uses the SOURCE's matrix (BT.709 for HD), not a hardcoded BT.601;
 *  - white balance is a luma-preserving gain in linear light, not an offset on
 *    the encoded signal (which is what used to tint the shadows);
 *  - the 8-bit write is dithered, so a gradient does not band.
 */

const COLOR_MODULE = '/src/preview/colorPass.ts';

/** Read back the graded pixels of a solid-colour frame. */
async function gradeSolid(
  page: import('@playwright/test').Page,
  rgb: [number, number, number],
  adjust: Record<string, number>,
): Promise<[number, number, number]> {
  const mod = await appModuleUrl(page, COLOR_MODULE);
  return page.evaluate(
    async ({ url, color, adj }) => {
      const { gradeFrame } = (await import(url)) as {
        gradeFrame: (
          sample: unknown,
          w: number,
          h: number,
          adj: unknown,
        ) => OffscreenCanvas | null;
      };
      const W = 64;
      const H = 64;
      const src = new OffscreenCanvas(W, H);
      const sctx = src.getContext('2d')!;
      sctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
      sctx.fillRect(0, 0, W, H);
      const bitmap = await createImageBitmap(src);

      // A minimal DrawableFrame. `displayHeight` of 1080 is what makes the
      // shader pick the HD luma matrix, which is the point of one of the tests.
      const sample = {
        displayWidth: W,
        displayHeight: 1080,
        draw: (
          ctx: OffscreenCanvasRenderingContext2D,
          sx: number,
          sy: number,
          sw: number,
          sh: number,
          dx: number,
          dy: number,
          dw: number,
          dh: number,
        ) => ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh),
        toCanvasImageSource: () => bitmap,
        rotation: 0,
        colorSpace: null,
        format: 'RGBA',
      };

      const out = gradeFrame(sample, W, H, {
        brightness: 0,
        contrast: 0,
        saturation: 0,
        temperature: 0,
        tint: 0,
        vignette: 0,
        ...adj,
      });
      if (!out) return null;
      const read = new OffscreenCanvas(W, H);
      const rctx = read.getContext('2d', { willReadFrequently: true })!;
      rctx.drawImage(out, 0, 0);
      // The centre, away from any vignette falloff.
      const { data } = rctx.getImageData(W / 2, H / 2, 1, 1);
      return [data[0]!, data[1]!, data[2]!];
    },
    { url: mod, color: rgb, adj: adjust },
  ) as Promise<[number, number, number]>;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
});

test('a neutral grade returns the frame it was given', async ({ page }) => {
  // The identity has to be exact, or every assertion below is measuring drift
  // rather than the thing it names. One code value of slack, for the dither.
  for (const color of [
    [0, 0, 0],
    [64, 128, 192],
    [255, 255, 255],
  ] as [number, number, number][]) {
    const out = await gradeSolid(page, color, {});
    expect(out).not.toBeNull();
    for (let i = 0; i < 3; i++) expect(Math.abs(out[i]! - color[i]!)).toBeLessThanOrEqual(1);
  }
});

test('desaturation weights luma with the BT.709 matrix, not BT.601', async ({ page }) => {
  // Pure red, fully desaturated, becomes its luma in grey. The two matrices
  // disagree by a wide margin on red: BT.709 gives 0.2126, BT.601 gives 0.299.
  // In an 8-bit encoded signal that is roughly 128 versus 149 - not a subtlety.
  const out = await gradeSolid(page, [255, 0, 0], { saturation: -1 });
  const grey = out[0]!;
  expect(out[1]!).toBeCloseTo(grey, -1);
  expect(out[2]!).toBeCloseTo(grey, -1);

  // Computed on the encoded signal, as the shader does: 0.2126 * 255 = 54.2.
  const bt709 = 0.2126 * 255;
  const bt601 = 0.299 * 255;
  expect(Math.abs(grey - bt709)).toBeLessThan(6);
  expect(Math.abs(grey - bt601)).toBeGreaterThan(10);
});

test('white balance is a gain, so it does not tint the blacks', async ({ page }) => {
  // The regression this replaces: `rgb.r += uTemp * 0.12` on the encoded signal,
  // which lifted a pure black to a visible red. A gain leaves black at black,
  // because any gain times zero is zero.
  const warmBlack = await gradeSolid(page, [0, 0, 0], { temperature: 1 });
  expect(warmBlack[0]!).toBeLessThanOrEqual(2);
  expect(warmBlack[2]!).toBeLessThanOrEqual(2);

  const coolBlack = await gradeSolid(page, [0, 0, 0], { temperature: -1 });
  expect(coolBlack[0]!).toBeLessThanOrEqual(2);
  expect(coolBlack[2]!).toBeLessThanOrEqual(2);
});

test('white balance moves the colour of white without moving its brightness', async ({ page }) => {
  const neutral: [number, number, number] = [128, 128, 128];
  const warm = await gradeSolid(page, neutral, { temperature: 0.6 });
  // Warm means more red and less blue - that is what the control says it does.
  expect(warm[0]!).toBeGreaterThan(neutral[0]! + 5);
  expect(warm[2]!).toBeLessThan(neutral[2]! - 5);

  // ...and the luma is preserved, which is what a white balance IS: the gains
  // are renormalized on the source's own luma coefficients. Computed in linear
  // light, where the mix actually happens.
  const toLinear = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luma = (c: [number, number, number]): number =>
    0.2126 * toLinear(c[0]) + 0.7152 * toLinear(c[1]) + 0.0722 * toLinear(c[2]);
  expect(luma(warm)).toBeCloseTo(luma(neutral), 1);
});

test('the vignette darkens toward the corners and leaves the centre alone', async ({ page }) => {
  const mod = await appModuleUrl(page, COLOR_MODULE);
  const samples = await page.evaluate(async (url) => {
    const { gradeFrame } = (await import(url)) as {
      gradeFrame: (s: unknown, w: number, h: number, adj: unknown) => OffscreenCanvas | null;
    };
    const W = 64;
    const H = 64;
    const src = new OffscreenCanvas(W, H);
    const sctx = src.getContext('2d')!;
    sctx.fillStyle = 'rgb(200, 200, 200)';
    sctx.fillRect(0, 0, W, H);
    const bitmap = await createImageBitmap(src);
    const sample = {
      displayWidth: W,
      displayHeight: 1080,
      draw: () => {},
      toCanvasImageSource: () => bitmap,
      rotation: 0,
      colorSpace: null,
      format: 'RGBA',
    };
    const out = gradeFrame(sample, W, H, {
      brightness: 0,
      contrast: 0,
      saturation: 0,
      temperature: 0,
      tint: 0,
      vignette: 1,
    });
    if (!out) return null;
    const read = new OffscreenCanvas(W, H);
    const rctx = read.getContext('2d', { willReadFrequently: true })!;
    rctx.drawImage(out, 0, 0);
    const centre = rctx.getImageData(W / 2, H / 2, 1, 1).data[0]!;
    const corner = rctx.getImageData(1, 1, 1, 1).data[0]!;
    return { centre, corner };
  }, mod);

  expect(samples).not.toBeNull();
  // The centre is untouched...
  expect(samples!.centre).toBeGreaterThan(190);
  // ...and the corners are deeply darkened.
  expect(samples!.corner).toBeLessThan(samples!.centre * 0.4);

  // And the darkening happened in LINEAR light, which is what a light falloff
  // is. The same multiplier applied to the encoded signal - what the shader
  // used to do - would put the corner near 200 * 0.07 = 14. Doing it in linear
  // and re-encoding lands far higher, because the transfer curve gives back
  // most of what a multiply takes away in the shadows.
  expect(samples!.corner).toBeGreaterThan(30);
});

test('the 8-bit write is dithered, so a flat ramp does not band', async ({ page }) => {
  const mod = await appModuleUrl(page, COLOR_MODULE);
  const result = await page.evaluate(async (url) => {
    const { gradeFrame } = (await import(url)) as {
      gradeFrame: (s: unknown, w: number, h: number, adj: unknown) => OffscreenCanvas | null;
    };
    const W = 256;
    const H = 64;
    const src = new OffscreenCanvas(W, H);
    const sctx = src.getContext('2d')!;
    // A single flat grey. Any variation in the output is the dither and nothing
    // else, which makes it measurable instead of merely visible.
    sctx.fillStyle = 'rgb(100, 100, 100)';
    sctx.fillRect(0, 0, W, H);
    const bitmap = await createImageBitmap(src);
    const sample = {
      displayWidth: W,
      displayHeight: 1080,
      draw: () => {},
      toCanvasImageSource: () => bitmap,
      rotation: 0,
      colorSpace: null,
      format: 'RGBA',
    };
    // A gentle lift that lands between two code values: without dither every
    // pixel rounds the same way and the result is a flat, quantized plateau.
    const out = gradeFrame(sample, W, H, {
      brightness: 0.002,
      contrast: 0,
      saturation: 0,
      temperature: 0,
      tint: 0,
      vignette: 0,
    });
    if (!out) return null;
    const read = new OffscreenCanvas(W, H);
    const rctx = read.getContext('2d', { willReadFrequently: true })!;
    rctx.drawImage(out, 0, 0);
    const { data } = rctx.getImageData(0, 0, W, H);
    const counts = new Map<number, number>();
    for (let i = 0; i < data.length; i += 4) {
      counts.set(data[i]!, (counts.get(data[i]!) ?? 0) + 1);
    }
    const levels = [...counts.keys()].sort((a, b) => a - b);
    return { levels, total: (W * H) };
  }, mod);

  expect(result).not.toBeNull();
  // Two adjacent code values, mixed - that is what a half-LSB dither produces
  // from a value sitting between them. One single level would mean no dither.
  expect(result!.levels.length).toBeGreaterThanOrEqual(2);
  // ...and no more than a few: a dither is half a code value of noise, not a
  // visible grain.
  expect(result!.levels.length).toBeLessThanOrEqual(3);
  expect(result!.levels[result!.levels.length - 1]! - result!.levels[0]!).toBeLessThanOrEqual(2);
});
