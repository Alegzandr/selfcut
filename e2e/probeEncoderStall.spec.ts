import { test, expect, type Page } from '@playwright/test';
import { appModuleUrl } from './appModule';

/**
 * Does a render that the encoder cannot sustain still finish?
 *
 * The failure this answers is the one two testers reported from two machines:
 * the export sheet reaches "estimating...", the bar stops, and nothing ever
 * happens again. It is not slowness. A browser's encoder can accept a
 * configuration - `canEncodeVideo` says yes, the session is created, frames are
 * queued - and then emit no packet at all, at which point every promise above
 * it waits for ever and there is nothing to catch. Reproduced here at
 * "YouTube 16:9 · 1440p" on a 1080p60 HEVC capture, on a machine where the same
 * timeline at 1080p exports fine.
 *
 * So this watches the PERCENTAGE rather than the download: a hang and a slow
 * render both blow a download timeout, and only the bar tells them apart. The
 * fallbacks in `retryPlan` are what it is really testing - one encoder instead
 * of two, then the software encoder - and their whole point is that the export
 * finishes without the user knowing any of it happened.
 *
 * A `probe*` spec: real footage from a scratch directory, and a render that
 * holds the machine's one hardware encoder for minutes. Run it by hand against
 * whatever a bug report arrived with:
 *
 *   PROBE=1 npx playwright test e2e/probeEncoderStall.spec.ts
 *   PROBE=1 STALL_SOURCE=D:/clips/report.mp4 STALL_QUALITY=4K npx playwright test e2e/probeEncoderStall.spec.ts
 */

const SOURCE = process.env.STALL_SOURCE ?? 'D:/Users/Alegzandr/Downloads/Episort.mp4';
/** The rung to export, as the sheet spells it ("1440p", "Full HD 1080p", "4K"). */
const QUALITY = process.env.STALL_QUALITY ?? '1440p';

/**
 * No movement at all for this long is a stall.
 *
 * Longer than every watchdog in `stallGuard` plus the fallbacks they trigger:
 * the render is allowed to stop, be given up on, and start again on gentler
 * terms without this firing. What it catches is the case where nothing in the
 * app noticed - which is precisely the bug.
 */
const NO_PROGRESS_MS = 420_000;

async function renderAtQuality(page: Page, quality: string): Promise<void> {
  // No save picker: the render takes the scratch path, which is the one every
  // report so far has come in on.
  await page.addInitScript(() => {
    delete (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const crashes: string[] = [];
  page.on('pageerror', (err) => crashes.push(err.message));
  page.on('console', (msg) => {
    if (msg.text().includes('[export]')) console.log(`  ${msg.text()}`);
  });

  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', SOURCE);
  // A linked import lands as a video clip and its audio partner.
  await expect(page.locator('[data-clip-id]')).toHaveCount(2, { timeout: 120_000 });

  await page.keyboard.press('Control+e');
  const sheet = page.getByRole('dialog', { name: 'Export' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: `YouTube 16:9 · ${quality}` }).click();
  await sheet.getByRole('button', { name: new RegExp(`^Export YouTube 16:9 · ${quality}`) }).click();

  const bar = sheet.getByRole('progressbar');
  const error = sheet.locator('.text-red-300');
  const startedAt = Date.now();
  let last = -1;
  let movedAt = Date.now();
  while (!(await sheet.getByText('Saved as', { exact: false }).count())) {
    if (await error.count()) throw new Error(`export failed: ${await error.innerText()}`);
    const now = await bar.getAttribute('aria-valuenow').catch(() => null);
    const pct = now === null ? last : Number(now);
    if (pct !== last) {
      last = pct;
      movedAt = Date.now();
      console.log(`  ${quality}: ${pct}% at ${Math.round((Date.now() - startedAt) / 1000)}s`);
    } else if (Date.now() - movedAt > NO_PROGRESS_MS) {
      throw new Error(`stalled at ${pct}% after ${Math.round((Date.now() - startedAt) / 1000)}s`);
    }
    await page.waitForTimeout(2000);
  }

  // Which encoder the render settled on, reported by the probe as well as by
  // the render itself - the difference between an export that took four minutes
  // and one that took forty, and the first thing worth knowing from a report.
  // Typed here rather than with `typeof import('../src/export/…')`: that would
  // pull the app's source into this config's TypeScript program, where
  // `import.meta.env` is not declared.
  const encoder = await page.evaluate(
    async (url) => {
      const mod = (await import(/* @vite-ignore */ url)) as {
        lastExportEncoder: () => unknown;
      };
      return mod.lastExportEncoder();
    },
    await appModuleUrl(page, '/src/export/exporter.ts'),
  );
  console.log(`  ${quality}: done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  console.log(`  ${quality}: encoder ${JSON.stringify(encoder)}`);
  expect(crashes).toEqual([]);
}

test(`renders ${QUALITY} to the end, whatever the encoder does`, async ({ page }) => {
  // Room for the render, its fallbacks, and a software encode of the whole
  // timeline if that is what it comes to.
  test.setTimeout(2_400_000);
  await renderAtQuality(page, QUALITY);
});
