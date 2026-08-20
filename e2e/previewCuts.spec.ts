import { test, expect, Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * What the preview shows at a straight cut.
 *
 * A decode cursor is created when its clip becomes visible, and a cold one has
 * to configure a decoder and seek to a keyframe before it can hand over a frame.
 * Until then the clip drew nothing, so every hard cut flashed the black backdrop
 * for a fraction of a second - the picture went black between clips that are
 * butted together on the timeline. The fix opens the next clip's decoder ahead
 * of the playhead; both halves are checked here, because the policy
 * (`forEachUpcomingVideoClip`) is unit-tested but only the running app can show
 * that the picture never goes black.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');
const EDITOR_URL = '/app/';

const CURSOR_MODULE = '/src/preview/FrameCursor.ts';
const POOL_MODULE = '/src/preview/cursorPool.ts';
const STORE_MODULE = '/src/store/store.ts';

/** How many decode cursors the preview is holding right now. */
async function liveCursors(page: Page): Promise<number> {
  const url = await appModuleUrl(page, CURSOR_MODULE);
  return page.evaluate(async (mod) => {
    const { liveCursorCount } = (await import(mod)) as { liveCursorCount: () => number };
    return liveCursorCount();
  }, url);
}

/**
 * Import the 3 s fixture and razor it into three one-second clips, playhead back
 * at the start. Cuts a full second apart, not the few frames a clip-count test
 * needs: the flash being measured lasts a couple of hundred milliseconds, so the
 * clips have to be longer than it is.
 */
async function importAndCut(page: Page): Promise<void> {
  await page.goto(EDITOR_URL);
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  await page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as {
      useStore: {
        getState: () => { seek: (ms: number) => void; splitAtPlayhead: () => void };
      };
    };
    for (const ms of [1000, 2000]) {
      useStore.getState().seek(ms);
      useStore.getState().splitAtPlayhead();
    }
    useStore.getState().seek(0);
  }, await appModuleUrl(page, STORE_MODULE));
  await expect(page.locator('[data-clip-id]')).toHaveCount(3);
}

test('playback opens the next clip decoder before reaching the cut', async ({ page }) => {
  await importAndCut(page);
  // Paused on the first clip: one decoder, for what is on screen.
  await expect.poll(() => liveCursors(page)).toBe(1);

  await page.keyboard.press('Space');
  // Read both numbers in the page, mid-first-clip: the playhead has to still be
  // BEFORE the cut when the count is taken, or a second cursor proves nothing -
  // the pool keeps the outgoing clip's decoder for a while after every cut.
  const observed = await page.evaluate(
    async ({ storeMod, cursorMod }) => {
      // The e2e specs compile under the Node tsconfig, which has no `lib.dom`:
      // browser globals are reached through a structurally typed `globalThis`,
      // and called on it so the WebIDL `this` binding survives.
      const g = globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number };
      const { useStore } = (await import(storeMod)) as {
        useStore: { getState: () => { currentTimeMs: number } };
      };
      const { liveCursorCount } = (await import(cursorMod)) as { liveCursorCount: () => number };
      while (useStore.getState().currentTimeMs < 300) {
        await new Promise<void>((resolve) => g.requestAnimationFrame(() => resolve()));
      }
      return { tMs: useStore.getState().currentTimeMs, cursors: liveCursorCount() };
    },
    {
      storeMod: await appModuleUrl(page, STORE_MODULE),
      cursorMod: await appModuleUrl(page, CURSOR_MODULE),
    },
  );
  // The cut at 1 s is inside the prewarm window from the very first played
  // frame, so the second clip's decoder is open while the first still plays.
  expect(observed.tMs).toBeLessThan(900);
  expect(observed.cursors).toBeGreaterThanOrEqual(2);

  const max = await page.evaluate(async (mod) => {
    const { MAX_LIVE_CURSORS } = (await import(mod)) as { MAX_LIVE_CURSORS: number };
    return MAX_LIVE_CURSORS;
  }, await appModuleUrl(page, POOL_MODULE));
  // Warming clips join the set the pool may not evict, so the guard that keeps
  // the pool bounded has to survive them.
  expect(await liveCursors(page)).toBeLessThanOrEqual(max);
});

/** What the canvas probe collects: black frames, and where they happened. */
interface CutProbe {
  frames: number;
  black: number;
  /** Timeline position of each black frame, in ms. */
  at: number[];
  stop: boolean;
}

/** The preview canvas, as much of it as reading pixels back needs. */
interface CanvasLike {
  width: number;
  height: number;
  getContext: (id: '2d') => {
    getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray };
  } | null;
}

test('a straight cut never shows the black backdrop', async ({ page }) => {
  await importAndCut(page);

  // Sample the composited canvas on every animation frame. Registered after the
  // engine's own loop, so each sample reads the frame it has just drawn.
  await page.evaluate(async (mod) => {
    const g = globalThis as unknown as {
      requestAnimationFrame: (cb: () => void) => number;
      document: { querySelector: (selector: string) => CanvasLike | null };
      cutProbe?: CutProbe;
    };
    const { useStore } = (await import(mod)) as {
      useStore: { getState: () => { currentTimeMs: number } };
    };
    const canvas = g.document.querySelector('canvas[data-preview-canvas]')!;
    const ctx = canvas.getContext('2d')!;
    const nextFrame = (): Promise<void> =>
      new Promise((resolve) => g.requestAnimationFrame(() => resolve()));

    // A 32px square at the centre of the frame: the fixture paints a mid
    // lightness hue sweep there on every one of its frames, so anything dark is
    // the backdrop showing through, not the picture.
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

    // Start from the paused still, not from a blank canvas: the edits above
    // replaced the clips, so the cursor under the playhead is decoding its first
    // frame right now. That cold start is not what this test measures.
    for (let i = 0; i < 240 && brightestPixel() < 12; i++) await nextFrame();

    const probe: CutProbe = { frames: 0, black: 0, at: [], stop: false };
    g.cutProbe = probe;
    const tick = (): void => {
      if (probe.stop) return;
      const brightest = brightestPixel();
      probe.frames++;
      if (brightest < 12) {
        probe.black++;
        // Where on the timeline, so a failure names the boundary it happened at
        // instead of just a count.
        probe.at.push(Math.round(useStore.getState().currentTimeMs));
      }
      g.requestAnimationFrame(tick);
    };
    g.requestAnimationFrame(tick);
  }, await appModuleUrl(page, STORE_MODULE));

  await page.keyboard.press('Space');
  // Past both cuts (1 s and 2 s) and stopped before the end of the timeline,
  // where the playhead lands on nothing and a black frame is the right answer.
  //
  // The playhead, not the wall clock. A machine that plays back slower than
  // real time reaches 2500 ms of wall having crossed neither cut, which is a
  // test that asserts nothing and reports a pass; and a machine that keeps up
  // waits no longer here than it has to.
  await expect
    .poll(
      async () =>
        page.evaluate(async (mod) => {
          const { useStore } = (await import(mod)) as { useStore: { getState: () => never } };
          return (useStore.getState() as unknown as { currentTimeMs: number }).currentTimeMs;
        }, await appModuleUrl(page, STORE_MODULE)),
      { message: 'playhead past the second cut', timeout: 30_000 },
    )
    .toBeGreaterThan(2400);
  const probe = await page.evaluate(() => {
    const g = globalThis as unknown as { cutProbe: CutProbe };
    g.cutProbe.stop = true;
    return g.cutProbe;
  });

  // Really sampled a playback's worth of frames, rather than reporting a clean
  // run because the loop never went round.
  expect(probe.frames).toBeGreaterThan(60);
  // Reported with their positions: a regression should say where it flashed.
  expect({ black: probe.black, at: probe.at }).toEqual({ black: 0, at: [] });
});
