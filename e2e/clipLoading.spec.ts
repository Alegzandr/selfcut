import { test, expect } from '@playwright/test';
import { makeWav } from './wav';
import { appModuleUrl } from './appModule';

/**
 * A clip whose waveform has not been read yet says so, and stays editable.
 *
 * Peaks are computed behind the import (see `ensureAssetVisuals`): the clip
 * lands on the timeline at once and its waveform arrives after. On the
 * hour-long recordings this editor is for, that gap is seconds long, and until
 * it closed the lane was simply flat and empty - which reads as a file that
 * imported wrong rather than one still being read.
 *
 * The pass is driven by hand rather than raced against: a fixture whose read is
 * reliably slow would have to be big enough to make the suite slow too, and
 * what is under test here is the wiring - registry to indicator to waveform -
 * not how fast a decoder is. The registry's own behaviour (that it always
 * clears, including when a read fails) is unit-tested in `visualJobs.test.ts`.
 */
test('a clip shows its waveform being read, then the waveform', async ({ page }) => {
  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', {
    name: 'long-take.wav',
    mimeType: 'audio/wav',
    buffer: makeWav({ seconds: 60 }),
  });

  const clip = page.locator('[data-clip-id]');
  await expect(clip).toHaveCount(1);
  // The real pass over this fixture is quick; wait for it so the state below is
  // the one being set up rather than a leftover.
  await expect(clip.locator('canvas')).toBeVisible();

  const mods = {
    jobs: await appModuleUrl(page, '/src/media/visualJobs.ts'),
    store: await appModuleUrl(page, '/src/store/store.ts'),
  };

  // Put the clip back where it is right after an import of a long source: no
  // peaks yet, and a read running for them.
  await page.evaluate(async (m) => {
    const { peaksJobKey, trackVisualJob } = (await import(m.jobs)) as {
      peaksJobKey: (assetId: string, track: number) => string;
      trackVisualJob: (key: string, work: Promise<unknown>) => Promise<unknown>;
    };
    const { useStore } = (await import(m.store)) as {
      useStore: {
        getState: () => {
          assets: Record<string, { id: string }>;
          setAssetPeaks: (assetId: string, track: number, peaks: number[]) => void;
        };
      };
    };
    const assetId = Object.keys(useStore.getState().assets)[0]!;
    useStore.getState().setAssetPeaks(assetId, 0, []);
    void trackVisualJob(
      peaksJobKey(assetId, 0),
      new Promise((resolve) => {
        (globalThis as { landPeaks?: () => void }).landPeaks = () => resolve(null);
      }),
    );
  }, mods);

  const loading = clip.locator('[role="status"]');
  await expect(loading).toBeVisible();
  await expect(loading).toContainText(/waveform|audio/i);
  await expect(clip.locator('canvas')).toHaveCount(0);

  // Informative, not blocking: the clip answers a click while the read runs.
  await clip.click({ position: { x: 40, y: 12 } });
  await expect(clip).toHaveAttribute('aria-pressed', 'true');

  // And it ends. Nothing else clears it, so a read that resolved with nothing
  // to show would leave this indicator up for the rest of the session.
  await page.evaluate(async (m) => {
    const { useStore } = (await import(m.store)) as {
      useStore: {
        getState: () => {
          assets: Record<string, { id: string; audioTracks: { peaks?: number[] }[] }>;
          setAssetPeaks: (assetId: string, track: number, peaks: number[]) => void;
        };
      };
    };
    const assetId = Object.keys(useStore.getState().assets)[0]!;
    useStore.getState().setAssetPeaks(
      assetId,
      0,
      Array.from({ length: 9000 }, (_, i) => (i % 7) / 7),
    );
    (globalThis as { landPeaks?: () => void }).landPeaks?.();
  }, mods);

  await expect(loading).toHaveCount(0);
  await expect(clip.locator('canvas')).toBeVisible();
});
