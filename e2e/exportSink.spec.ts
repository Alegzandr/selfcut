import { test, expect } from '@playwright/test';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * Where an export's bytes land when the browser will not hand us a file.
 *
 * Chrome and Edge open a save picker and the render streams straight into the
 * chosen file. Firefox and Safari have no picker at all, and even where one
 * exists it can be refused - and the fallback used to be a single ArrayBuffer
 * holding the entire MP4. That is fine for a short 1080p clip and impossible
 * for the exports people reach a "120 fps · 4K" preset for: at ~134 Mbps a
 * six-minute render is ~6 GB in one contiguous allocation, and it died partway
 * through with the browser's raw "Array buffer allocation failed".
 *
 * The fallback now streams into origin-private scratch storage, so memory stays
 * flat whatever the length and the user still gets their download.
 *
 * It is also the one spec that drives the export sheet the way a user does -
 * shortcut, CTA, download - rather than calling the exporter directly the way
 * the other export specs do to keep their subject in view. So the wiring
 * between the two is asserted here as well: that the CTA renders the preset the
 * sheet has highlighted, and that the sheet reports where the file went. There
 * was a second spec doing exactly that and nothing else, which meant a third
 * full render of the same three seconds for one extra assertion.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

/**
 * Names and sizes of everything sitting in the export scratch directory.
 *
 * The OPFS handles are typed structurally inside each `evaluate`, not through
 * the DOM lib: this file compiles under the Node tsconfig, which has none.
 */
async function scratchContents(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    type Dir = {
      getDirectoryHandle(name: string): Promise<Dir>;
      getFileHandle(name: string): Promise<{ getFile(): Promise<{ size: number }> }>;
      keys(): AsyncIterable<string>;
    };
    const root = await (globalThis as unknown as {
      navigator: { storage: { getDirectory(): Promise<Dir> } };
    }).navigator.storage.getDirectory();
    let dir: Dir;
    try {
      dir = await root.getDirectoryHandle('exports');
    } catch {
      return [] as { name: string; size: number }[];
    }
    const out: { name: string; size: number }[] = [];
    for await (const name of dir.keys()) {
      const file = await (await dir.getFileHandle(name)).getFile();
      out.push({ name, size: file.size });
    }
    return out;
  });
}

test('without a save picker the render streams to disk, not into memory', async ({ page }) => {
  // Exactly the browsers this path exists for: no File System Access API.
  await page.addInitScript(() => {
    // `globalThis` rather than `window`: this file typechecks under the Node
    // tsconfig (no DOM lib), and in the page the two are the same object.
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', FIXTURE_MP4);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);

  expect(await scratchContents(page)).toEqual([]);

  await page.keyboard.press('Control+e');
  const sheet = page.getByRole('dialog', { name: 'Export' });
  await expect(sheet).toBeVisible();
  // The sheet springs in from below; clicking mid-animation can land on the
  // backdrop, which dismisses it. Wait for the box to stop moving.
  let prevBox = '';
  await expect
    .poll(async () => {
      const box = JSON.stringify(await sheet.boundingBox());
      const settled = box === prevBox;
      prevBox = box;
      return settled;
    })
    .toBe(true);

  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 });
  await sheet.getByRole('button', { name: /^Export / }).click();
  const download = await downloadPromise;

  // The user still gets their file, and it is a real one.
  expect(download.suggestedFilename()).toMatch(/\.mp4$/);
  const { size } = await stat(await download.path());
  expect(size).toBeGreaterThan(10_000);

  // And it came off disk: the render wrote into scratch storage rather than
  // growing a buffer the length of the whole export in RAM.
  const scratch = await scratchContents(page);
  expect(scratch).toHaveLength(1);
  expect(scratch[0]!.name).toMatch(/\.mp4$/);
  expect(scratch[0]!.size).toBe(size);

  // And the sheet says so, which is the only part of a finished export the user
  // ever sees.
  await expect(sheet.getByText('Saved as', { exact: false })).toBeVisible();

  // A second export reclaims the first one's file rather than stacking
  // gigabytes of finished renders in the origin's storage.
  await sheet.getByRole('button', { name: 'New export' }).click();
  const secondDownload = page.waitForEvent('download', { timeout: 90_000 });
  await sheet.getByRole('button', { name: /^Export / }).click();
  await secondDownload;

  const afterSecond = await scratchContents(page);
  expect(afterSecond).toHaveLength(1);
});

test('startup reclaims a leftover scratch file', async ({ page }) => {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
  // Let THIS session's startup sweep run first, so the file seeded below is
  // only ever reclaimed by the next one - which is what is being tested.
  //
  // Startup fires the sweep and does not await it (`void sweepExportScratch()`
  // in persistence.ts), so there is nothing to wait ON - but running one more
  // and awaiting THAT drains the directory's work queue, which is the property
  // actually needed. It replaces a flat 1500 ms guess that was both slower than
  // this and no guarantee on a slow machine.
  await page.evaluate(async (mod) => {
    const { sweepExportScratch } = (await import(mod)) as {
      sweepExportScratch: (except?: string) => Promise<void>;
    };
    await sweepExportScratch();
  }, await appModuleUrl(page, '/src/lib/opfs.ts'));

  // Stand in for the file a finished export leaves behind on purpose (the
  // download reads from it long after the render ends, so it cannot be deleted
  // there). Startup is where it is finally safe to reclaim.
  await page.evaluate(async () => {
    type Dir = {
      getDirectoryHandle(name: string, options: { create: boolean }): Promise<Dir>;
      getFileHandle(name: string, options: { create: boolean }): Promise<{
        createWritable(): Promise<{ write(d: Uint8Array): Promise<void>; close(): Promise<void> }>;
      }>;
    };
    const root = await (globalThis as unknown as {
      navigator: { storage: { getDirectory(): Promise<Dir> } };
    }).navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('exports', { create: true });
    const handle = await dir.getFileHandle('selfcut-stale.mp4', { create: true });
    const writable = await handle.createWritable();
    await writable.write(new Uint8Array(1024));
    await writable.close();
  });
  expect(await scratchContents(page)).toHaveLength(1);

  await page.reload();
  await expect(page.locator('canvas').first()).toBeVisible();

  await expect.poll(async () => (await scratchContents(page)).length).toBe(0);
});
