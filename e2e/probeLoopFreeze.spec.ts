import { test, expect } from '@playwright/test';
import { appModuleUrl } from './appModule';

/**
 * Ad-hoc: how long the picture stands still when playback starts and when a
 * loop wraps, measured on the real preview canvas.
 *
 * PROBE=1 FOOTAGE="D:/path/clip.mkv" npx playwright test e2e/probeLoopFreeze.spec.ts
 */

const EDITOR_URL = '/app/';
const FOOTAGE = process.env.FOOTAGE ?? '';
const STORE_MODULE = '/src/store/store.ts';

test('loop freeze on supplied footage', async ({ page }) => {
  test.skip(!FOOTAGE, 'set FOOTAGE');
  test.setTimeout(300_000);
  page.on('console', (m) => console.log(`[page:${m.type()}] ${m.text()}`));
  await page.goto(EDITOR_URL);
  await page.setInputFiles('input[type="file"]', FOOTAGE);
  await expect(page.locator('[data-clip-id]').first()).toBeVisible({ timeout: 120_000 });

  const store = await appModuleUrl(page, STORE_MODULE);
  const report = await page.evaluate(
    async (mod) => {
      const { useStore } = (await import(mod)) as {
        useStore: {
          getState: () => {
            currentTimeMs: number;
            loopEnabled: boolean;
            seek: (ms: number) => void;
            setLoopRegion: (region: { startMs: number; endMs: number }) => void;
            setPlaying: (playing: boolean) => void;
            toggleLoopEnabled: () => void;
          };
        };
      };
      const s = () => useStore.getState();
      s().setLoopRegion({ startMs: 3000, endMs: 6000 });
      if (!s().loopEnabled) s().toggleLoopEnabled();
      s().seek(3000);
      await new Promise((r) => setTimeout(r, 1500));

      const canvas = document.querySelector('canvas[data-preview-canvas]') as HTMLCanvasElement;
      const off = new OffscreenCanvas(32, 18);
      const octx = off.getContext('2d', { willReadFrequently: true })!;
      const samples: { t: number; hash: number; time: number; bright: number }[] = [];
      let stop = false;
      const sample = () => {
        if (stop) return;
        octx.drawImage(canvas, 0, 0, 32, 18);
        const d = octx.getImageData(0, 0, 32, 18).data;
        let h = 0;
        let bright = 0;
        for (let i = 0; i < d.length; i += 4) {
          h = (h * 31 + d[i]!) | 0;
          bright = Math.max(bright, d[i]!, d[i + 1]!, d[i + 2]!);
        }
        samples.push({ t: performance.now(), hash: h, time: s().currentTimeMs, bright });
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      const t0 = performance.now();
      s().setPlaying(true);
      await new Promise((r) => setTimeout(r, 12_000));
      s().setPlaying(false);
      stop = true;

      // Distinct pictures and the gaps between them.
      const changes: { at: number; gap: number; timelineMs: number }[] = [];
      let prev = samples[0];
      let prevChangeAt = t0;
      for (const cur of samples) {
        if (cur.hash !== prev!.hash) {
          changes.push({ at: cur.t - t0, gap: cur.t - prevChangeAt, timelineMs: cur.time });
          prevChangeAt = cur.t;
        }
        prev = cur;
      }
      // Stretches where the canvas showed the backdrop rather than a picture.
      const dark: string[] = [];
      let runStart: { t: number; time: number } | null = null;
      for (const cur of samples) {
        if (cur.bright < 12) {
          runStart ??= { t: cur.t, time: cur.time };
        } else if (runStart) {
          dark.push(`${(cur.t - runStart.t).toFixed(0)} ms from t+${(runStart.t - t0).toFixed(0)} (timeline ${runStart.time.toFixed(0)} ms)`);
          runStart = null;
        }
      }
      const worst = [...changes].sort((a, b) => b.gap - a.gap).slice(0, 8);
      return {
        samples: samples.length,
        distinctPictures: changes.length,
        firstPictureAfterPlayMs: changes[0]?.at ?? null,
        blackStretches: dark,
        worstGaps: worst.map((c) => `${c.gap.toFixed(0)} ms at t+${c.at.toFixed(0)} (timeline ${c.timelineMs.toFixed(0)} ms)`),
      };
    },
    store,
  );
  console.log('\n' + JSON.stringify(report, null, 2));
});
