import { test, expect, type Page } from './test';

/**
 * The editor paints in the visitor's language on the first frame.
 *
 * Three failures this pins down. The boot loaded the dictionary of
 * `resolvedLanguage`, which is still "en" before any other bundle exists, so
 * a French visitor got English unless a later event happened to win the race.
 * Portuguese and Chinese were refused outright: with `nonExplicitSupportedLngs`
 * i18next checks "pt-BR" by its base "pt", which was not listed. And the
 * detector cached its first guess, so one English first paint pinned English
 * for good.
 */

const firstMenu = (page: Page) => page.locator('button[aria-expanded]').first();

for (const [locale, file] of [
  ['fr-FR', 'Fichier'],
  ['pt', 'Arquivo'],
  ['zh', '文件'],
  ['de-AT', 'Datei'],
  ['en-US', 'File'],
] as const) {
  test.describe(`a ${locale} browser`, () => {
    test.use({ locale });

    test('gets its own language on the first paint', async ({ page }) => {
      await page.goto('/app/');
      await expect(firstMenu(page)).toHaveText(file);
    });
  });
}

test.describe('a language picked in Preferences', () => {
  test.use({ locale: 'en-US' });

  test('applies at once, shows as selected, and survives a reload', async ({ page }) => {
    await page.goto('/app/');
    await expect(firstMenu(page)).toHaveText('File');

    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('menuitem', { name: /Preferences/ }).click();
    // By its options, not its name: the name itself switches to Japanese.
    const picker = page.locator('select:has(option[value="ja"])');
    await picker.selectOption('ja');
    await expect(picker).toHaveValue('ja');
    await expect(firstMenu(page)).toHaveText('ファイル');

    await page.reload();
    await expect(firstMenu(page)).toHaveText('ファイル');
  });

  test('is not written for a visitor who never picked one', async ({ page }) => {
    await page.goto('/app/');
    await expect(firstMenu(page)).toHaveText('File');
    expect(await page.evaluate(() => localStorage.getItem('selfcut.lang'))).toBeNull();
  });
});
