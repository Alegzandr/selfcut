import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDepUrl } from './appModule';

/**
 * Every clip of a multi-clip cut still ends up in the file.
 *
 * The export now releases a clip's decoder as soon as the render head is past
 * it, instead of holding one per clip for the whole render (which is what made
 * a long 4K timeline run the browser out of decoders and memory). That is only
 * sound because output time moves strictly forward and no clip is visible
 * twice - so this checks the consequence rather than the reasoning: decode the
 * finished file at several instants and require a real, different picture at
 * each.
 *
 * Decoded through mediabunny rather than by seeking a `<video>` element: a
 * media element answers a seek with whatever frame it finds convenient, and two
 * different timestamps routinely hand back the same picture - which is exactly
 * the failure being looked for, so it cannot also be the measurement's own
 * behaviour.
 *
 * The fixture is a hue sweep with a moving box and a frame counter, so a frame
 * that failed to render reads as flat black, and a frame taken from the wrong
 * clip reads as a duplicate of another sample.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

/** Where each sample is taken, as a fraction of the exported duration. */
const SAMPLE_POINTS = [0.08, 0.3, 0.55, 0.75, 0.95];

test('a multi-clip render keeps a picture in every clip', async ({ page }) => {
  test.setTimeout(180_000);

  // No picker, so the finished render sits in scratch storage where it can be
  // decoded in the page without moving the file through the test harness.
  await page.addInitScript(() => {
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  // Razor the 3 s fixture into six clips, so five decoders are opened and then
  // released over the course of one render.
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) {
    for (let f = 0; f < 8; f++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('s');
  }
  await expect(page.locator('[data-clip-id]')).toHaveCount(6);

  await page.keyboard.press('Control+e');
  const sheet = page.getByRole('dialog', { name: 'Export' });
  await expect(sheet).toBeVisible();
  let prevBox = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await sheet.boundingBox());
      const settled = box === prevBox;
      prevBox = box;
      return settled;
    })
    .toBe(true);

  const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
  await sheet.getByRole('button', { name: /^Export / }).click();
  await downloadPromise;

  const mediabunny = await appDepUrl(page, 'mediabunny');

  const samples = await page.evaluate(
    async ({ dep, points }) => {
      type Dir = {
        getDirectoryHandle(name: string): Promise<Dir>;
        getFileHandle(name: string): Promise<{ getFile(): Promise<Blob> }>;
        keys(): AsyncIterable<string>;
      };
      const g = globalThis as unknown as {
        navigator: { storage: { getDirectory(): Promise<Dir> } };
        OffscreenCanvas: new (w: number, h: number) => {
          getContext(kind: string, opts?: unknown): {
            drawImage(src: unknown, x: number, y: number, w: number, h: number): void;
            getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
          } | null;
        };
      };

      const dir = await (await g.navigator.storage.getDirectory()).getDirectoryHandle('exports');
      let name: string | null = null;
      for await (const key of dir.keys()) name = key;
      if (!name) return { error: 'no scratch file' };
      const blob = await (await dir.getFileHandle(name)).getFile();

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
            timestamp: number;
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
      if (!track) return { error: 'no video track in the export' };
      const sink = new VideoSampleSink(track);

      const canvas = new g.OffscreenCanvas(160, 90);
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return { error: 'no 2d context' };

      const frames: { at: number; ts: number; mean: number; signature: string }[] = [];
      for (const fraction of points) {
        const sample = await sink.getSample(duration * fraction);
        if (!sample) return { error: `no frame at ${fraction}` };
        // A mediabunny VideoSample is not a canvas image source; it draws
        // itself (which is also how the compositor paints it).
        sample.draw(ctx, 0, 0, sample.displayWidth, sample.displayHeight, 0, 0, 160, 90);
        const ts = sample.timestamp;
        sample.close();
        const { data } = ctx.getImageData(0, 0, 160, 90);
        let r = 0;
        let gr = 0;
        let b = 0;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]!;
          gr += data[i + 1]!;
          b += data[i + 2]!;
        }
        const px = data.length / 4;
        // Mean colour: the fixture is a hue sweep, so the channel mix is what
        // separates one instant from another, and it ignores encoder noise.
        frames.push({
          at: fraction,
          ts,
          mean: (r + gr + b) / px / 3,
          signature: [r / px, gr / px, b / px].map((v) => Math.round(v / 6)).join('-'),
        });
      }
      input.dispose();
      return { duration, frames };
    },
    { dep: mediabunny, points: SAMPLE_POINTS },
  );

  expect(samples.error).toBeUndefined();
  expect(samples.duration).toBeGreaterThan(2.5);
  expect(samples.frames).toHaveLength(SAMPLE_POINTS.length);

  // Every sample really came from where it was asked for, so the comparisons
  // below are between genuinely different instants of the cut.
  for (const frame of samples.frames!) {
    expect(Math.abs(frame.ts - samples.duration! * frame.at)).toBeLessThan(0.1);
  }
  // Nothing black: a clip whose decoder was released too early would render as
  // an empty frame across its whole span.
  for (const frame of samples.frames!) expect(frame.mean).toBeGreaterThan(12);
  // And no two samples are the same picture, so the render is not holding one
  // clip's last frame for the rest of the timeline either.
  expect(new Set(samples.frames!.map((f) => f.signature)).size).toBe(SAMPLE_POINTS.length);
});
