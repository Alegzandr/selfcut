import { test, expect } from './test';
import { type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * "Adjust an area", from the menu to the monitor.
 *
 * `localAdjust.spec.ts` proves the pixels are right; this proves a user can get
 * to them. The path crosses the clip menu, the store action, the inspector list,
 * the grade sliders with their keyframe diamonds, and the drag overlay — and the
 * failure it is really here to catch is the quiet one: a region added where
 * nobody can see it, which looks like nothing happening at all.
 *
 * Every wait is on a value, never on a duration.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

interface Region {
  id: string;
  x: number;
  y: number;
  color: Record<string, unknown>;
}

/**
 * The regions on the clip that has any. Not looked up through the selection:
 * undo clears it, and this would then read an empty list right after a Ctrl+Z.
 */
async function regions(page: Page): Promise<Region[]> {
  const url = await appModuleUrl(page, '/src/store/store.ts');
  return page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as {
      useStore: {
        getState: () => { project: { tracks: { clips: { localAdjusts?: Region[] }[] }[] } };
      };
    };
    const clips = useStore.getState().project.tracks.flatMap((t) => t.clips);
    return clips.find((c) => (c.localAdjusts ?? []).length > 0)?.localAdjusts ?? [];
  }, url);
}

function expectRegions(page: Page, message: string) {
  return expect.poll(() => regions(page), { message });
}

/** Import the fixture, select its clip, and add an adjusted area from the menu. */
async function addRegion(page: Page): Promise<void> {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.setInputFiles('input[type=file]', FIXTURE_MP4);
  await page.locator('[data-clip-id]').first().click();
  await page.getByRole('button', { name: 'Clip', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Adjust an area' }).click();
}

test('an area is added from the menu, then dragged on the monitor', async ({ page }) => {
  await addRegion(page);

  // Added carrying no grade at all: the shape is what there is to place first.
  await expectRegions(page, 'the adjusted area was added').toMatchObject([{ color: {} }]);
  // ...and opened, so the next thing the user does is place it, not hunt for it.
  await expect(page.getByRole('button', { name: /^Area 1/ })).toBeVisible();

  const stage = (await page.locator('[data-preview-canvas]').boundingBox())!;
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.down();
  await page.mouse.move(stage.x + stage.width * 0.7, stage.y + stage.height * 0.35, { steps: 12 });
  await page.mouse.up();

  await expect
    .poll(async () => (await regions(page))[0]!.x, { message: 'dragged x' })
    .toBeCloseTo(0.7, 2);
  expect((await regions(page))[0]!.y).toBeCloseTo(0.35, 2);

  // One drag, one undo step - and the region itself survives it.
  await page.keyboard.press('Control+z');
  await expect
    .poll(async () => (await regions(page))[0]!.x, { message: 'undone x' })
    .toBeCloseTo(0.5, 2);
  expect(await regions(page)).toHaveLength(1);
});

test('the region grades through the same sliders as the clip, and keyframes them', async ({
  page,
}) => {
  await addRegion(page);
  await expectRegions(page, 'the adjusted area was added').toHaveLength(1);

  // The section carries the grade sliders. The whole claim of the feature is
  // that these are the Adjust parameters, not a reduced set of their own.
  const section = page.locator('[data-local-adjusts]');
  for (const label of ['Brightness', 'Contrast', 'Saturation', 'Temperature', 'Tint', 'Sharpen']) {
    await expect(section.getByText(label, { exact: true }).first()).toBeVisible();
  }

  // The keyframe diamond next to Brightness turns the parameter into a channel.
  await section.getByRole('button', { name: /Keyframe · Brightness/ }).first().click();
  await expect
    .poll(async () => Array.isArray((await regions(page))[0]!.color.brightness), {
      message: 'brightness became a keyframed channel',
    })
    .toBe(true);
});
