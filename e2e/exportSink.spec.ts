import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appModuleUrl } from './appModule';

/**
 * Where an export's bytes go, on an engine that will not take a file handle.
 *
 * Everything the render needs crosses into the worker in one message, and what
 * a browser carries across that boundary is not the same everywhere. WebKit
 * refuses to serialize a `FileSystemFileHandle` at all: the whole message comes
 * back "The object can not be cloned." and the export dies before a frame is
 * drawn. It also implements no `FileSystemWritableFileStream`, so a handle that
 * did arrive would have nothing to write through. Both are why exporting from
 * any iOS browser failed - they are all WebKit.
 *
 * So the scratch file travels as a NAME, which every engine copies, and the
 * worker opens it itself through the synchronous handle that WebKit does have
 * (worker-only, which is where this runs). The retry that drops parts of a
 * refused request stays underneath as the net for whatever is refused next.
 *
 * Exercised on an audio export: it runs the same sink code as video and needs
 * no video encoder, so it proves the bytes on any machine.
 */

const FIXTURE_WAV = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tone.wav');

interface SentRequest {
  sink: string | null;
  carriesHandle: boolean;
}

/** Refuse to copy a file-system handle, as WebKit does, and record what is sent. */
const REFUSE_HANDLES = () => {
  const win = window as unknown as { sentRequests: SentRequest[] };
  win.sentRequests = [];
  // `createSyncAccessHandle` is worker-only, so it is not what identifies a
  // handle on this thread - the class is.
  const carries = (value: unknown, depth = 0): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (value instanceof FileSystemHandle) return true;
    if (depth > 3) return false;
    return Object.values(value).some((inner) => carries(inner, depth + 1));
  };
  const refuse = () => new DOMException('The object can not be cloned.', 'DataCloneError');
  const portPost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message: unknown, ...rest: unknown[]) {
    if (carries(message)) throw refuse();
    return (portPost as (...a: unknown[]) => void).call(this, message, ...rest);
  };
  const workerPost = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (message: unknown, ...rest: unknown[]) {
    const request = message as { type?: string; sink?: { kind: string } } | null;
    if (request?.type === 'export') {
      win.sentRequests.push({ sink: request.sink?.kind ?? null, carriesHandle: carries(message) });
    }
    if (carries(message)) throw refuse();
    return (workerPost as (...a: unknown[]) => void).call(this, message, ...rest);
  };
};

async function editorWithTone(page: Page): Promise<void> {
  await page.goto('/app/');
  await page.setInputFiles('input[type="file"]', FIXTURE_WAV);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
}

/** Render the project to mp3 and hand back the first bytes of the result. */
async function exportMp3(page: Page): Promise<{ bytes: number; head: number[] }> {
  const exporter = await appModuleUrl(page, '/src/export/exporter.ts');
  const store = await appModuleUrl(page, '/src/store/store.ts');
  const presets = await appModuleUrl(page, '/src/export/presets.ts');
  return page.evaluate(
    async ([exporterUrl, storeUrl, presetsUrl]) => {
      const { startExport } = (await import(exporterUrl!)) as {
        startExport: (...a: unknown[]) => { promise: Promise<{ blob: Blob | null }> };
      };
      const { useStore } = (await import(storeUrl!)) as {
        useStore: { getState: () => { project: unknown; assets: unknown } };
      };
      const { PRESETS } = (await import(presetsUrl!)) as { PRESETS: { kind: string }[] };
      const state = useStore.getState();
      const preset = PRESETS.find((p) => p.kind === 'mp3');
      const { blob } = await startExport(
        state.project,
        state.assets,
        preset,
        () => undefined,
      ).promise;
      if (!blob) return { bytes: 0, head: [] };
      return { bytes: blob.size, head: [...new Uint8Array(await blob.slice(0, 2).arrayBuffer())] };
    },
    [exporter, store, presets],
  );
}

const sentRequests = (page: Page) =>
  page.evaluate(() => (window as unknown as { sentRequests: SentRequest[] }).sentRequests);

/** An mp3 frame starts 0xFF 0xFx: proof the bytes are the render's, not an empty file. */
function expectMp3({ bytes, head }: { bytes: number; head: number[] }) {
  expect(bytes, 'the export produced no bytes').toBeGreaterThan(1000);
  expect(head[0]).toBe(0xff);
  expect(head[1]! & 0xe0).toBe(0xe0);
}

test('the scratch file travels as a name, so nothing has to be cloned', async ({ page }) => {
  await page.addInitScript(() => {
    // Safari has no save picker, so the export reaches for the scratch file.
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.addInitScript(REFUSE_HANDLES);
  await editorWithTone(page);

  expectMp3(await exportMp3(page));

  const sent = await sentRequests(page);
  // One request, accepted first time. Two would mean it was refused and retried,
  // which is the fallback working rather than the request being right.
  expect(sent).toHaveLength(1);
  expect(sent[0]!.sink).toBe('scratch');
  expect(sent[0]!.carriesHandle, 'the request must carry no handle at all').toBe(false);
});

test('a request that is still refused falls back to a buffered render', async ({ page }) => {
  await page.addInitScript(() => {
    // A picked file DOES travel as a handle - only Chromium has that picker, and
    // it copies handles. Stubbed here to put one in the request on purpose, so
    // the net underneath is exercised rather than assumed.
    (window as unknown as { showSaveFilePicker: () => Promise<FileSystemFileHandle> }).showSaveFilePicker =
      async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('picked-export', { create: true });
        return dir.getFileHandle('out.mp3', { create: true });
      };
  });
  await page.addInitScript(REFUSE_HANDLES);
  await editorWithTone(page);

  expectMp3(await exportMp3(page));

  const sent = await sentRequests(page);
  expect(sent).toHaveLength(2);
  expect(sent[0]!.carriesHandle, 'the first attempt is the one that gets refused').toBe(true);
  // Dropped, and the output built in memory instead: slower and hungrier, and
  // it finishes, which is the whole point of a fallback.
  expect(sent[1]!.sink).toBeNull();
});
