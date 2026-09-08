import { test, expect } from './test';
import { type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * Getting into a composition, and back out.
 *
 * The model tests prove the tree is right and the export test proves the pixels
 * are; this proves a user can reach any of it. Opening a precomp replaces the
 * whole timeline - its lanes, its clips, its length - so the failure worth
 * catching here is the disorienting one: a way in with no way out, or a trail
 * that says you are somewhere you are not.
 *
 * Every route in and out is exercised, because each is the only one some user
 * will ever find: the shortcut, the menu, the double-click on the clip, the
 * library card, the breadcrumb.
 *
 * Every wait is on a value, never on a duration.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_MP4 = path.join(FIXTURES, 'clip.mp4');

/** Where the editor is standing, read off the store rather than guessed at. */
async function standing(page: Page): Promise<{ compId: string | null; comps: number }> {
  const url = await appModuleUrl(page, '/src/store/store.ts');
  return page.evaluate(async (mod) => {
    const { useStore } = (await import(mod)) as {
      useStore: {
        getState: () => { activeCompId: string | null; project: { comps?: unknown[] } };
      };
    };
    const s = useStore.getState();
    return { compId: s.activeCompId, comps: (s.project.comps ?? []).length };
  }, url);
}

const trailOf = (page: Page) => page.getByRole('navigation', { name: 'Composition path' });
const clips = (page: Page) => page.locator('[data-clip-id]');

/**
 * Select a clip by pressing near its top edge.
 *
 * Not its centre: a video clip carries the speed line's grab band across its
 * middle, and that band swallows the press (it is a control of its own). Users
 * aim at the body of a clip, not at the hairline through it, and so does this.
 */
async function selectClip(page: Page, index = 0): Promise<void> {
  const box = (await clips(page).nth(index).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 6);
  await page.mouse.down();
  await page.mouse.up();
}

/** The fixture, razored in two, with both halves selected. */
async function twoShots(page: Page): Promise<void> {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.setInputFiles('input[type=file]', FIXTURE_MP4);
  await expect(clips(page)).toHaveCount(1);
  await page.keyboard.press('Home');
  for (let f = 0; f < 20; f++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('s');
  await expect(clips(page)).toHaveCount(2);
  await page.keyboard.press('Control+a');
}

test('the shortcut wraps the selection and walks into it', async ({ page }) => {
  await twoShots(page);
  await page.keyboard.press('Control+Shift+C');

  // Inside: the trail names where we are, and the lanes are the composition's.
  await expect(trailOf(page)).toBeVisible();
  await expect(trailOf(page).getByRole('button', { name: 'Main timeline' })).toBeVisible();
  await expect(clips(page)).toHaveCount(2);
  await expect.poll(() => standing(page)).toMatchObject({ comps: 1 });

  // Escape is the way out, and the parent is left holding one clip.
  await page.keyboard.press('Escape');
  await expect(trailOf(page)).toBeHidden();
  await expect(clips(page)).toHaveCount(1);
  await expect.poll(async () => (await standing(page)).compId).toBeNull();
});

test('the clip opens on a double-click, and the trail closes it', async ({ page }) => {
  await twoShots(page);
  await page.keyboard.press('Control+Shift+C');
  await page.keyboard.press('Escape');
  await expect(clips(page)).toHaveCount(1);

  // The gesture every editor that nests sequences uses, and the one people try
  // first.
  await clips(page).first().dblclick();
  await expect(trailOf(page)).toBeVisible();
  await expect(clips(page)).toHaveCount(2);

  // And the root step of the trail is a way back, not just a label.
  await trailOf(page).getByRole('button', { name: 'Main timeline' }).click();
  await expect(trailOf(page)).toBeHidden();
  await expect(clips(page)).toHaveCount(1);
});

test('the composition lands in the library, and opens from there', async ({ page }) => {
  await twoShots(page);
  await page.keyboard.press('Control+Shift+C');
  await page.keyboard.press('Escape');

  // A precomp is a source the user made, so it belongs in the bin beside the
  // footage - and the card says what is inside without opening it.
  const card = page.getByRole('button', { name: 'Open composition' });
  await expect(card).toBeVisible();
  await expect(page.getByText('Layers: 1').first()).toBeVisible();
  await card.click();
  await expect(trailOf(page)).toBeVisible();
  await expect(clips(page)).toHaveCount(2);
});

test('nesting a composition inside another keeps the whole trail walkable', async ({ page }) => {
  await twoShots(page);
  await page.keyboard.press('Control+Shift+C');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+Shift+C');

  // Three steps: the main timeline, the outer composition, the inner one.
  const steps = trailOf(page).locator('ol li');
  await expect(steps).toHaveCount(3);

  // The middle step is a real destination, not decoration.
  await steps.nth(1).getByRole('button').click();
  await expect(steps).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(trailOf(page)).toBeHidden();
});

test('an edit inside the composition lands there, not on the main timeline', async ({ page }) => {
  await twoShots(page);
  await page.keyboard.press('Control+Shift+C');
  await expect(clips(page)).toHaveCount(2);

  // Deleting inside must not reach the cut outside it.
  await selectClip(page);
  await page.keyboard.press('Delete');
  await expect(clips(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  // The parent still holds exactly its one layer.
  await expect(clips(page)).toHaveCount(1);
  await clips(page).first().dblclick();
  await expect(clips(page)).toHaveCount(1);
});

test('un-precomposing puts the clips back on the timeline', async ({ page }) => {
  await twoShots(page);
  await page.keyboard.press('Control+Shift+C');
  await page.keyboard.press('Escape');
  await expect(clips(page)).toHaveCount(1);

  await selectClip(page);
  await page.getByRole('button', { name: 'Clip', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Un-precompose' }).click();

  await expect(clips(page)).toHaveCount(2);
  // Nothing plays the composition any more, so it leaves the library with it.
  await expect.poll(async () => (await standing(page)).comps).toBe(0);
});
