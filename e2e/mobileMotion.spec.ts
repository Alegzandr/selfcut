import { test, expect } from './test';
import { devices, type Page } from '@playwright/test';

/**
 * Panels animate on the compositor, and stop animating for people who ask.
 *
 * A sheet opens at the exact moment React is mounting everything inside it, so
 * on a phone the two compete: with the slide driven from the main thread, the
 * mount work lands between its frames and the panel visibly stutters. Handing
 * the movement to the browser's own compositor takes it out of that race, and
 * Motion only does that for a fixed list of properties - `transform` is on it,
 * the `x`/`y`/`scale` shorthands are not (see `src/ui/motion.ts`).
 *
 * That distinction is invisible in a diff and silent at runtime: a panel
 * rewritten back to `y: '100%'` still opens, still looks right in a screenshot,
 * and is janky again. So the assertion is on the animation the browser is
 * actually running, which is the only place the difference shows.
 */

test.use({ ...devices['iPhone 14 Pro'], defaultBrowserType: 'chromium' });

/** The animations the browser is running, sampled every frame while `open` runs. */
async function animationsDuring(page: Page, open: () => Promise<void>) {
  await page.evaluate(() => {
    const w = window as unknown as { sampledAnimations: unknown[]; stopSampling: boolean };
    w.sampledAnimations = [];
    w.stopSampling = false;
    const poll = () => {
      for (const a of document.getAnimations()) {
        const target = (a.effect as KeyframeEffect | null)?.target;
        w.sampledAnimations.push({
          className: target?.className?.toString() ?? '',
          props: (a.effect as KeyframeEffect | null)
            ?.getKeyframes()
            .flatMap((k) => Object.keys(k))
            .filter((k) => k === 'transform' || k === 'opacity'),
        });
      }
      if (!w.stopSampling) requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
  await open();
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const w = window as unknown as {
      sampledAnimations: { className: string; props: string[] }[];
      stopSampling: boolean;
    };
    w.stopSampling = true;
    return w.sampledAnimations;
  });
}

const openMenuSheet = (page: Page) => page.getByRole('button', { name: 'Menu' }).click();
const openDrawer = (page: Page) => page.getByRole('button', { name: 'Media library' }).click();

test('the touch sheets and drawers animate transform, not the main-thread shorthands', async ({
  page,
}) => {
  await page.goto('/app/');

  const sheet = await animationsDuring(page, () => openMenuSheet(page));
  expect(
    sheet.filter((a) => a.className.includes('rounded-t-2xl') && a.props.includes('transform')),
    'the menu sheet slides via an animation the compositor can run',
  ).not.toHaveLength(0);
  await page.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByRole('menuitem', { name: 'Export…' })).toBeHidden();

  const drawer = await animationsDuring(page, () => openDrawer(page));
  expect(
    drawer.filter((a) => a.className.includes('inset-y-0') && a.props.includes('transform')),
    'the media drawer slides via an animation the compositor can run',
  ).not.toHaveLength(0);

  // And it arrives: an animation that runs but leaves the panel parked off
  // screen would satisfy everything above.
  const aside = page.locator('aside.fixed');
  await expect(aside).toBeVisible();
  await expect
    .poll(() => aside.evaluate((el) => getComputedStyle(el).transform))
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
});

test('a request for less motion is still honoured', async ({ page }) => {
  // Emulated on the page rather than through `test.use`: `reducedMotion` set in
  // a describe block does not survive this file's device-level `test.use`, and
  // an option that silently does nothing would make this test pass on a build
  // that ignores the setting entirely.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/app/');

  const sheet = await animationsDuring(page, () => openMenuSheet(page));
  expect(
    sheet.filter((a) => a.props.includes('transform')),
    'nothing may travel: the move to `transform` must not slip past `reducedMotion`',
  ).toHaveLength(0);
  // The sheet is up all the same, and it faded in rather than snapping.
  await expect(page.getByRole('menuitem', { name: 'Export…' })).toBeVisible();
  expect(sheet.filter((a) => a.props.includes('opacity'))).not.toHaveLength(0);
});
