import { test, expect } from './test';
import { devices } from '@playwright/test';

/**
 * The touch menu sheet scrolls in one direction.
 *
 * A phone reported the whole menu sliding sideways under the thumb, and the
 * cause was two pixels: `overflow-y-auto` computes overflow-x to `auto`, and
 * `touch-hit` hangs an invisible 8px hit-area expander off every row, which
 * poked past the column's inline padding. Two pixels of scrollable width is
 * enough for a touch browser to take the gesture and rubber-band the column
 * across the screen, so nothing about the symptom looked two pixels wide.
 *
 * The assertion is therefore on the measurement rather than on the classes: any
 * future wide child - a long localized label, a badge, a slider - fails here,
 * whichever of the two guards it slips past.
 */

// Chromium runs the emulation (see the config: the app is WebCodecs-only); the
// descriptor is here for the viewport and, above all, for `hasTouch`, which is
// what puts the app on its touch layout and turns `pointer: coarse` on.
test.use({ ...devices['iPhone 14 Pro'], defaultBrowserType: 'chromium' });

test('the menu sheet has nothing to scroll horizontally', async ({ page }) => {
  await page.goto('/app/');

  await page.getByRole('button', { name: 'Menu' }).click();
  const sheet = page.getByRole('menu', { name: 'Menu' });
  await expect(sheet.getByRole('menuitem', { name: 'Export…' })).toBeVisible();

  // Every scroller inside the sheet, with the widths it would scroll across.
  const scrollers = await sheet.evaluate((root: HTMLElement) =>
    [root, ...root.querySelectorAll<HTMLElement>('*')]
      .filter((el) => {
        const overflow = getComputedStyle(el);
        return ['auto', 'scroll', 'hidden'].includes(overflow.overflowY) && el.clientWidth > 0;
      })
      .map((el) => ({
        className: el.className,
        overflowX: getComputedStyle(el).overflowX,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      })),
  );

  expect(scrollers.length).toBeGreaterThan(0);
  for (const el of scrollers) {
    expect(el.overflowX, `${el.className} must not offer a horizontal scroll`).not.toMatch(
      /auto|scroll/,
    );
    expect(el.scrollWidth, `${el.className} overflows its width`).toBeLessThanOrEqual(
      el.clientWidth,
    );
  }
});
