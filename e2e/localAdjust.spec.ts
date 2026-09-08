import { test, expect } from './test';
import { appModuleUrl } from './appModule';

/**
 * What a masked grade actually does to the pixels.
 *
 * None of it is reachable from a unit test: the grade is a fragment shader, the
 * matte is a `destination-out` composite, and Node has neither. It is also the
 * kind of code where a mistake still looks like the feature working — a grade
 * that leaks past its shape, one that lands on the whole clip, or one that
 * doubles the clip's opacity inside the region all read as "the region graded"
 * in a screenshot.
 *
 * So the compositor is driven here, on a flat mid grey whose correct answers can
 * be stated exactly: a brightness lift is an addition on the encoded signal, so
 * 128 with +0.4 lands at 128 + 0.4 * 255 = 230, and everything outside the shape
 * stays at 128.
 */

const COMPOSITOR = '/src/preview/compositor.ts';

type Region = Record<string, unknown>;

interface Probe {
  /** Mean of the red channel over the probed square, 0..255. */
  level: number;
  /** Mean alpha, 0..255. */
  alpha: number;
}

/**
 * Draw a flat grey clip carrying `localAdjusts` at `timelineMs`, and measure the
 * picture inside and outside the region. `alphaMul` is the track opacity.
 */
async function render(
  page: import('@playwright/test').Page,
  adjusts: Region[],
  timelineMs = 0,
  alphaMul = 1,
): Promise<{ inside: Probe; outside: Probe }> {
  const url = await appModuleUrl(page, COMPOSITOR);
  return page.evaluate(
    async ({ mod, regions, t, alpha }) => {
      const { drawClip } = (await import(mod)) as { drawClip: (...args: unknown[]) => void };
      const SIZE = 240;

      const src = new OffscreenCanvas(SIZE, SIZE);
      const sctx = src.getContext('2d')!;
      sctx.fillStyle = 'rgb(128, 128, 128)';
      sctx.fillRect(0, 0, SIZE, SIZE);
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
        sourceOutMs: 2000,
        speed: 1,
        volume: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
        ...(regions.length ? { localAdjusts: regions } : {}),
      };

      const out = new OffscreenCanvas(SIZE, SIZE);
      const octx = out.getContext('2d', { willReadFrequently: true })!;
      drawClip(octx, clip, SIZE, SIZE, t, alpha, 0, sample);

      const probe = (cx: number, cy: number, half: number): Probe => {
        const { data } = octx.getImageData(cx - half, cy - half, half * 2, half * 2);
        let level = 0;
        let alphaSum = 0;
        const n = half * 2 * half * 2;
        for (let i = 0; i < data.length; i += 4) {
          level += data[i]!;
          alphaSum += data[i + 3]!;
        }
        return { level: level / n, alpha: alphaSum / n };
      };

      // The regions under test are centred on the frame's top-left quadrant, so
      // the bottom-right quadrant is always the untouched control.
      return {
        inside: probe(SIZE * 0.3, SIZE * 0.3, 15),
        outside: probe(SIZE * 0.75, SIZE * 0.75, 15),
      };
    },
    { mod: url, regions: adjusts, t: timelineMs, alpha: alphaMul },
  );
}

/** A hard-edged square region over the frame's top-left quadrant. */
const square = (color: Region, over: Region = {}): Region => ({
  id: 'a1',
  color,
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

test('a clip with no region is the clip', async ({ page }) => {
  const { inside, outside } = await render(page, []);
  expect(inside.level).toBeCloseTo(128, -1);
  expect(outside.level).toBeCloseTo(128, -1);
});

test('the grade lands inside the shape and nowhere else', async ({ page }) => {
  const { inside, outside } = await render(page, [square({ brightness: 0.4 })]);
  // 128 + 0.4 * 255 = 230, worked out on the encoded signal the shader adds to.
  expect(Math.abs(inside.level - 230)).toBeLessThan(4);
  // The control quadrant is untouched: a region that graded the whole clip
  // would read 230 here too, and that is the failure worth catching.
  expect(Math.abs(outside.level - 128)).toBeLessThan(2);
});

test('an inverted region grades everything except its shape', async ({ page }) => {
  const { inside, outside } = await render(page, [square({ brightness: 0.4 }, { invert: true })]);
  expect(Math.abs(inside.level - 128)).toBeLessThan(2);
  expect(Math.abs(outside.level - 230)).toBeLessThan(4);
});

test('a muted region does nothing at all', async ({ page }) => {
  const { inside } = await render(page, [square({ brightness: 0.4 }, { disabled: true })]);
  expect(Math.abs(inside.level - 128)).toBeLessThan(2);
});

test('regions stack, each grading the result of the one before it', async ({ page }) => {
  const { inside } = await render(page, [
    square({ brightness: 0.2 }),
    square({ brightness: 0.2 }, { id: 'a2' }),
  ]);
  // Two lifts of 51 code values over the same square, applied in order.
  expect(Math.abs(inside.level - 230)).toBeLessThan(5);
});

test('a keyframed parameter animates inside the region', async ({ page }) => {
  const ramp = [square({ brightness: [{ t: 0, value: 0 }, { t: 1000, value: 0.4 }] })];
  const start = await render(page, ramp, 0);
  const end = await render(page, ramp, 1000);
  expect(Math.abs(start.inside.level - 128)).toBeLessThan(2);
  expect(Math.abs(end.inside.level - 230)).toBeLessThan(4);
  // ...and the frame around it never moves, at either end of the ramp.
  expect(Math.abs(start.outside.level - 128)).toBeLessThan(2);
  expect(Math.abs(end.outside.level - 128)).toBeLessThan(2);
});

test('a region does not change how opaque the clip is', async ({ page }) => {
  // Half-opacity track: the punch-and-drop has to sum back to the alpha the clip
  // already had, or the graded square would show as a denser patch.
  const { inside, outside } = await render(page, [square({ brightness: 0.4 })], 0, 0.5);
  expect(Math.abs(inside.alpha - outside.alpha)).toBeLessThan(3);
});
