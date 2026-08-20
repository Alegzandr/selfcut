import { test, expect } from '@playwright/test';
import { appModuleUrl } from './appModule';

/**
 * "Blur an area", from the menu to the monitor.
 *
 * `redaction.spec.ts` proves the pixels are right; this proves a user can get to
 * them. The path crosses four surfaces that only exist in the running app — the
 * clip menu, the store action, the inspector list and the drag overlay — and the
 * failure it is really here to catch is the quiet one: a command that adds a
 * region nobody can see or move, which looks like nothing happening at all.
 */

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
async function regions(page: import('@playwright/test').Page): Promise<Region[]> {
  const url = await appModuleUrl(page, '/src/store/store.ts');
  return page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as {
      useStore: { getState: () => { project: { tracks: { clips: { redactions?: Region[] }[] }[] } } };
    };
    const clips = useStore.getState().project.tracks.flatMap((t) => t.clips);
    return clips.find((c) => (c.redactions ?? []).length > 0)?.redactions ?? [];
  }, url);
}

test('a region is added from the menu, then dragged on the monitor', async ({ page }) => {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.setInputFiles('input[type=file]', 'e2e/fixtures/clip.mp4');
  await page.waitForSelector('[data-clip-id]');
  await page.waitForTimeout(1500);

  const clipBox = (await page.locator('[data-clip-id]').first().boundingBox())!;
  await page.mouse.click(clipBox.x + clipBox.width / 2, clipBox.y + clipBox.height / 2);
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: 'Clip', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Blur an area' }).click();
  await page.waitForTimeout(500);

  // The command opens the region it just added, so the next thing the user does
  // is place it - not hunt for it.
  const added = await regions(page);
  expect(added).toHaveLength(1);
  expect(added[0]!.mode).toBe('blur');
  await expect(page.getByRole('button', { name: /^Area 1/ })).toBeVisible();

  const stage = (await page.locator('[data-preview-canvas]').boundingBox())!;
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.72, stage.y + stage.height * 0.68, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);

  // The region lands where the pointer left it, in output-frame coordinates.
  expect((await regions(page))[0]!.x).toBeCloseTo(0.72, 2);
  expect((await regions(page))[0]!.y).toBeCloseTo(0.68, 2);

  // One drag, one undo step - and the region itself survives it.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  expect(await regions(page)).toHaveLength(1);
  expect((await regions(page))[0]!.x).toBeCloseTo(0.5, 2);
  await page.keyboard.press('Control+y');
  await page.waitForTimeout(400);
  expect((await regions(page))[0]!.x).toBeCloseTo(0.72, 2);
});

test('a clip carries as many regions as the shot needs', async ({ page }) => {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.setInputFiles('input[type=file]', 'e2e/fixtures/clip.mp4');
  await page.waitForSelector('[data-clip-id]');
  await page.waitForTimeout(1500);
  await page.locator('[data-clip-id]').first().click();
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: 'Clip', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Blur an area' }).click();
  await page.waitForTimeout(400);

  await page.getByRole('button', { name: 'Mosaic' }).click();
  await page.waitForTimeout(300);
  expect((await regions(page))[0]!.mode).toBe('pixelate');

  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForTimeout(400);
  const both = await regions(page);
  expect(both).toHaveLength(2);
  // Each region keeps its own settings: a second face does not have to be
  // hidden the same way as the first.
  expect(both.map((r) => r.mode)).toEqual(['pixelate', 'blur']);

  await page.locator('button[aria-label="Remove area"]').last().click();
  await page.waitForTimeout(300);
  expect(await regions(page)).toHaveLength(1);
});
