import { test, expect } from '@playwright/test';
import { appModuleUrl } from './appModule';

/**
 * What a redaction region actually does to the pixels.
 *
 * None of this is reachable from a unit test: the blur is the browser's own
 * gaussian filter, the mosaic is a downscale-upscale through a canvas, and both
 * are composited with `destination-out` — Node has no canvas at all. It is also
 * exactly the kind of code where a mistake still looks like a feature: a blur
 * that leaks past its shape, a mosaic whose cells crawl, or a region that
 * doubles the clip's opacity all read as "the blur works" in a screenshot.
 *
 * So the compositor is driven here, on a one-pixel checkerboard, whose correct
 * answers can be stated exactly: neighbouring pixels differ by the full range
 * before a redaction touches them, and stop differing after.
 */

const COMPOSITOR = '/src/preview/compositor.ts';

interface Probe {
  /** Mean absolute difference between horizontal neighbours, 0..255. */
  detail: number;
  /** Share of horizontal neighbour pairs that are exactly equal, 0..1. */
  flat: number;
  /** Mean alpha, 0..255. */
  alpha: number;
}

type Region = Record<string, unknown>;

/**
 * Draw a checkerboard clip carrying `redactions`, and measure the picture inside
 * and outside the region. `alphaMul` is the track opacity the clip is drawn at.
 */
async function render(
  page: import('@playwright/test').Page,
  redactions: Region[],
  alphaMul = 1,
): Promise<{ inside: Probe; outside: Probe }> {
  const url = await appModuleUrl(page, COMPOSITOR);
  return page.evaluate(
    async ({ mod, regions, alpha }) => {
      const { drawClip } = (await import(mod)) as {
        drawClip: (...args: unknown[]) => void;
      };
      const SIZE = 240;

      // A one-pixel checkerboard: every horizontal neighbour differs by the
      // full range, so any loss of detail is unambiguous and needs no epsilon.
      const src = new OffscreenCanvas(SIZE, SIZE);
      const sctx = src.getContext('2d')!;
      const img = sctx.createImageData(SIZE, SIZE);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const v = (x + y) % 2 === 0 ? 255 : 0;
          const i = (y * SIZE + x) * 4;
          img.data[i] = v;
          img.data[i + 1] = v;
          img.data[i + 2] = v;
          img.data[i + 3] = 255;
        }
      }
      sctx.putImageData(img, 0, 0);
      const bitmap = await createImageBitmap(src);

      const sample = {
        displayWidth: SIZE,
        displayHeight: SIZE,
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

      const clip = {
        kind: 'media',
        id: 'c',
        assetId: 'a',
        trackId: 't',
        timelineStartMs: 0,
        sourceInMs: 0,
        sourceOutMs: 1000,
        speed: 1,
        volume: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
        ...(regions.length ? { redactions: regions } : {}),
      };

      const out = new OffscreenCanvas(SIZE, SIZE);
      const octx = out.getContext('2d', { willReadFrequently: true })!;
      drawClip(octx, clip, SIZE, SIZE, 0, alpha, 0, sample);

      /** Measure a square of the output, given its centre and half-size in px. */
      const probe = (cx: number, cy: number, half: number) => {
        const { data } = octx.getImageData(cx - half, cy - half, half * 2, half * 2);
        const w = half * 2;
        let diff = 0;
        let equal = 0;
        let alphaSum = 0;
        let pairs = 0;
        for (let y = 0; y < w; y++) {
          for (let x = 0; x < w; x++) {
            alphaSum += data[(y * w + x) * 4 + 3]!;
            if (x + 1 >= w) continue;
            const a = data[(y * w + x) * 4]!;
            const b = data[(y * w + x + 1) * 4]!;
            diff += Math.abs(a - b);
            if (a === b) equal++;
            pairs++;
          }
        }
        return { detail: diff / pairs, flat: equal / pairs, alpha: alphaSum / (w * w) };
      };

      // The regions under test are centred on the frame's top-left quadrant, so
      // the bottom-right quadrant is always the untouched control.
      return { inside: probe(SIZE * 0.3, SIZE * 0.3, 20), outside: probe(SIZE * 0.75, SIZE * 0.75, 20) };
    },
    { mod: url, regions: redactions, alpha: alphaMul },
  );
}

/** A hard-edged square region over the frame's top-left quadrant. */
const square = (over: Region = {}): Region => ({
  id: 'r1',
  mode: 'blur',
  amount: 0.8,
  shape: 'rect',
  x: 0.3,
  y: 0.3,
  w: 0.3,
  h: 0.3,
  feather: 0,
  ...over,
});

test.beforeEach(async ({ page }) => {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
});

test('a clip with no redaction keeps every pixel of its detail', async ({ page }) => {
  const { inside, outside } = await render(page, []);
  // The baseline every other assertion is measured against: a checkerboard whose
  // neighbours differ by the whole range, everywhere.
  expect(inside.detail).toBeGreaterThan(200);
  expect(outside.detail).toBeGreaterThan(200);
});

test('blur destroys the detail inside the region and none outside it', async ({ page }) => {
  const { inside, outside } = await render(page, [square()]);
  expect(inside.detail).toBeLessThan(5);
  // The blur samples its neighbours from beyond the region, so the pixels next
  // to it must come back untouched: a filter applied to a cut-out sub-rectangle
  // instead would darken the region's own edge and bleed past it.
  expect(outside.detail).toBeGreaterThan(200);
});

test('a mosaic flattens the region into cells, several pixels wide', async ({ page }) => {
  const { inside, outside } = await render(page, [square({ mode: 'pixelate' })]);
  // Cells are at least three pixels across, so most horizontal neighbours end up
  // holding exactly the same value - which a checkerboard never does.
  expect(inside.flat).toBeGreaterThan(0.5);
  expect(outside.flat).toBeLessThan(0.05);
  // Flat, but not uniform: a mosaic that averaged the whole region into one
  // colour would also pass the test above.
  expect(inside.detail).toBeGreaterThan(0);
});

test('strength is what decides how much survives', async ({ page }) => {
  const weak = await render(page, [square({ mode: 'pixelate', amount: 0 })]);
  const strong = await render(page, [square({ mode: 'pixelate', amount: 1 })]);
  // Bigger cells, so more neighbours inside one cell.
  expect(strong.inside.flat).toBeGreaterThan(weak.inside.flat);
});

test('several regions on one clip each hide their own area', async ({ page }) => {
  const { inside, outside } = await render(page, [
    square(),
    square({ id: 'r2', mode: 'pixelate', x: 0.75, y: 0.75 }),
  ]);
  // One shot, two things to hide: the whole reason a clip carries a list.
  expect(inside.detail).toBeLessThan(5);
  expect(outside.flat).toBeGreaterThan(0.5);
});

test('an inverted region hides everything except its shape', async ({ page }) => {
  const { inside, outside } = await render(page, [square({ invert: true })]);
  expect(inside.detail).toBeGreaterThan(200);
  expect(outside.detail).toBeLessThan(5);
});

test('a disabled region does nothing at all', async ({ page }) => {
  const { inside } = await render(page, [square({ disabled: true })]);
  expect(inside.detail).toBeGreaterThan(200);
});

test('a region does not change how opaque the clip is', async ({ page }) => {
  // The invariant behind punching the shape out before dropping the obscured
  // copy in: laying a blurred copy over the original instead would composite the
  // clip twice, and a half-faded clip would show its redactions as a denser
  // patch - 128 alpha becoming 192.
  const plain = await render(page, [], 0.5);
  const hard = await render(page, [square()], 0.5);
  expect(hard.inside.alpha).toBeCloseTo(plain.inside.alpha, 0);

  // Feathered, the punch and the copy share one kernel so their alphas still sum
  // to the clip's own - to within what an 8-bit composite can hold. Each of the
  // two halves is rounded to a code before they are added, so the soft band
  // gives up a fraction of a percent. The bug this is here to catch is worth 50%.
  const feathered = await render(page, [square({ feather: 0.08 })], 0.5);
  expect(Math.abs(feathered.inside.alpha - plain.inside.alpha)).toBeLessThan(4);
  expect(feathered.outside.alpha).toBeCloseTo(plain.outside.alpha, 0);
});
