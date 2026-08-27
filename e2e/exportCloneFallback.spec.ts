import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * An export that the browser refuses to hand to its worker.
 *
 * Everything the render needs crosses a worker boundary in one message, and
 * what a browser will put through that boundary is not the same everywhere:
 * the same request that copies in Chromium can be refused outright by WebKit,
 * which reports it as "The object can not be cloned." and names nothing. The
 * render never starts, and no fallback in the encoder path helps, because
 * nothing about the encoder is wrong.
 *
 * So a refusal is treated as terms to soften rather than as a crash: the file
 * handle the worker would have streamed into is dropped and the output is
 * buffered instead. That is the fallback proved here, on an engine taught to
 * refuse exactly what WebKit has no serializer for - and with it, the path that
 * turns the browser's unattributed sentence into the name of the value it
 * choked on.
 */

const FIXTURE_PNG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'checker.png');

interface Sent {
  hasHandle: boolean;
}

/**
 * Load the editor in a browser that has no save picker (as Safari) and that
 * refuses any message carrying a file-system handle (as WebKit does with the
 * values it cannot serialize), with every export request it is handed recorded.
 */
async function editorRefusingHandles(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as { sentExports: Sent[]; showSaveFilePicker?: unknown };
    win.sentExports = [];
    // Safari has no File System Access picker, so the export reaches for the
    // OPFS scratch handle instead - the value under test.
    delete win.showSaveFilePicker;

    const carriesHandle = (value: unknown, depth = 0): boolean => {
      if (!value || typeof value !== 'object') return false;
      if (typeof (value as { createWritable?: unknown }).createWritable === 'function') return true;
      if (depth > 3) return false;
      return Object.values(value).some((inner) => carriesHandle(inner, depth + 1));
    };
    const refuse = () => new DOMException('The object can not be cloned.', 'DataCloneError');

    // Both doors: the worker's, which is what fails the export, and the port's,
    // which is what the diagnostic walk asks to find out where.
    const portPost = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message: unknown, ...rest: unknown[]) {
      if (carriesHandle(message)) throw refuse();
      return (portPost as (...a: unknown[]) => void).call(this, message, ...rest);
    };
    const workerPost = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message: unknown, ...rest: unknown[]) {
      const request = message as { type?: string; fileHandle?: unknown } | null;
      if (request?.type === 'export') {
        (window as unknown as { sentExports: Sent[] }).sentExports.push({
          hasHandle: !!request.fileHandle,
        });
      }
      if (carriesHandle(message)) throw refuse();
      return (workerPost as (...a: unknown[]) => void).call(this, message, ...rest);
    };
  });

  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', FIXTURE_PNG);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
}

/** Start a render and hand back its cancel, without waiting for any of it. */
async function startExport(page: Page): Promise<void> {
  const exporter = await appModuleUrl(page, '/src/export/exporter.ts');
  const store = await appModuleUrl(page, '/src/store/store.ts');
  const presets = await appModuleUrl(page, '/src/export/presets.ts');
  await page.evaluate(
    async ([exporterUrl, storeUrl, presetsUrl]) => {
      const { startExport: start } = (await import(exporterUrl!)) as {
        startExport: (...a: unknown[]) => { cancel: () => void; promise: Promise<unknown> };
      };
      const { useStore } = (await import(storeUrl!)) as {
        useStore: { getState: () => { project: unknown; assets: unknown } };
      };
      const { PRESETS } = (await import(presetsUrl!)) as {
        PRESETS: { kind: string; aspect?: string; height?: number }[];
      };
      const preset =
        PRESETS.find((p) => p.kind === 'mp4' && p.aspect === '16:9' && p.height === 720) ?? PRESETS[0];
      const state = useStore.getState();
      const handle = start(state.project, state.assets, preset, () => undefined);
      // Nothing here waits for pixels: the encoder is not what is under test,
      // and on a machine without an H.264 encoder it would fail either way.
      handle.promise.catch(() => undefined);
      (window as unknown as { cancelExport: () => void }).cancelExport = handle.cancel;
    },
    [exporter, store, presets],
  );
}

const sentExports = (page: Page) =>
  page.evaluate(() => (window as unknown as { sentExports: Sent[] }).sentExports);

test('a refused request is retried without the file handle it could not copy', async ({ page }) => {
  await editorRefusingHandles(page);
  await startExport(page);

  await expect
    .poll(() => sentExports(page), { message: 'the export never retried after the refusal' })
    .toHaveLength(2);
  const [first, second] = await sentExports(page);
  // The first asks the browser to copy a handle, which this one will not do.
  expect(first!.hasHandle).toBe(true);
  // The second drops it and buffers the output instead, which is the whole
  // point: a render that runs beats a render that streams.
  expect(second!.hasHandle).toBe(false);

  await page.evaluate(() => (window as unknown as { cancelExport: () => void }).cancelExport());
});

test('the refusal is reported as the value the browser choked on', async ({ page }) => {
  const logged: string[] = [];
  page.on('console', (message) => logged.push(message.text()));

  await editorRefusingHandles(page);
  await startExport(page);
  await expect.poll(() => sentExports(page)).toHaveLength(2);

  // "The object can not be cloned." names nothing; this names the field, which
  // is the difference between a bug report and a shrug.
  expect(
    logged.filter((line) => line.includes('[export]') && line.includes('fileHandle')),
    `no line named the refused value; saw: ${logged.filter((l) => l.includes('[export]')).join(' | ')}`,
  ).not.toHaveLength(0);

  await page.evaluate(() => (window as unknown as { cancelExport: () => void }).cancelExport());
});
