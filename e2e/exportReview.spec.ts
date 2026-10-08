import { test, expect, type Page } from './test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * The review before publishing: findings in the viewer's terms, each with a
 * fix that lands in one undo step, and nothing that blocks a deliberate cut.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

type Store = {
  getState: () => {
    project: { tracks: { kind: string; clips: { id: string; kind: string; transform?: { y: number; scale: number } }[] }[] };
    updateClip: (id: string, patch: unknown) => void;
    addTextClip: () => void;
    currentTimeMs: number;
  };
};

async function withStore<T>(page: Page, fn: (store: Store) => T): Promise<T> {
  const url = await appModuleUrl(page, '/src/store/store.ts');
  return page.evaluate(
    async ({ mod, body }) => {
      const { useStore } = (await import(mod)) as { useStore: Store };
      return new Function('store', `return (${body})(store)`)(useStore);
    },
    { mod: url, body: fn.toString() },
  ) as Promise<T>;
}

/** A vertical cut: a square still over 0-5 s, and a tone that runs past it. */
async function verticalCut(page: Page): Promise<void> {
  await page.goto('/app/');
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.getByRole('button', { name: /^Portrait 9:16/ }).click();
  await page.setInputFiles('input[type=file]', [path.join(FIXTURES, 'checker.png'), path.join(FIXTURES, 'tone.wav')]);
  await expect(page.locator('[data-clip-id]')).toHaveCount(2);
}

const openExport = async (page: Page) => {
  await page.keyboard.press('Control+e');
  const sheet = page.getByRole('dialog', { name: 'Export' });
  await expect(sheet).toBeVisible();
  return sheet;
};

test('a letterboxed still is caught and filled in one undo step', async ({ page }) => {
  await verticalCut(page);
  const sheet = await openExport(page);
  const issue = sheet.locator('[data-review-issue="letterbox"]');
  await expect(issue).toContainText("doesn't fill the frame");

  await issue.getByRole('button', { name: 'Fill the frame' }).click();
  await expect(issue).toHaveCount(0);
  const scale = () =>
    withStore(page, (s) => s.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.kind === 'media' && c.transform)?.transform?.scale ?? 1);
  expect(await scale()).toBeGreaterThan(1);

  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect.poll(scale).toBe(1);
});

test('a title under the feed caption block is moved clear of it', async ({ page }) => {
  await verticalCut(page);
  await withStore(page, (s) => {
    s.getState().addTextClip();
    const text = s.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.kind === 'text')!;
    s.getState().updateClip(text.id, { transform: { ...text.transform, y: 0.85 } });
  });
  const sheet = await openExport(page);
  const issue = sheet.locator('[data-review-issue="uiZone"]');
  await expect(issue).toContainText("under the app's buttons");
  await issue.getByRole('button', { name: 'Move up' }).click();
  await expect(issue).toHaveCount(0);
  const y = await withStore(page, (s) => s.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.kind === 'text')!.transform!.y);
  expect(y).toBeLessThan(0.68);
});

test('switching the platform loudness off is pointed out, and turned back on from there', async ({ page }) => {
  await verticalCut(page);
  const sheet = await openExport(page);
  const loudness = sheet.getByRole('checkbox', { name: /Platform-ready loudness/ });
  await loudness.uncheck();
  const issue = sheet.locator('[data-review-issue="loudness"]');
  await expect(issue).toBeVisible();
  await issue.getByRole('button', { name: 'Turn on' }).click();
  await expect(loudness).toBeChecked();
  await expect(issue).toHaveCount(0);
});

test('a black gap takes the user to it', async ({ page }) => {
  await verticalCut(page);
  // Push the still 1 s in: the cut now opens on a second of black.
  await withStore(page, (s) => {
    const still = s.getState().project.tracks.find((t) => t.kind === 'video')!.clips[0]!;
    s.getState().updateClip(still.id, { timelineStartMs: 1000 });
  });
  const sheet = await openExport(page);
  const issue = sheet.locator('[data-review-issue="blackGaps"]');
  await expect(issue).toContainText('black gap');
  await issue.getByRole('button', { name: 'Go there' }).click();
  await expect(sheet).toHaveCount(0);
});

test('a clean cut says so, and the editor door has no review', async ({ page }) => {
  await page.goto('/app/');
  await page.setInputFiles('input[type=file]', path.join(FIXTURES, 'tone.wav'));
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
  const sheet = await openExport(page);
  await expect(sheet.getByText('Checked: nothing in the way of publishing.')).toBeVisible();
  await sheet.getByRole('button', { name: /^For my editor/ }).click();
  await expect(sheet.getByText('Checked: nothing in the way of publishing.')).toHaveCount(0);
});
