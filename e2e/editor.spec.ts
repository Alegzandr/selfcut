import { test, expect, Page } from '@playwright/test';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Core editing flow, driven through the real UI in Chromium (the app is built
 * on WebCodecs, so Chromium is the only supported engine - see the config).
 *
 * Selector vocabulary (stable hooks the app already exposes):
 * - `[data-clip-id]` - one element per clip on the timeline
 * - the empty timeline renders a hidden `input[type=file]` for import
 * - dialogs carry `role="dialog"`
 */

// The package is `type: "module"`, so specs load as ESM: no __dirname here.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');
const FIXTURE_WAV = path.join(FIXTURES, 'tone.wav');

const EDITOR_URL = '/app/';

/** Open the editor and import the 3 s video fixture; resolves once its clip is on the timeline. */
async function importFixture(page: Page): Promise<void> {
  await page.goto(EDITOR_URL);
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
}

/**
 * Split the (only) clip: move the playhead 1 s into it, then press the razor
 * key. The fixture is video-only, so one clip becomes exactly two.
 */
async function splitClip(page: Page): Promise<void> {
  await page.keyboard.press('Shift+ArrowRight'); // +1 s
  await page.keyboard.press('s'); // razor at playhead
  await expect(page.locator('[data-clip-id]')).toHaveCount(2);
}

test('editor loads: preview canvas and timeline dropzone render without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(EDITOR_URL);

  // The preview canvas is always mounted; the empty timeline shows the dropzone.
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.getByText('Drop your clips here', { exact: false })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toBeAttached();

  expect(errors).toEqual([]);
});

test('importing a video puts a clip on the timeline', async ({ page }) => {
  await importFixture(page);

  const clip = page.locator('[data-clip-id]');
  await expect(clip).toHaveAttribute('data-clip-kind', 'video');
  // The empty-state dropzone (and its file input) is gone once a clip landed.
  await expect(page.getByText('Drop your clips here', { exact: false })).toHaveCount(0);
});

test('importing an audio file puts an audio clip on the timeline', async ({ page }) => {
  await page.goto(EDITOR_URL);
  await page.setInputFiles('input[type="file"]', FIXTURE_WAV);

  const clip = page.locator('[data-clip-id]');
  await expect(clip).toHaveCount(1);
  await expect(clip).toHaveAttribute('data-clip-kind', 'audio');
});

test('splitting at the playhead turns one clip into two', async ({ page }) => {
  await importFixture(page);
  await splitClip(page);

  // Both halves stay on the same (single) video track.
  await expect(page.locator('[data-track-id]')).toHaveCount(1);
});

test('undo restores the split and redo reapplies it (both redo bindings)', async ({ page }) => {
  await importFixture(page);
  await splitClip(page);
  const clips = page.locator('[data-clip-id]');

  await page.keyboard.press('Control+z');
  await expect(clips).toHaveCount(1);

  await page.keyboard.press('Control+Shift+z');
  await expect(clips).toHaveCount(2);

  await page.keyboard.press('Control+z');
  await expect(clips).toHaveCount(1);

  await page.keyboard.press('Control+y');
  await expect(clips).toHaveCount(2);
});

test('the project survives a reload via IndexedDB', async ({ page }) => {
  await importFixture(page);
  await splitClip(page);

  // The project JSON write is debounced (500 ms); let it commit before reloading.
  await page.waitForTimeout(1200);
  await page.reload();

  await expect(page.locator('[data-clip-id]')).toHaveCount(2);
  await expect(page.locator('[data-clip-id]').first()).toHaveAttribute('data-clip-kind', 'video');
});

/**
 * Media imported into the library alone - no clip on the timeline - is the one
 * shape of work that used to be dropped on the next start: the project record
 * is what makes a library reachable, and only a TIMELINE edit ever wrote one,
 * so an import-only session came back empty and the orphan sweep then deleted
 * the files for good.
 */
test('media imported into the library alone survives a reload', async ({ page }) => {
  await page.goto(EDITOR_URL);

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import files' }).click();
  await (await chooser).setFiles([FIXTURE_MP4, FIXTURE_WAV]);

  // Both cards are in the library, and nothing was placed on the timeline.
  await expect(page.getByLabel('2 files')).toBeVisible();
  await expect(page.locator('[data-clip-id]')).toHaveCount(0);

  await page.waitForTimeout(1200);
  await page.reload();

  await expect(page.getByLabel('2 files')).toBeVisible();
});

test('export renders an MP4 and hands it over as a download', async ({ page }) => {
  // This test renders. Two Playwright workers share one encoder, and where that
  // encoder is a software one the render is CPU-bound against whatever the
  // neighbouring spec is encoding: the same export measured 11s alone and over
  // 90s beside a busy worker on a CI runner. Nothing here asserts a duration -
  // exportPerf.spec.ts is where the render's cost is a claim - so the budget is
  // simply made wide enough that a slow machine is not a failure.
  test.slow();
  // Headless has no save-file picker UI; removing the API entirely routes the
  // exporter onto its buffered fallback, which ends in a download-attribute
  // anchor click that Playwright can capture.
  await page.addInitScript(() => {
    // `globalThis` rather than `window`: this file typechecks under the Node
    // tsconfig (no DOM lib), and in the page the two are the same object.
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await importFixture(page);

  await page.keyboard.press('Control+e');
  const sheet = page.getByRole('dialog', { name: 'Export' });
  await expect(sheet).toBeVisible();
  // The sheet springs in from below (framer-motion). Clicking mid-animation
  // can land on the backdrop, which dismisses the sheet in its idle phase:
  // wait until its bounding box stops moving.
  let prevBox = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await sheet.boundingBox());
      const settled = box === prevBox;
      prevBox = box;
      return settled;
    })
    .toBe(true);

  const downloadPromise = page.waitForEvent('download', { timeout: 240_000 });
  // The CTA reads "Export <preset name>"; preset buttons themselves don't start with "Export".
  await sheet.getByRole('button', { name: /^Export / }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
  const file = await download.path();
  const { size } = await stat(file);
  expect(size).toBeGreaterThan(10_000);

  await expect(sheet.getByText('Saved as', { exact: false })).toBeVisible();
});
