import { test, expect, type Page } from './test';
import { makeWav } from './wav';
import { appModuleUrl } from './appModule';

/**
 * An audio fixture rather than the video clip: what is under test is where the
 * bytes go and whether they come back, and a decoder is not part of that. The
 * name is what the copy in the folder is derived from.
 */
const FIXTURE = { name: 'long-take.wav', mimeType: 'audio/wav', buffer: makeWav({ seconds: 5 }) };

/**
 * The storage-folder preference, end to end: a library moved out of the
 * browser into a folder, restored from there after a reload, and moved back.
 *
 * The OS directory picker cannot be driven from a test, so it is replaced with
 * a directory in the origin's private file system. That is a genuine
 * `FileSystemDirectoryHandle` - same `createWritable`, same `removeEntry`, same
 * structured clone into IndexedDB - so everything past the picker is the real
 * code path, and what is checked is what the user would see in Explorer: the
 * file appears in the folder, the database keeps only a reference, and the
 * project reopens on it.
 */

const FOLDER = 'selfcut-e2e-storage';

async function stubDirectoryPicker(page: Page): Promise<void> {
  await page.addInitScript((name) => {
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
      async () => (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
  }, FOLDER);
}

/** What the database holds for each library file: 'file', 'ref', or something else. */
async function fileRecordKinds(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const req = indexedDB.open('selfcut');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const d = req.result;
          const get = d.transaction('assetFiles', 'readonly').objectStore('assetFiles').getAll();
          get.onerror = () => reject(get.error);
          get.onsuccess = () => {
            d.close();
            resolve(
              (get.result as unknown[]).map((v) =>
                v instanceof File
                  ? 'file'
                  : typeof v === 'object' && v !== null && (v as { folder?: unknown }).folder === true
                    ? 'ref'
                    : typeof v,
              ),
            );
          };
        };
      }),
  );
}

/** The names of the files in the stand-in folder. */
async function folderContents(page: Page): Promise<string[]> {
  return page.evaluate(async (name) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
    const names: string[] = [];
    for await (const key of (dir as unknown as { keys: () => AsyncIterable<string> }).keys()) names.push(key);
    return names.sort();
  }, FOLDER);
}

async function openDataPreferences(page: Page): Promise<void> {
  const store = await appModuleUrl(page, '/src/store/store.ts');
  await page.evaluate(async (url) => {
    const { useStore } = await import(url);
    useStore.getState().setPreferencesOpen(true);
  }, store);
  await page.getByRole('tab', { name: 'Data' }).click();
}

/** The library as the app sees it: every asset, with whether it can be read. */
async function libraryState(page: Page): Promise<{ name: string; disconnected: boolean }[]> {
  const store = await appModuleUrl(page, '/src/store/store.ts');
  return page.evaluate(async (url) => {
    const { useStore } = await import(url);
    const assets = useStore.getState().assets as Record<string, { file: File; disconnected?: boolean }>;
    return Object.values(assets).map((a) => ({ name: a.file.name, disconnected: !!a.disconnected }));
  }, store);
}

test('the library moves into a chosen folder, reopens from it, and moves back', async ({ page }) => {
  await stubDirectoryPicker(page);
  await page.goto('/app/');
  // A clean slate: the stand-in folder is per origin and would otherwise carry
  // a previous run's copies.
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name, { recursive: true }).catch(() => undefined);
  }, FOLDER);

  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
  // The import's file has to be on disk before it can be moved anywhere.
  await expect.poll(() => fileRecordKinds(page)).toEqual(['file']);

  // Into the folder. The move ends in a reload, which is the load event.
  await openDataPreferences(page);
  await expect(page.getByText('This browser', { exact: true })).toBeVisible();
  const reloadedIn = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Choose a folder…' }).click();
  await reloadedIn;

  // The copy is in the folder under a recognisable name, the database only
  // points at it, and the project came back whole from that reference.
  await expect.poll(() => folderContents(page)).toEqual([expect.stringMatching(/^long-take \[asset_[0-9a-z]+\]\.wav$/)]);
  expect(await fileRecordKinds(page)).toEqual(['ref']);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
  await expect.poll(() => libraryState(page)).toEqual([{ name: 'long-take.wav', disconnected: false }]);
  // No access banner: the stand-in folder is granted outright, as a real one
  // is after "allow on every visit".
  await expect(page.getByRole('button', { name: 'Allow access' })).toHaveCount(0);

  // And out again: the folder is left empty, the File is back in the database,
  // and the project still reopens.
  await openDataPreferences(page);
  await expect(page.getByText(FOLDER)).toBeVisible();
  const reloadedOut = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Back to the browser' }).click();
  await reloadedOut;

  await expect.poll(() => fileRecordKinds(page)).toEqual(['file']);
  expect(await folderContents(page)).toEqual([]);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
  await expect.poll(() => libraryState(page)).toEqual([{ name: 'long-take.wav', disconnected: false }]);
  await openDataPreferences(page);
  await expect(page.getByText('This browser', { exact: true })).toBeVisible();
});

test('a file imported with the folder in use goes straight to the folder, and its removal is undoable', async ({
  page,
}) => {
  await stubDirectoryPicker(page);
  await page.goto('/app/');
  await page.evaluate(async (name) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name, { recursive: true }).catch(() => undefined);
  }, FOLDER);

  // Choose the folder on an empty library, then import.
  await openDataPreferences(page);
  const reloaded = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Choose a folder…' }).click();
  await reloaded;

  await page.setInputFiles('input[type="file"]', FIXTURE);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
  await expect.poll(() => fileRecordKinds(page)).toEqual(['ref']);
  await expect.poll(() => folderContents(page)).toHaveLength(1);

  // Remove the asset, then undo. The copy must survive the removal: a File
  // read out of the folder has no bytes of its own once the copy is gone, and
  // the undo would bring back a card with nothing behind it.
  const store = await appModuleUrl(page, '/src/store/store.ts');
  await page.evaluate(async (url) => {
    const { useStore } = await import(url);
    const s = useStore.getState();
    s.removeAsset(Object.keys(s.assets)[0]);
  }, store);
  await expect(page.locator('[data-clip-id]')).toHaveCount(0);
  await expect.poll(() => folderContents(page)).toHaveLength(1);
  await page.evaluate(async (url) => {
    const { useStore } = await import(url);
    useStore.getState().undo();
  }, store);
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
  await expect.poll(() => libraryState(page)).toEqual([{ name: 'long-take.wav', disconnected: false }]);

  // Across a reload the asset is still there and still readable.
  await page.reload();
  await expect(page.locator('[data-clip-id]')).toHaveCount(1);
  await expect.poll(() => libraryState(page)).toEqual([{ name: 'long-take.wav', disconnected: false }]);
  expect(await fileRecordKinds(page)).toEqual(['ref']);
});
