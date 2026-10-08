import { test, expect, type Page } from './test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * The clip inspector, grouped by intent.
 *
 * Folding a group is a convenience, and the failure it must never cause is a
 * setting the user cannot see: an area added from the Clip menu into a folded
 * group, or a folded group that hides a grade without saying so.
 */

const FIXTURE_PNG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'checker.png');

const group = (page: Page, name: RegExp) => page.getByRole('button', { name });
const AREAS = /^Areas: blur, adjust, mask/;

/** Wait until the saved project carries the blurred area, so a reload keeps it. */
async function savedWithArea(page: Page): Promise<void> {
  const persistence = await appModuleUrl(page, '/src/lib/persistence.ts');
  const store = await appModuleUrl(page, '/src/store/store.ts');
  await expect
    .poll(() =>
      page.evaluate(
        async ({ p, s }) => {
          const persist = (await import(p)) as {
            flushProjectSave: () => void;
            loadProjectById: (id: string) => Promise<{ project: { tracks: { clips: { redactions?: unknown[] }[] }[] } } | null>;
          };
          const { useStore } = (await import(s)) as { useStore: { getState: () => { project: { id: string } } } };
          persist.flushProjectSave();
          const saved = await persist.loadProjectById(useStore.getState().project.id);
          return saved?.project.tracks.some((t) => t.clips.some((c) => (c.redactions ?? []).length > 0)) ?? false;
        },
        { p: persistence, s: store },
      ),
    )
    .toBe(true);
}

async function selectImportedImage(page: Page): Promise<void> {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.setInputFiles('input[type=file]', FIXTURE_PNG);
  await page.locator('[data-clip-id]').first().click();
}

test('the intents read in order, and the specialist ones start folded', async ({ page }) => {
  await selectImportedImage(page);
  const titles = await page.locator('[data-inspector-group] > button').allInnerTexts();
  expect(titles.map((s) => s.trim())).toEqual([
    'Timing',
    'Framing',
    'Colour',
    'Advanced: curves, green screen',
    'Areas: blur, adjust, mask',
  ]);
  await expect(group(page, AREAS)).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Add a blurred area', exact: true })).toHaveCount(0);
});

test('an area added from the Clip menu opens its folded group', async ({ page }) => {
  await selectImportedImage(page);
  await expect(group(page, AREAS)).toHaveAttribute('aria-expanded', 'false');

  await page.getByRole('button', { name: 'Clip', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Blur an area' }).click();

  await expect(group(page, AREAS)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: /^Area 1/ })).toBeVisible();
});

test('a folded group that holds settings says so, and the fold survives a reload', async ({ page }) => {
  await selectImportedImage(page);
  await page.getByRole('button', { name: 'Clip', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Blur an area' }).click();
  await expect(group(page, AREAS)).toHaveAttribute('aria-expanded', 'true');

  await group(page, AREAS).click();
  await expect(group(page, AREAS)).toHaveAttribute('aria-expanded', 'false');
  await expect(group(page, AREAS)).toHaveAccessibleName(/Has settings$/);

  // Selecting the clip again must not undo the user's fold.
  await page.keyboard.press('Escape');
  await page.locator('[data-clip-id]').first().click();
  await expect(group(page, AREAS)).toHaveAttribute('aria-expanded', 'false');

  await savedWithArea(page);
  await page.reload();
  await page.locator('[data-clip-id]').first().click();
  await expect(group(page, AREAS)).toHaveAttribute('aria-expanded', 'false');
  await expect(group(page, AREAS)).toHaveAccessibleName(/Has settings$/);
});
