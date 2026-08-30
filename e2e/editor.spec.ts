import { test, expect } from './test';
import { Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

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

const PERSISTENCE_MODULE = '/src/lib/persistence.ts';
const STORE_MODULE = '/src/store/store.ts';

/**
 * Commit the debounced project write, then wait until the database really holds
 * what the reload is about to read.
 *
 * This was a `waitForTimeout(1200)` against a 500 ms debounce: two thirds of a
 * second of nothing on every run, and a coin toss on a machine slow enough for
 * the write to take longer than the guess. Asking the database is both faster
 * and stricter - it is the question the test is about, so a save that lands
 * empty now fails here, naming what it found, rather than three lines later as
 * a clip count nobody can explain.
 */
async function persisted(page: Page, clips: number, assets: number): Promise<void> {
  const persistence = await appModuleUrl(page, PERSISTENCE_MODULE);
  const store = await appModuleUrl(page, STORE_MODULE);
  await expect
    .poll(
      async () =>
        page.evaluate(
          async ({ p, s }) => {
            const persist = (await import(p)) as {
              flushProjectSave: () => void;
              loadProjectById: (
                id: string,
              ) => Promise<{ project: { tracks: { clips: unknown[] }[] }; assets: unknown[] } | null>;
            };
            const { useStore } = (await import(s)) as { useStore: { getState: () => never } };
            // A no-op once the debounce has already fired; what follows is what
            // decides, either way.
            persist.flushProjectSave();
            const id = (useStore.getState() as unknown as { project: { id: string } }).project.id;
            const saved = await persist.loadProjectById(id);
            if (!saved) return null;
            return {
              clips: saved.project.tracks.reduce((n, t) => n + t.clips.length, 0),
              assets: saved.assets.length,
            };
          },
          { p: persistence, s: store },
        ),
      { message: 'project written to IndexedDB' },
    )
    .toEqual({ clips, assets });
}

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

  await persisted(page, 2, 1);
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

  // No clips, both files: the exact shape that used to come back empty.
  await persisted(page, 0, 2);
  await page.reload();

  await expect(page.getByLabel('2 files')).toBeVisible();
});
