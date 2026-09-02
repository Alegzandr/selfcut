import { test, expect } from './test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * J plays the timeline BACKWARDS.
 *
 * It used to nudge the playhead back a second while paused and slow the shuttle
 * while playing, which is the one thing J is not for in any cutting room. What
 * that asks of the engine is a transport whose clock runs the other way and a
 * decoder fed frames it has to seek to, so this exercises the running app: the
 * playhead has to go DOWN with real time, the monitor has to keep showing a
 * picture while it does, and the origin has to stop the transport the way the
 * end of the timeline stops it going forward.
 *
 * The sound is deliberately not part of it: a buffer source plays one way only,
 * so playing backwards is silent until an engine that reverses the decoded
 * segments exists (see `restartAt`).
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');
const EDITOR_URL = '/app/';
const STORE_MODULE = '/src/store/store.ts';

/** The preview canvas, as much of it as reading pixels back needs. */
interface CanvasLike {
  width: number;
  height: number;
  getContext: (id: '2d') => {
    getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray };
  } | null;
}

test('J runs the transport backwards, with a picture', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(EDITOR_URL);
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]').first()).toBeVisible({ timeout: 60_000 });
  const store = await appModuleUrl(page, STORE_MODULE);

  const seek = (timeMs: number) =>
    page.evaluate(
      async ({ mod, at }) => {
        const { useStore } = (await import(mod)) as {
          useStore: { getState: () => { seek: (ms: number) => void } };
        };
        useStore.getState().seek(at);
      },
      { mod: store, at: timeMs },
    );
  const transport = () =>
    page.evaluate(async (mod) => {
      const { useStore } = (await import(mod)) as {
        useStore: {
          getState: () => { currentTimeMs: number; playing: boolean; playbackRate: number };
        };
      };
      const { currentTimeMs, playing, playbackRate } = useStore.getState();
      return { currentTimeMs, playing, playbackRate };
    }, store);

  // Near the end of the 3 s fixture, so there is a run of timeline behind it.
  await seek(2500);
  await page.keyboard.press('j');
  expect(await transport()).toMatchObject({ playing: true, playbackRate: -1 });

  // Sample the composited canvas while it runs: the fixture paints a mid
  // lightness hue sweep over every one of its frames, so anything dark at the
  // centre is the backdrop showing through instead of a decoded frame.
  const probe = await page.evaluate(async (mod) => {
    const g = globalThis as unknown as {
      requestAnimationFrame: (cb: () => void) => number;
      document: { querySelector: (selector: string) => CanvasLike | null };
    };
    const { useStore } = (await import(mod)) as {
      useStore: { getState: () => { currentTimeMs: number } };
    };
    const canvas = g.document.querySelector('canvas[data-preview-canvas]')!;
    const ctx = canvas.getContext('2d')!;
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => g.requestAnimationFrame(() => resolve()));
    const brightestPixel = (): number => {
      const side = Math.min(32, canvas.width, canvas.height);
      const x = Math.max(0, ((canvas.width - side) / 2) | 0);
      const y = Math.max(0, ((canvas.height - side) / 2) | 0);
      const { data } = ctx.getImageData(x, y, side, side);
      let brightest = 0;
      for (let i = 0; i < data.length; i += 4) {
        brightest = Math.max(brightest, data[i]!, data[i + 1]!, data[i + 2]!);
      }
      return brightest;
    };

    // The first frame after the press is a cold seek; that start-up is not what
    // this measures.
    for (let i = 0; i < 240 && brightestPixel() < 12; i++) await nextFrame();

    const first = useStore.getState().currentTimeMs;
    let frames = 0;
    let black = 0;
    for (let i = 0; i < 90; i++) {
      await nextFrame();
      frames++;
      if (brightestPixel() < 12) black++;
    }
    return { first, last: useStore.getState().currentTimeMs, frames, black };
  }, store);

  // The whole point: the playhead moved, and it moved backwards.
  expect(probe.last).toBeLessThan(probe.first - 300);
  // A seek that cannot keep up leaves the frame before it on screen, so a run of
  // black is a decoder producing nothing at all rather than a slow machine.
  expect(probe.black).toBeLessThan(probe.frames / 4);

  // The probe leaves the transport wherever the run got to - still going
  // backwards, or already stopped at the origin - so park it before reading the
  // ladder, which starts from a stopped transport.
  await page.keyboard.press('k');
  expect(await transport()).toMatchObject({ playing: false, playbackRate: 1 });

  // A second J doubles the reverse rate; K stops and puts the shuttle back to 1x.
  await seek(2500);
  await page.keyboard.press('j');
  expect((await transport()).playbackRate).toBe(-1);
  await page.keyboard.press('j');
  expect((await transport()).playbackRate).toBe(-2);
  await page.keyboard.press('k');
  expect(await transport()).toMatchObject({ playing: false, playbackRate: 1 });

  // Backwards, the origin is the end of the timeline.
  await seek(400);
  await page.keyboard.press('j');
  await expect.poll(async () => (await transport()).playing, { timeout: 15_000 }).toBe(false);
  expect((await transport()).currentTimeMs).toBe(0);
});
