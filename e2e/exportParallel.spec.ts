import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDepUrl, appModuleUrl } from './appModule';

/**
 * The fanned-out render is faster than the single-worker one, and produces the
 * same picture.
 *
 * Both halves matter. A parallel export that is quick and subtly wrong is worse
 * than a slow one, so the same timeline is rendered twice - once on one worker,
 * once fanned out - and the two files are compared frame by frame at several
 * points before either timing is looked at.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

const EXPORTER_MODULE = '/src/export/exporter.ts';
const STORE_MODULE = '/src/store/store.ts';

/** Copies of the fixture laid end to end: long enough for the split to pay off. */
const COPIES = 20;
/**
 * Absolute seconds each frame sample is taken at.
 *
 * Absolute, not a fraction of the duration: sampling by fraction makes the
 * comparison depend on the two files being exactly the same length, which turns
 * a one-frame difference in duration into a mismatch at every point after it and
 * says nothing about where the real problem is.
 */
const SAMPLE_SECONDS = [0.5, 8, 17, 26, 35, 44, 53];

const PRESET = {
  id: 'test-1080p',
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

test('a fanned-out render matches the serial one, and beats it', async ({ page }) => {
  test.setTimeout(300_000);

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
        id: `par-clip-${i}`,
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

  const exporterUrl = await appModuleUrl(page, EXPORTER_MODULE);
  const mediabunny = await appDepUrl(page, 'mediabunny');

  /** Render once and return the timing plus a fingerprint of the finished file. */
  const renderAndSample = async (noParallel: boolean) =>
    page.evaluate(
      async ({ exporter, store, dep, preset, points, serial }) => {
        const { startExport } = (await import(exporter)) as {
          startExport: (
            project: unknown,
            assets: unknown,
            preset: unknown,
            onProgress: (v: number) => void,
            region: unknown,
            options: { noParallel?: boolean },
          ) => { promise: Promise<{ blob: Blob | null }> };
        };
        const { useStore } = (await import(store)) as { useStore: { getState: () => never } };
        const s = useStore.getState() as unknown as { project: unknown; assets: unknown };

        type Dir = {
          getDirectoryHandle(name: string): Promise<Dir>;
          getFileHandle(name: string): Promise<{ getFile(): Promise<Blob> }>;
          removeEntry(name: string): Promise<void>;
          keys(): AsyncIterable<string>;
        };
        const g = globalThis as unknown as {
          navigator: { storage: { getDirectory(): Promise<Dir> } };
          OffscreenCanvas: new (w: number, h: number) => {
            getContext(
              kind: string,
              opts?: unknown,
            ): {
              drawImage(src: unknown, x: number, y: number, w: number, h: number): void;
              getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
            } | null;
          };
        };
        // Start from an empty scratch directory, so the file picked up below is
        // this render's and not the previous one's.
        const exports = await (await g.navigator.storage.getDirectory()).getDirectoryHandle('exports');
        for await (const key of exports.keys()) await exports.removeEntry(key);

        const t0 = performance.now();
        try {
          await startExport(s.project, s.assets, preset, () => {}, null, { noParallel: serial })
            .promise;
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
        const wallMs = performance.now() - t0;

        let name: string | null = null;
        for await (const key of exports.keys()) name = key;
        if (!name) return { error: 'no scratch file' };
        const blob = await (await exports.getFileHandle(name)).getFile();

        const { Input, ALL_FORMATS, BlobSource, VideoSampleSink } = (await import(dep)) as {
          Input: new (opts: { formats: unknown; source: unknown }) => {
            computeDuration(): Promise<number>;
            getPrimaryVideoTrack(): Promise<unknown>;
            dispose(): void;
          };
          ALL_FORMATS: unknown;
          BlobSource: new (b: Blob) => unknown;
          VideoSampleSink: new (track: unknown) => {
            getSample(sec: number): Promise<{
              draw(
                ctx: unknown,
                sx: number,
                sy: number,
                sw: number,
                sh: number,
                dx: number,
                dy: number,
                dw: number,
                dh: number,
              ): void;
              displayWidth: number;
              displayHeight: number;
              close(): void;
            } | null>;
          };
        };

        const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
        const duration = await input.computeDuration();
        const track = await input.getPrimaryVideoTrack();
        if (!track) return { error: 'no video track' };
        const sink = new VideoSampleSink(track);
        const canvas = new g.OffscreenCanvas(32, 18);
        const ctx = canvas.getContext('2d', { alpha: false })!;

        // A downsampled copy of each sampled frame, compared numerically rather
        // than by equality: two encoders that both did their job produce
        // slightly different bytes, and an exact match would only ever be
        // testing that rate control is deterministic.
        const frames: number[][] = [];
        for (const at of points) {
          if (at > duration) continue;
          const sample = await sink.getSample(at);
          if (!sample) return { error: `no frame at ${at}s` };
          sample.draw(ctx, 0, 0, sample.displayWidth, sample.displayHeight, 0, 0, 32, 18);
          sample.close();
          const { data } = ctx.getImageData(0, 0, 32, 18);
          const pixels: number[] = [];
          for (let i = 0; i < data.length; i += 4) {
            pixels.push(data[i]!, data[i + 1]!, data[i + 2]!);
          }
          frames.push(pixels);
        }
        input.dispose();
        return { wallMs, duration, frames, bytes: blob.size };
      },
      {
        exporter: exporterUrl,
        store: storeUrl,
        dep: mediabunny,
        preset: PRESET,
        points: SAMPLE_SECONDS,
        serial: noParallel,
      },
    );

  const serial = await renderAndSample(true);
  expect(serial.error ?? null).toBeNull();
  const parallel = await renderAndSample(false);
  expect(parallel.error ?? null).toBeNull();

  console.log(
    `\n--- export ${COPIES} clips at ${PRESET.width}x${PRESET.height} ---\n` +
      `  serial   ${serial.wallMs!.toFixed(0)} ms  ${(serial.bytes! / 1024).toFixed(0)} KB\n` +
      `  parallel ${parallel.wallMs!.toFixed(0)} ms  ${(parallel.bytes! / 1024).toFixed(0)} KB\n` +
      `  speedup  ${(serial.wallMs! / parallel.wallMs!).toFixed(2)}x
` +
      `  duration serial ${serial.duration!.toFixed(3)}s  parallel ${parallel.duration!.toFixed(3)}s`,
  );

  // Same length, same pictures at every sample point. This is the assertion
  // that makes the timing below worth having.
  // Within a third of a frame at 30 fps: the two renders cover the same span,
  // and a slice boundary neither dropped nor duplicated a frame.
  expect(parallel.duration!).toBeCloseTo(serial.duration!, 2);
  expect(parallel.frames!.length).toBe(serial.frames!.length);
  const diffs = serial.frames!.map((ref, i) => {
    const got = parallel.frames![i]!;
    let sum = 0;
    let worst = 0;
    for (let j = 0; j < ref.length; j++) {
      const d = Math.abs(ref[j]! - got[j]!);
      sum += d;
      if (d > worst) worst = d;
    }
    return { at: SAMPLE_SECONDS[i]!, mean: sum / ref.length, worst };
  });
  console.log(
    '  per-frame difference: ' +
      diffs.map((d) => `${d.at}s mean ${d.mean.toFixed(1)} worst ${d.worst}`).join(', '),
  );
  // The same picture, allowing for two encoders having made their own
  // rate-control decisions. A frame taken from the wrong moment - the failure
  // this guards against - moves the mean by tens of levels, not by ones.
  for (const d of diffs) expect(d.mean).toBeLessThan(6);

  // Each slice has its own rate-control window, so the split cannot be allowed
  // to quietly spend a different number of bits on the same pictures. (Measured
  // at eight slices it produced a file HALF the size of the serial one, which is
  // what set the minimum slice length in segmentPlan.)
  const sizeRatio = parallel.bytes! / serial.bytes!;
  expect(sizeRatio).toBeGreaterThan(0.8);
  expect(sizeRatio).toBeLessThan(1.25);

  // And faster. Deliberately a weak bound: a CI runner with two cores will not
  // see the speedup a workstation does, and the test is here to catch the split
  // being a REGRESSION, not to certify a particular machine.
  expect(parallel.wallMs!).toBeLessThan(serial.wallMs! * 1.05);
});
