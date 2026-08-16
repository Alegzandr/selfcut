import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * The preview monitor shows the frame a render is on.
 *
 * The claim has three parts and each of them is observable, which is why this
 * is an e2e spec and not a unit test: the worker really has to composite frames
 * for there to be snapshots at all, the playback engine really has to paint
 * them on the canvas the user is looking at, and the monitor really has to be
 * handed back to the playhead once the render is over. Nothing short of a real
 * export exercises the three together.
 *
 * The structural tell is the canvas backing store: a composited preview sizes it
 * from the project's output geometry, a render snapshot from its own downscaled
 * width. So "the picture on screen came from the export" is a size comparison,
 * not a pixel guess about footage that might legitimately be a static shot.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

const EXPORTER_MODULE = '/src/export/exporter.ts';
const BUS_MODULE = '/src/export/renderPreviewBus.ts';
const STORE_MODULE = '/src/store/store.ts';

/**
 * Copies laid end to end. Enough that the default render fans out (the planner
 * refuses to split anything under thirty seconds), so the fanned-out path is
 * covered rather than assumed: it is the one that has to CHOOSE which slice
 * drives the monitor while several render at once.
 */
const COPIES = 20;

const PRESET = {
  id: 'test-720p',
  group: 'social',
  labelKey: 'export.preset.mp3.label',
  descriptionKey: 'export.preset.audio.description',
  qualityKey: 'export.quality.mp3_high',
  kind: 'mp4',
  aspect: '16:9',
  width: 1280,
  height: 720,
  fps: 30,
  fpsMode: 'fixed',
  videoBitrate: 6_000_000,
  audioBitrate: 192_000,
};

test('the preview shows the frame being rendered, then hands the monitor back', async ({ page }) => {
  test.setTimeout(180_000);

  // No save picker: the render goes to origin-private scratch, which needs no
  // user gesture and leaves nothing on the machine running the suite.
  await page.addInitScript(() => {
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  const storeUrl = await appModuleUrl(page, STORE_MODULE);
  await page.evaluate(
    async ({ mod, copies }) => {
      const { useStore } = (await import(mod)) as {
        useStore: { getState: () => never; setState: (p: unknown) => void };
      };
      const state = useStore.getState() as unknown as {
        project: { tracks: { id: string; clips: Record<string, unknown>[] }[] };
      };
      const track = state.project.tracks.find((t) => t.clips.length > 0)!;
      const seed = track.clips[0]! as { sourceInMs: number; sourceOutMs: number; speed: number };
      const durMs = (seed.sourceOutMs - seed.sourceInMs) / seed.speed;
      const clips = Array.from({ length: copies }, (_, i) => ({
        ...seed,
        id: `prev-clip-${i}`,
        timelineStartMs: Math.round(i * durMs),
      }));
      useStore.setState({
        project: {
          ...state.project,
          tracks: state.project.tracks.map((t) => (t.id === track.id ? { ...t, clips } : t)),
        },
      });
    },
    { mod: storeUrl, copies: COPIES },
  );

  // The playhead never moves during the export: every change on the monitor
  // below is therefore the render's doing and not the transport's.
  const canvas = page.locator('[data-preview-canvas]');
  await expect(canvas).toBeVisible();
  const idleWidth = await canvas.evaluate((el) => (el as HTMLCanvasElement).width);
  expect(idleWidth).toBeGreaterThan(0);

  const exporterUrl = await appModuleUrl(page, EXPORTER_MODULE);
  const busUrl = await appModuleUrl(page, BUS_MODULE);

  const watchRender = (noParallel: boolean) => page.evaluate(
    async ({ exporter, bus, store, preset, serial }) => {
      const { startExport } = (await import(exporter)) as {
        startExport: (
          project: unknown,
          assets: unknown,
          preset: unknown,
          onProgress: (v: number) => void,
          region: unknown,
          options: { noParallel?: boolean },
        ) => { promise: Promise<unknown> };
      };
      const { renderPreviewFrame } = (await import(bus)) as {
        renderPreviewFrame: () => { bitmap: ImageBitmap; timeMs: number } | null;
      };
      const { useStore } = (await import(store)) as {
        useStore: { getState: () => { project: unknown; assets: unknown; currentTimeMs: number } };
      };
      const state = useStore.getState();
      const startTimeMs = state.currentTimeMs;

      const el = document.querySelector('[data-preview-canvas]') as HTMLCanvasElement;
      const samples: { timeMs: number; canvasWidth: number; badge: boolean }[] = [];
      // Sampled off a timer rather than off the bus: what is being checked is
      // what a user looking at the panel would see, which is the canvas after
      // the engine's next repaint, not the moment a snapshot landed.
      const sampler = window.setInterval(() => {
        const frame = renderPreviewFrame();
        if (!frame) return;
        samples.push({
          timeMs: frame.timeMs,
          canvasWidth: el.width,
          badge: document.querySelector('[data-render-badge]') !== null,
        });
      }, 100);

      let error: string | null = null;
      try {
        await startExport(state.project, state.assets, preset, () => {}, null, {
          noParallel: serial,
        }).promise;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      window.clearInterval(sampler);

      // One more animation frame, so the engine has repainted the real frame
      // before the idle state is read back.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      return {
        error,
        samples,
        liveAfter: renderPreviewFrame() !== null,
        badgeAfter: document.querySelector('[data-render-badge]') !== null,
        widthAfter: el.width,
        movedPlayhead: useStore.getState().currentTimeMs !== startTimeMs,
      };
    },
    { exporter: exporterUrl, bus: busUrl, store: storeUrl, preset: PRESET, serial: noParallel },
  );

  // Both render paths, because they publish differently: the serial one taps
  // its own canvas, the fanned-out one picks between the slices its workers are
  // rendering at the same moment.
  for (const noParallel of [true, false]) {
    const result = await watchRender(noParallel);
    const label = noParallel ? 'serial' : 'parallel';

    expect(result.error, label).toBeNull();
    expect(result.movedPlayhead, label).toBe(false);

    // Snapshots arrived, and often enough to read as a moving picture rather
    // than as a single frame that happened to be caught.
    expect(result.samples.length, label).toBeGreaterThanOrEqual(3);

    const times = result.samples.map((s) => s.timeMs);
    console.log(
      `  ${label}: ${result.samples.length} snapshots, ` +
        `${(times[0]! / 1000).toFixed(1)}s -> ${(times[times.length - 1]! / 1000).toFixed(1)}s`,
    );
    // The monitor advances through the render rather than sitting on one frame,
    // and it only ever goes forward. That second half is the whole assertion for
    // the fanned-out path: several workers are rendering different parts of the
    // timeline at once, and a monitor fed by all of them would jump backwards
    // constantly.
    expect(times[times.length - 1]!, label).toBeGreaterThan(times[0]!);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!, `${label} @${i}`).toBeGreaterThanOrEqual(times[i - 1]!);
    }

    // The canvas was showing the snapshot, not a composite of the paused
    // playhead: the two are sized from different things (see the header).
    for (const sample of result.samples) {
      expect(sample.canvasWidth, label).toBeLessThan(idleWidth);
      expect(sample.badge, label).toBe(true);
    }

    // And the monitor goes back to the playhead the moment the render is over.
    expect(result.liveAfter, label).toBe(false);
    expect(result.badgeAfter, label).toBe(false);
    expect(result.widthAfter, label).toBe(idleWidth);
  }
});
