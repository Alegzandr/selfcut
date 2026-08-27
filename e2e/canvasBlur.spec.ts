import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * Blurs blur, on an engine that has no `ctx.filter`.
 *
 * WebKit does not implement `filter` on a 2D canvas, and says nothing about it:
 * the assignment lands, the draw comes out sharp. Every blur in the compositor
 * used to be that one property, so on iOS - where every browser is WebKit - the
 * Blur slider did nothing, mask feathering was a hard edge, and a face the user
 * had asked to hide was rendered and exported in full view.
 *
 * The engine is emulated rather than described: `delete` the property before
 * the app loads and Chromium behaves like WebKit for this one feature, which is
 * the only way to keep a fix for a browser the suite cannot run honest. Both
 * engines are exercised, because a fallback that quietly replaced the native
 * path everywhere would be its own regression.
 */

const FIXTURE_PNG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'checker.png');
const STORE_MODULE = '/src/store/store.ts';

interface EditorStore {
  useStore: {
    getState: () => {
      currentTimeMs: number;
      project: { tracks: { clips: { id: string }[] }[] };
      updateClipColorLive: (clipId: string, prop: string, value: number, timelineMs: number) => void;
      addClipRedaction: (clipId: string, redaction: unknown) => string;
    };
  };
}

/**
 * Mean difference between horizontally neighbouring pixels over a fraction of
 * the preview, which is what "is it blurred" comes down to on a checkerboard:
 * high while the squares have edges, near zero once they do not.
 */
function edgeEnergy(page: Page, box: { x: number; y: number; w: number; h: number }): Promise<number> {
  return page.evaluate((area) => {
    const canvas = [...document.querySelectorAll('canvas')].sort(
      (a, b) => b.width * b.height - a.width * a.height,
    )[0]!;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(
      Math.round(area.x * canvas.width),
      Math.round(area.y * canvas.height),
      Math.round(area.w * canvas.width),
      Math.round(area.h * canvas.height),
    );
    let total = 0;
    let n = 0;
    for (let y = 0; y < data.height; y++) {
      for (let x = 1; x < data.width; x++) {
        const i = (y * data.width + x) * 4;
        total += Math.abs(data.data[i]! - data.data[i - 4]!);
        n++;
      }
    }
    return n ? total / n : 0;
  }, box);
}

const WHOLE_FRAME = { x: 0, y: 0, w: 1, h: 1 };
/** Inside the redaction region placed below, and clear of its edges. */
const INSIDE_REGION = { x: 0.42, y: 0.42, w: 0.16, h: 0.16 };

/** Open the editor with the checkerboard on the timeline. */
async function editorWithChecker(page: Page, nativeFilter: boolean): Promise<void> {
  if (!nativeFilter) {
    await page.addInitScript(() => {
      for (const proto of [
        globalThis.CanvasRenderingContext2D?.prototype,
        globalThis.OffscreenCanvasRenderingContext2D?.prototype,
      ]) {
        if (proto) delete (proto as { filter?: unknown }).filter;
      }
    });
  }
  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', FIXTURE_PNG);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
  await expect.poll(() => edgeEnergy(page, WHOLE_FRAME)).toBeGreaterThan(2);
}

for (const nativeFilter of [true, false]) {
  const engine = nativeFilter ? 'with the native canvas filter' : 'on an engine without ctx.filter';

  test(`the blur slider blurs the picture ${engine}`, async ({ page }) => {
    await editorWithChecker(page, nativeFilter);

    await page.evaluate(async (mod) => {
      const { useStore } = (await import(mod)) as unknown as EditorStore;
      const state = useStore.getState();
      const clip = state.project.tracks.flatMap((t) => t.clips)[0]!;
      state.updateClipColorLive(clip.id, 'blur', 1, state.currentTimeMs);
    }, await appModuleUrl(page, STORE_MODULE));

    await expect
      .poll(() => edgeEnergy(page, WHOLE_FRAME), { message: 'the frame never blurred' })
      .toBeLessThan(1);
  });

  test(`a blur redaction hides what it covers ${engine}`, async ({ page }) => {
    await editorWithChecker(page, nativeFilter);
    expect(await edgeEnergy(page, INSIDE_REGION)).toBeGreaterThan(2);

    await page.evaluate(async (mod) => {
      const { useStore } = (await import(mod)) as unknown as EditorStore;
      const state = useStore.getState();
      const clip = state.project.tracks.flatMap((t) => t.clips)[0]!;
      state.addClipRedaction(clip.id, {
        id: 'blur-region',
        mode: 'blur',
        shape: 'rect',
        x: 0.5,
        y: 0.5,
        w: 0.3,
        h: 0.3,
        feather: 0,
        amount: 0.8,
      });
    }, await appModuleUrl(page, STORE_MODULE));

    await expect
      .poll(() => edgeEnergy(page, INSIDE_REGION), { message: 'the redacted region is still legible' })
      .toBeLessThan(1);
  });
}
