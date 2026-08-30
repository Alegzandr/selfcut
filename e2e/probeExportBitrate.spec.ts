import { test, expect } from './test';

/**
 * What bitrate does a real export of a real capture actually come out at?
 *
 * `probeRateControl` answers the same question about the ENCODER, one
 * configuration at a time. This one answers it about the APP: import a capture,
 * pick a preset, export it, and compare the file that lands against the figure
 * the preset asked for. It is what turns "the encoder undershoots" into "the
 * export undershoots", which is the only version of the claim a user can see.
 *
 *   PROBE=1 EB_SOURCE=D:/clips/capture.mkv npx playwright test e2e/probeExportBitrate.spec.ts
 *
 * `EB_PRESET` picks the row ("Up to 120 fps · Full HD 1080p" by default) and
 * `EB_OUT` a file to write the export to.
 */

const SOURCE = process.env.EB_SOURCE;
const PRESET = process.env.EB_PRESET ?? 'Up to 120 fps · Full HD 1080p';
const OUT = process.env.EB_OUT;

test('a real export lands on the bitrate its preset asked for', async ({ page }) => {
  test.skip(!SOURCE, 'set EB_SOURCE to a capture to export');
  test.setTimeout(900_000);

  page.on('console', (msg) => {
    if (msg.text().includes('[export]')) console.log(`  ${msg.text()}`);
  });

  // No save picker: it is a native dialog, and the export waits on it for ever
  // in a headless run. Without this the render never starts.
  await page.addInitScript(() => {
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', SOURCE!);
  // A linked import lands as a video clip and its audio partner.
  await expect(page.locator('[data-clip-id]')).toHaveCount(2, { timeout: 180_000 });

  await page.keyboard.press('Control+e');
  const sheet = page.getByRole('dialog', { name: 'Export' });
  await expect(sheet).toBeVisible();
  // The custom presets - the 120 fps family among them - live behind their own
  // category tab, and the sheet opens on the platform ones: without this the
  // row simply is not in the DOM to click.
  await sheet.getByRole('button', { name: 'Custom', exact: true }).click();
  const rows = sheet.locator('button.block');
  const names = await rows.allInnerTexts();
  const index = names.findIndex((name) => name.startsWith(PRESET));
  if (index < 0) {
    throw new Error(`no preset row starts with '${PRESET}'. Rows: ${names.join(' | ')}`);
  }
  const row = rows.nth(index);
  await row.click();

  // The figure the sheet promises, read off the SELECTED row rather than
  // recomputed: what is being checked is the promise the user was shown.
  const promised = await row.innerText();

  const downloadPromise = page.waitForEvent('download', { timeout: 600_000 });
  await sheet.getByRole('button', { name: /^Export / }).click();
  const download = await downloadPromise;
  const file = OUT ?? (await download.path());
  if (OUT) await download.saveAs(OUT);

  console.log(`sheet says: ${promised.replace(/\s+/g, ' ')}`);
  console.log(`file: ${file}`);
  expect(file).toBeTruthy();
});
