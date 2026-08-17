import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDepUrl, appModuleUrl } from './appModule';

/**
 * The fanned-out render is faster than the single-worker one, and produces the
 * same picture.
 *
 * Both halves matter. A parallel export that is quick and subtly wrong is worse
 * than a slow one, so the same timeline is rendered both ways - once on one
 * worker, once fanned out - and the two files are compared frame by frame at
 * several points before either timing is looked at.
 *
 * The timing half used to fail about two runs in three, on unchanged code, and
 * the cause turned out to be three separate things rather than flakiness:
 *
 *   - ONE render of each, taken at different moments. The suite runs two
 *     Playwright workers against one hardware encoder (playwright.config.ts
 *     chose that deliberately), so a neighbouring export spec could land on one
 *     of the two renders and not the other and swamp the difference. Now each
 *     mode is rendered several times and only its BEST time counts: the fastest
 *     round is the one least disturbed by whatever else was encoding, which is
 *     the number that describes this code rather than the machine's mood.
 *   - serial ALWAYS FIRST, so it paid the warm-up and everything after it got
 *     the drift. That bias was worth several percent of a ten-percent effect -
 *     removing it dropped the measured speedup on the old fixture from ~1.1x to
 *     1.03x, which is to say most of what was being asserted was the order.
 *     The rounds now alternate which mode goes first.
 *   - a fixture too light to have anything to win. At 1280x720 and 6 Mbps the
 *     encoder is nowhere near the bottleneck - the perf spec measures 300 fps on
 *     this content - and splitting a render that is not encoder-bound cannot pay
 *     for the workers it spawns. It measured 1.03x idle and 0.91x whenever the
 *     machine's encoder was already busy, i.e. the test asserted a speedup on
 *     the one workload where the speedup does not exist. The preset below is
 *     1080p at 24 Mbps for that reason, where the split is what it claims:
 *     1.29x idle, and a steady 1.18-1.22x with the rest of the suite running
 *     beside it.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

const EXPORTER_MODULE = '/src/export/exporter.ts';
const STORE_MODULE = '/src/store/store.ts';

/** Copies of the fixture laid end to end: long enough for the split to pay off. */
const COPIES = 20;
/**
 * Rounds of (serial, parallel) to time before comparing the best of each.
 *
 * Three, because the failure this guards against is one round being hit by a
 * neighbouring spec's encoding: two rounds still fail whenever the same mode is
 * unlucky twice, and each round costs a couple of seconds.
 */
const ROUNDS = 3;
/**
 * Absolute seconds each frame sample is taken at.
 *
 * Absolute, not a fraction of the duration: sampling by fraction makes the
 * comparison depend on the two files being exactly the same length, which turns
 * a one-frame difference in duration into a mismatch at every point after it and
 * says nothing about where the real problem is.
 */
const SAMPLE_SECONDS = [0.5, 8, 17, 26, 35, 44, 53];

/**
 * Heavy enough that the encoder is the bottleneck, which is the only condition
 * under which fanning out is supposed to help - and so the only condition under
 * which asserting that it does says anything. See the note at the top.
 */
const PRESET = {
  id: 'test-1080p',
  group: 'social',
  labelKey: 'export.preset.mp3.label',
  descriptionKey: 'export.preset.audio.description',
  qualityKey: 'export.quality.mp3_high',
  kind: 'mp4',
  aspect: '16:9',
  width: 1920,
  height: 1080,
  fps: 30,
  fpsMode: 'fixed',
  videoBitrate: 24_000_000,
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

  const serialRuns: Awaited<ReturnType<typeof renderAndSample>>[] = [];
  const parallelRuns: typeof serialRuns = [];
  for (let round = 0; round < ROUNDS; round++) {
    // Alternate which mode is rendered first, so neither carries the drift.
    const order: boolean[] = round % 2 === 0 ? [true, false] : [false, true];
    for (const noParallel of order) {
      const run = await renderAndSample(noParallel);
      expect(run.error ?? null, `${noParallel ? 'serial' : 'parallel'} round ${round}`).toBeNull();
      (noParallel ? serialRuns : parallelRuns).push(run);
    }
  }

  // The correctness comparison needs one render of each, not the fastest: every
  // round produces the same pictures, so any pair does.
  const serial = serialRuns[0]!;
  const parallel = parallelRuns[0]!;

  // The timing comparison takes the best of each. See the note at the top.
  const bestSerial = Math.min(...serialRuns.map((r) => r.wallMs!));
  const bestParallel = Math.min(...parallelRuns.map((r) => r.wallMs!));

  const ms = (runs: typeof serialRuns): string =>
    runs.map((r) => r.wallMs!.toFixed(0).padStart(5)).join(' ');
  console.log(
    `\n--- export ${COPIES} clips at ${PRESET.width}x${PRESET.height}, best of ${ROUNDS} ---\n` +
      `  serial   ${ms(serialRuns)} ms  -> best ${bestSerial.toFixed(0)} ms  ${(serial.bytes! / 1024).toFixed(0)} KB\n` +
      `  parallel ${ms(parallelRuns)} ms  -> best ${bestParallel.toFixed(0)} ms  ${(parallel.bytes! / 1024).toFixed(0)} KB\n` +
      `  speedup  ${(bestSerial / bestParallel).toFixed(2)}x\n` +
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

  // And faster - on a machine where there is a split to be faster with.
  //
  // `planSegments` hands back a SERIAL plan when there is no second core to
  // render on beyond the lead (it needs `cores - 1 >= 2`), so on a small CI
  // runner both sides of this comparison are literally the same render and the
  // only honest assertion is that neither regressed. The mirror of that
  // condition is here rather than a blanket weak bound, so the speedup is
  // actually asserted everywhere it exists - measured 1.29x on an idle machine
  // and a steady 1.18-1.22x with the rest of the suite encoding beside it,
  // which makes a 5% floor a wide margin rather than a certification of this
  // particular machine.
  const cores = await page.evaluate(() => navigator.hardwareConcurrency);
  // `?? 4` mirrors planSegments, which assumes a modest machine when the
  // browser hides the count - and therefore still fans out.
  const fansOut = (cores ?? 4) >= 3;
  test.info().annotations.push({
    type: 'split',
    description: `${cores ?? 'unknown'} cores -> ${fansOut ? 'fans out, speedup asserted' : 'serial plan, speedup not asserted'}`,
  });
  expect(bestParallel).toBeLessThan(bestSerial * (fansOut ? 0.95 : 1.05));
});
