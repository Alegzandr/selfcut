import { test, expect } from './test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDepUrl } from './appModule';

/**
 * A pre-composed cut exports the same picture the flat cut did.
 *
 * The preview and the export composite through one routine (`drawTracks`), so a
 * nested composition CANNOT drift between them by construction. What can drift
 * is everything around it: the export gathers what to decode before it draws,
 * and a clip that lives only inside a precomp is exactly the one a flat walk of
 * `project.tracks` would miss - which renders as a file of black frames, with no
 * error anywhere.
 *
 * So this renders the same six-clip cut twice, once flat and once wrapped in a
 * composition, and requires the two files to carry the same pictures at the same
 * instants. Nothing about the composition is asserted directly: the claim being
 * pinned is that precomposing changes nothing about the output, which is the
 * only promise the feature makes.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

/** Where each sample is taken, as a fraction of the exported duration. */
const SAMPLE_POINTS = [0.08, 0.3, 0.55, 0.75, 0.95];

interface Sample {
  at: number;
  ts: number;
  mean: number;
  signature: string;
}

test('a pre-composed cut renders the same file as the flat one', async ({ page }) => {
  test.setTimeout(240_000);

  // No picker, so each finished render sits in scratch storage where it can be
  // decoded in the page without moving the file through the test harness.
  await page.addInitScript(() => {
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  // Razor the 3 s fixture into six clips: enough that a lost clip shows up as a
  // black stretch rather than as a single suspicious frame.
  await page.keyboard.press('Home');
  for (let i = 0; i < 5; i++) {
    for (let f = 0; f < 8; f++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('s');
  }
  await expect(page.locator('[data-clip-id]')).toHaveCount(6);

  const mediabunny = await appDepUrl(page, 'mediabunny');
  const flat = await renderAndSample(page, mediabunny);

  // Wrap the whole cut into a composition. `precompose` walks into it, so step
  // back out before exporting - an export always renders the main timeline.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+Shift+C');
  // The trail appearing is what says the editor really stepped inside: the clip
  // count alone cannot tell "inside the composition" from "never left the cut".
  const trail = page.getByRole('navigation', { name: 'Composition path' });
  await expect(trail).toBeVisible();
  await expect(page.locator('[data-clip-id]')).toHaveCount(6);

  await page.keyboard.press('Escape');
  await expect(trail).toBeHidden();
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  const nested = await renderAndSample(page, mediabunny);

  expect(nested.error).toBeUndefined();
  expect(nested.frames).toHaveLength(SAMPLE_POINTS.length);
  // Same length: the comp clip plays the composition whole, so the cut cannot
  // have got longer or shorter by being wrapped.
  expect(Math.abs(nested.duration! - flat.duration!)).toBeLessThan(0.05);
  // Nothing black: a clip the export failed to decode inside the composition
  // would render as an empty frame across its whole span.
  for (const frame of nested.frames!) expect(frame.mean).toBeGreaterThan(12);
  // And the same six pictures, in the same order.
  expect(nested.frames!.map((f) => f.signature)).toEqual(flat.frames!.map((f) => f.signature));
});

/** Export the current project and read back the picture at each sample point. */
async function renderAndSample(
  page: import('@playwright/test').Page,
  mediabunny: string,
): Promise<{ error?: string; duration?: number; frames?: Sample[] }> {
  await page.keyboard.press('Control+e');
  const sheet = page.getByRole('dialog', { name: 'Export' });
  await expect(sheet).toBeVisible();
  // The sheet animates in; clicking mid-flight lands on a moving target.
  let prevBox = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await sheet.boundingBox());
      const settled = box === prevBox;
      prevBox = box;
      return settled;
    })
    .toBe(true);

  const downloadPromise = page.waitForEvent('download', { timeout: 150_000 });
  await sheet.getByRole('button', { name: /^Export / }).click();
  await downloadPromise;
  // The download firing is NOT the sheet being done: the file is handed over
  // first and the sheet only then leaves its rendering phase, where Escape is
  // deliberately inert so that a stray key cannot throw an export away. On a
  // machine slow enough to separate the two - a CI runner with no hardware
  // encoder - an Escape sent on the download is swallowed and the sheet never
  // closes. So wait for the finished screen, which is the real sync point.
  await expect(sheet.getByRole('button', { name: 'New export' })).toBeVisible({
    timeout: 30_000,
  });
  // The sheet stays up after the render, and while it is open every editor
  // hotkey is inert by design - so the next step could not select or
  // pre-compose anything if it were left there.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  return page.evaluate(
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
      // The most recently written file: the second render leaves its own entry
      // beside the first one's.
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
}
