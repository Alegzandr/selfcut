import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * Editing WHILE the playhead runs.
 *
 * A drag is not one edit: the clip is written to the store on every
 * pointermove. Each of those changed the audio mix, and the engine used to
 * rebuild the whole schedule for each one - which stopped a row of buffer
 * sources mid-sample (an audible buzz) and re-anchored the transport thirty
 * milliseconds into the future sixty times a second, so the clock stood still
 * while the decoder kept handing over sequential frames and the picture walked
 * away from the playhead.
 *
 * The store is driven directly rather than through pointer events: the churn is
 * what the engine reacts to, and going through the timeline element would test
 * the drag math instead. What is asserted is the transport - a playhead that
 * still advances with real time through a second of continuous edits.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');
const EDITOR_URL = '/app/';
const STORE_MODULE = '/src/store/store.ts';

test('the playhead keeps time while a clip is dragged under it', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(EDITOR_URL);
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]').first()).toBeVisible({ timeout: 60_000 });

  const store = await appModuleUrl(page, STORE_MODULE);
  const report = await page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as {
      useStore: {
        getState: () => {
          currentTimeMs: number;
          project: { tracks: { clips: { id: string; timelineStartMs: number }[] }[] };
          seek: (ms: number) => void;
          setPlaying: (playing: boolean) => void;
          moveClips: (entries: { clipId: string; timelineStartMs: number }[]) => void;
        };
      };
    };
    const s = () => useStore.getState();
    const clip = s().project.tracks.flatMap((t) => t.clips)[0]!;
    const home = clip.timelineStartMs;

    s().seek(0);
    s().setPlaying(true);
    // Let the transport settle: the first tick starts the audio, which anchors
    // the clock thirty milliseconds out on purpose.
    await new Promise((r) => setTimeout(r, 400));

    const t0 = s().currentTimeMs;
    const wall0 = performance.now();
    // One move per frame for a second - the shape of a real drag.
    for (let i = 0; i < 60; i++) {
      await new Promise(requestAnimationFrame);
      s().moveClips([{ clipId: clip.id, timelineStartMs: home + 200 + (i % 20) * 10 }]);
    }
    const advancedMs = s().currentTimeMs - t0;
    const elapsedMs = performance.now() - wall0;
    s().setPlaying(false);
    s().moveClips([{ clipId: clip.id, timelineStartMs: home }]);
    return { advancedMs, elapsedMs };
  }, store);

  // Real time, not a frozen or crawling clock. The floor is what the bug broke
  // (it advanced by ~0); the ceiling catches a clock running away.
  expect(report.advancedMs).toBeGreaterThan(report.elapsedMs * 0.8);
  expect(report.advancedMs).toBeLessThan(report.elapsedMs * 1.2);
});
