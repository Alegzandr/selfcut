import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * "Blur an area", from the menu to the monitor.
 *
 * `redaction.spec.ts` proves the pixels are right; this proves a user can get to
 * them. The path crosses four surfaces that only exist in the running app - the
 * clip menu, the store action, the inspector list and the drag overlay - and the
 * failure it is really here to catch is the quiet one: a command that adds a
 * region nobody can see or move, which looks like nothing happening at all.
 *
 * Every wait here is on a value, never on a duration. The spec used to sleep ten
 * times - 5.4 seconds a run, most of it spent after the app had already finished
 * - and each of those sleeps was also the only thing standing between a slower
 * machine and a false failure, since the assertion that followed read the store
 * once and took whatever it found.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

interface Region {
  id: string;
  mode: string;
  x: number;
  y: number;
}

/**
 * The regions on the clip that has any. Not looked up through the selection:
 * undo clears it, and this would then read an empty list right after a Ctrl+Z.
 */
async function regions(page: Page): Promise<Region[]> {
  const url = await appModuleUrl(page, '/src/store/store.ts');
  return page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as {
      useStore: { getState: () => { project: { tracks: { clips: { redactions?: Region[] }[] }[] } } };
    };
    const clips = useStore.getState().project.tracks.flatMap((t) => t.clips);
    return clips.find((c) => (c.redactions ?? []).length > 0)?.redactions ?? [];
  }, url);
}

/** Poll the store until the regions settle into what the last action asked for. */
function expectRegions(page: Page, message: string) {
  return expect.poll(() => regions(page), { message });
}

/** Import the fixture and select its clip, ready for the Clip menu. */
async function selectImportedClip(page: Page): Promise<void> {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.setInputFiles('input[type=file]', FIXTURE_MP4);
  // The locator click is what replaces the sleep that used to sit here: it
  // waits for the clip to be visible, stable and hit-testable, which is the
  // whole of what those 1500 ms were guessing at.
  await page.locator('[data-clip-id]').first().click();
}

test('a region is added from the menu, then dragged on the monitor', async ({ page }) => {
  await selectImportedClip(page);

  await page.getByRole('button', { name: 'Clip', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Blur an area' }).click();

  // The command opens the region it just added, so the next thing the user does
  // is place it - not hunt for it.
  await expectRegions(page, 'the blur region was added').toMatchObject([{ mode: 'blur' }]);
  await expect(page.getByRole('button', { name: /^Area 1/ })).toBeVisible();

  const stage = (await page.locator('[data-preview-canvas]').boundingBox())!;
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.72, stage.y + stage.height * 0.68, { steps: 12 });
  await page.mouse.up();

  // The region lands where the pointer left it, in output-frame coordinates.
  await expect
    .poll(async () => (await regions(page))[0]!.x, { message: 'dragged x' })
    .toBeCloseTo(0.72, 2);
  expect((await regions(page))[0]!.y).toBeCloseTo(0.68, 2);

  // One drag, one undo step - and the region itself survives it.
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await regions(page))[0]!.x, { message: 'undone x' })
    .toBeCloseTo(0.5, 2);
  expect(await regions(page)).toHaveLength(1);
  await page.keyboard.press('Control+y');
  await expect
    .poll(async () => (await regions(page))[0]!.x, { message: 'redone x' })
    .toBeCloseTo(0.72, 2);
});

test('a clip carries as many regions as the shot needs', async ({ page }) => {
  await selectImportedClip(page);

  await page.getByRole('button', { name: 'Clip', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Blur an area' }).click();
  await expectRegions(page, 'the first region was added').toHaveLength(1);

  await page.getByRole('button', { name: 'Mosaic' }).click();
  await expectRegions(page, 'the first region became a mosaic').toMatchObject([
    { mode: 'pixelate' },
  ]);

  await page.getByRole('button', { name: 'Add', exact: true }).click();
  // Each region keeps its own settings: a second face does not have to be
  // hidden the same way as the first.
  await expectRegions(page, 'a second region was added').toMatchObject([
    { mode: 'pixelate' },
    { mode: 'blur' },
  ]);

  await page.locator('button[aria-label="Remove area"]').last().click();
  await expectRegions(page, 'the second region was removed').toHaveLength(1);
});
