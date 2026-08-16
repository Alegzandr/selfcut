import { test, expect } from '@playwright/test';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The heaviest preset the app offers, end to end: "120 fps · 4K".
 *
 * It was the one preset a tester could not get through at all. Two things stood
 * behind that, and both are size-driven rather than codec-driven, which is why
 * dropping the preview resolution changed nothing: the render buffered the
 * whole file in memory when no save picker was available (~134 Mbps adds up
 * fast at that cadence), and it held one live decoder plus its decoded frames
 * per clip for the whole render - ~12 MB per 4K frame, times every clip in the
 * cut.
 *
 * Kept to the short fixture on purpose: what has to be proven here is that the
 * path works and stays flat, not how long a six-minute render takes. The
 * per-frame cost at 4K120 is real, so a longer timeline would only make the
 * suite slow without testing anything the frame count does not already cover.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

test('exports the 120 fps 4K preset without running out of memory', async ({ page }) => {
  test.setTimeout(240_000);

  // No save picker, so the render takes the fallback sink - the exact path the
  // failure was reported on.
  await page.addInitScript(() => {
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  const failures: string[] = [];
  page.on('pageerror', (err) => failures.push(err.message));

  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  // Several clips, so the render has more than one decoder to juggle: holding
  // them all was half of what made this preset run out of memory.
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

  await sheet.getByRole('button', { name: 'Custom' }).click();
  // The 120 fps family is offered at three rungs; the 4K one is the row whose
  // quality reads "4K".
  await sheet.getByRole('button', { name: '120 fps · 4K' }).click();

  const downloadPromise = page.waitForEvent('download', { timeout: 210_000 });
  await sheet.getByRole('button', { name: /^Export 120 fps · 4K/ }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/smooth120-4k.*\.mp4$/);
  const { size } = await stat(await download.path());
  expect(size).toBeGreaterThan(50_000);

  await expect(sheet.getByText('Saved as', { exact: false })).toBeVisible();
  // "Array buffer allocation failed" surfaced here, as a worker crash relayed
  // onto the error screen.
  await expect(sheet.getByText('failed', { exact: false })).toHaveCount(0);
  expect(failures).toEqual([]);
});
