import { test, expect } from './test';

/**
 * The specs type-check under tsconfig.node.json, which carries no DOM lib, so
 * the browser globals below are cast inline. They cannot come from a helper:
 * page.evaluate serializes its callback and runs it in the page, where this
 * module's scope does not exist.
 */

/**
 * The COOP/COEP service worker, against a real build.
 *
 * It is skipped in dev, so this is the only place it ever runs. Two things have
 * to hold, and the second matters more than the first: the editor must become
 * crossOriginIsolated (which is the whole point), and it must keep working
 * (which is what a worker rewriting every response can quietly take away).
 */
test('the service worker isolates the editor without breaking it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  // First load: the document was created before any worker controlled the page,
  // so it cannot be isolated yet. This is the documented cost of not forcing a
  // reload on the user, and it is asserted so a future "fix" that reloads mid-
  // session has to be a deliberate choice.
  await page.goto('/app/');
  expect(await page.evaluate(() => (globalThis as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated)).toBe(false);

  // The worker registers in the background: wait for it to take control.
  await page.evaluate(() => (globalThis as unknown as { navigator: { serviceWorker: { ready: Promise<unknown> } } })
        .navigator.serviceWorker.ready.then(() => true));

  // Second navigation: now it serves the headers.
  await page.reload();
  expect(await page.evaluate(() => (globalThis as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated)).toBe(true);

  // Isolated is worthless if the app is broken. Same checks the dev smoke test
  // makes, because a worker rewriting every response is exactly how they stop
  // holding.
  await expect(page.locator('canvas').first()).toBeVisible();
  await expect(page.getByText('Drop your clips here', { exact: false })).toBeVisible();
  await expect(page.locator('input[type="file"]')).toBeAttached();
  expect(errors).toEqual([]);
});

/**
 * The threaded core has to be on the built site for an isolated page to have
 * anything to load. It is copied by a build plugin, not by rollup, so nothing
 * else would notice it going missing until a user asked for a transcode.
 */
test('the build serves both ffmpeg cores', async ({ request }) => {
  for (const path of [
    '/ffmpeg/ffmpeg-core.js',
    '/ffmpeg/ffmpeg-core.wasm',
    '/ffmpeg-mt/ffmpeg-core.js',
    '/ffmpeg-mt/ffmpeg-core.wasm',
    '/ffmpeg-mt/ffmpeg-core.worker.js',
  ]) {
    const resp = await request.get(path);
    expect(resp.status(), path).toBe(200);
  }
});
