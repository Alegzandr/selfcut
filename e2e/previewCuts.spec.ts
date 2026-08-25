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
  /** Set by the probe itself, once the playhead leaves the sampling window. */
  done: boolean;
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

    // Sample past both cuts (1 s and 2 s), and stop before the end of the 3 s
    // timeline, where the playhead lands on nothing and a black frame is the
    // right answer. The window closes here, in the page, rather than by the
    // test reading the playhead out and sending a stop back: that round trip is
    // longer than the last 600 ms of playback, so the probe kept sampling into
    // the tail and reported the backdrop there as a regression.
    const untilMs = 2400;

    const probe: CutProbe = { frames: 0, black: 0, at: [], done: false };
    g.cutProbe = probe;
    const tick = (): void => {
      const at = Math.round(useStore.getState().currentTimeMs);
      if (at > untilMs) {
        probe.done = true;
        return;
      }
      probe.frames++;
      if (brightestPixel() < 12) {
        probe.black++;
        // Where on the timeline, so a failure names the boundary it happened at
        // instead of just a count.
        probe.at.push(at);
      }
      g.requestAnimationFrame(tick);
    };
    g.requestAnimationFrame(tick);
  }, await appModuleUrl(page, STORE_MODULE));

  await page.keyboard.press('Space');
  // The playhead, not the wall clock. A machine that plays back slower than
  // real time reaches 2500 ms of wall having crossed neither cut, which is a
  // test that asserts nothing and reports a pass; and a machine that keeps up
  // waits no longer here than it has to.
  await expect
    .poll(
      () => page.evaluate(() => (globalThis as unknown as { cutProbe: CutProbe }).cutProbe.done),
      { message: 'playhead past the second cut', timeout: 30_000 },
    )
    .toBe(true);
  const probe = await page.evaluate(
    () => (globalThis as unknown as { cutProbe: CutProbe }).cutProbe,
  );

  // Really sampled a playback's worth of frames, rather than reporting a clean
  // run because the loop never went round.
  expect(probe.frames).toBeGreaterThan(60);
  // Reported with their positions: a regression should say where it flashed.
  expect({ black: probe.black, at: probe.at }).toEqual({ black: 0, at: [] });
});

/** What the loop probe collects while the playhead crosses the wrap. */
interface LoopProbe {
  /** Timeline position of the first picture that differs from the pre-wrap one. */
  firstChangeMs: number | null;
  /** Samples taken, so a run that never looped cannot report a pass. */
  samples: number;
  wrapped: boolean;
  done: boolean;
}

test('a loop wrap shows the region again instead of holding the last frame', async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  // A backward jump used to be measured against the frame still on screen: the
  // fresh iterator's first sample lost that comparison, and every one after it,
  // until the playhead passed the MIDPOINT of the jump - here 1.75 s, i.e. half
  // the loop frozen on the last frame of the previous pass, and 1.5 s of it on
  // the 3 s region of a 120 fps source this was found on.
  const IN_MS = 1000;
  const OUT_MS = 2500;
  const MIDPOINT_MS = (IN_MS + OUT_MS) / 2;

  await page.evaluate(
    async ({ mod, inMs, outMs }) => {
      const g = globalThis as unknown as {
        requestAnimationFrame: (cb: () => void) => number;
        document: { querySelector: (selector: string) => CanvasLike | null };
        loopProbe?: LoopProbe;
      };
      const { useStore } = (await import(mod)) as {
        useStore: {
          getState: () => {
            currentTimeMs: number;
            seek: (ms: number) => void;
            setLoopRegion: (region: { startMs: number; endMs: number }) => void;
            toggleLoopEnabled: () => void;
            loopEnabled: boolean;
          };
        };
      };
      const s = () => useStore.getState();
      s().setLoopRegion({ startMs: inMs, endMs: outMs });
      if (!s().loopEnabled) s().toggleLoopEnabled();
      s().seek(inMs);

      const canvas = g.document.querySelector('canvas[data-preview-canvas]')!;
      const ctx = canvas.getContext('2d')!;
      // A cheap signature of the picture: the fixture paints a different hue on
      // every frame, so any two frames of it hash apart.
      const signature = (): number => {
        const side = Math.min(32, canvas.width, canvas.height);
        const x = Math.max(0, ((canvas.width - side) / 2) | 0);
        const y = Math.max(0, ((canvas.height - side) / 2) | 0);
        const { data } = ctx.getImageData(x, y, side, side);
        let hash = 0;
        for (let i = 0; i < data.length; i += 7) hash = (hash * 31 + data[i]!) | 0;
        return hash;
      };

      const probe: LoopProbe = { firstChangeMs: null, samples: 0, wrapped: false, done: false };
      g.loopProbe = probe;
      // The last picture of the outgoing pass: what the bug left frozen.
      let lastBeforeWrap = signature();
      let previousMs = s().currentTimeMs;
      const tick = (): void => {
        const at = s().currentTimeMs;
        if (!probe.wrapped) {
          // The wrap is the only backward step the playhead takes here.
          if (at < previousMs - 1) probe.wrapped = true;
          else lastBeforeWrap = signature();
        } else {
          probe.samples++;
          if (probe.firstChangeMs === null && signature() !== lastBeforeWrap) {
            probe.firstChangeMs = at;
          }
          // Half a pass past the wrap is well past the midpoint the bug waited
          // for, so a run that gets here with nothing recorded is a failure and
          // not a test that stopped too early.
          if (at > (inMs + outMs) / 2 + 200) probe.done = true;
        }
        previousMs = at;
        if (!probe.done) g.requestAnimationFrame(tick);
      };
      g.requestAnimationFrame(tick);
    },
    { mod: await appModuleUrl(page, STORE_MODULE), inMs: IN_MS, outMs: OUT_MS },
  );

  await page.keyboard.press('Space');
  await expect
    .poll(
      () => page.evaluate(() => (globalThis as unknown as { loopProbe: LoopProbe }).loopProbe.done),
      { message: 'playhead past the wrap', timeout: 30_000 },
    )
    .toBe(true);
  await page.keyboard.press('Space');
  const probe = await page.evaluate(
    () => (globalThis as unknown as { loopProbe: LoopProbe }).loopProbe,
  );

  expect(probe.samples).toBeGreaterThan(10);
  // Structural rather than a millisecond budget: the picture has to come back
  // while the playhead is still in the first half of the region, which is the
  // half the stale-comparison bug spent frozen. What is left is the decode of
  // the GOP the in point sits in, which every machine pays differently.
  expect(probe.firstChangeMs).not.toBeNull();
  expect(probe.firstChangeMs!).toBeLessThan(MIDPOINT_MS);
});
