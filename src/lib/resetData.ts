import { selfcutStorageKeys } from '../store/constants';
import { closeDb, DB_NAME } from './idb';
import { CAPTION_CACHE_NAME } from '../media/captionsCache';
import { deleteFolderLibrary, suspendPersistence } from './persistence';

/**
 * Hand everything Selfcut has stored back to the user.
 *
 * The app keeps four separate piles, and a "delete my data" button that emptied
 * three of them would be worse than none at all - the user believes they are
 * clean and they are not:
 *
 *  - IndexedDB `selfcut`: the projects themselves, the media library records,
 *    and the reconstructible audio/subtitle caches.
 *  - localStorage, everything under `selfcut.`: the preferences and the id of
 *    the project to reopen.
 *  - OPFS `exports/`: the scratch file of the last export, which is a whole
 *    video and can be gigabytes.
 *  - The storage folder, when one was chosen: the media copies the library
 *    keeps there, and only those - the folder itself and anything else in it
 *    are the user's. Needs the folder to be reachable in this session; a copy
 *    in a folder the app cannot open right now stays, and its record goes with
 *    the database, so the erase says what it can and cannot do only through
 *    the folder's own contents.
 *  - Cache Storage `transformers-cache`: the downloaded Whisper models. These
 *    are the one pile worth keeping on purpose, hence `keepModels` - they hold
 *    nothing personal, they are the slowest thing here to get back (up to a
 *    gigabyte over the network), and someone clearing out a finished project
 *    rarely means "and make me re-download the transcriber too".
 *
 * What this deliberately does NOT touch: the files the user imported from. The
 * library keeps its own copies (in the browser or in the storage folder), so a
 * cleared library leaves every original exactly where it was. The COOP service
 * worker stays registered as well - it is
 * what makes the page cross-origin isolated, and removing it would break
 * multithreaded decoding on the reload rather than free anything.
 *
 * The caller reloads afterwards. Persistence is suspended first so the writers
 * still in flight (a debounced save, the `pagehide` flush) cannot recreate the
 * database between the delete and the reload.
 */
export interface EraseOptions {
  /** Leave the downloaded caption models on disk. */
  keepModels: boolean;
}

function clearLocalStorage(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null) keys.push(k);
    }
    // Collected first, removed after: removing during the walk shifts every
    // later index down and silently skips every other key.
    for (const k of selfcutStorageKeys(keys)) localStorage.removeItem(k);
  } catch {
    /* private mode - there was nothing persisted to begin with */
  }
}

/**
 * Delete the database, giving up rather than hanging if another tab holds it.
 *
 * `deleteDatabase` blocks while any connection is open, and a second Selfcut tab
 * is a connection this page cannot close. The request stays queued in that case
 * and completes when the other tab goes away, so the honest answer is to resolve
 * and let the caller report it rather than to wait forever behind a spinner.
 */
function deleteDatabase(name: string): Promise<{ blocked: boolean }> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.deleteDatabase(name);
    } catch {
      resolve({ blocked: false });
      return;
    }
    req.onsuccess = () => resolve({ blocked: false });
    req.onerror = () => resolve({ blocked: false });
    req.onblocked = () => resolve({ blocked: true });
  });
}

export interface EraseResult {
  /** Another tab still has the database open, so the delete is only queued. */
  blocked: boolean;
}

/**
 * Every IndexedDB database on the origin, not just the one this code opens.
 *
 * The erase used to delete `selfcut` by name and stop, and an erase that left
 * gigabytes behind is what showed the gap: whatever else a library, an older
 * build or a browser quirk has put here is the user's to reclaim with one
 * button, and enumerating is how nothing is missed. `databases()` is absent
 * in some browsers, where the named delete is the best that can be done.
 */
async function deleteAllDatabases(): Promise<{ blocked: boolean }> {
  let names = [DB_NAME];
  try {
    const listed = await indexedDB.databases?.();
    if (listed) names = [...new Set([DB_NAME, ...listed.map((d) => d.name).filter((n): n is string => !!n)])];
  } catch {
    /* enumeration unsupported - the named delete still runs */
  }
  let blocked = false;
  for (const name of names) blocked = (await deleteDatabase(name)).blocked || blocked;
  return { blocked };
}

/**
 * Empty the origin's private file system entirely, `exports/` included. Only
 * SelfCut writes there and only its scratch files live there, so the whole
 * tree is the app's to clear.
 */
async function clearPrivateFileSystem(): Promise<void> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    if (!root) return;
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    for (const name of names) await root.removeEntry(name, { recursive: true }).catch(() => undefined);
  } catch {
    /* no OPFS, or nothing there to remove */
  }
}

/**
 * Every Cache Storage bucket, or every one but the model bucket when the
 * models are to be kept. transformers.js keeps a second, small bucket of
 * file hashes beside the weights; it goes with the models either way.
 */
async function clearCaches(keepModels: boolean): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    for (const name of await caches.keys()) {
      if (keepModels && (name === CAPTION_CACHE_NAME || name.includes('transformers'))) continue;
      await caches.delete(name).catch(() => undefined);
    }
  } catch {
    /* storage denied - nothing was cached in the first place */
  }
}

/** Erase the stored data. The caller reloads the page once this resolves. */
export async function eraseSelfcutData({ keepModels }: EraseOptions): Promise<EraseResult> {
  suspendPersistence();
  clearLocalStorage();
  // Before the database goes: the records are what say which files are ours.
  await deleteFolderLibrary();
  await closeDb();
  const { blocked } = await deleteAllDatabases();
  await clearPrivateFileSystem();
  await clearCaches(keepModels);
  return { blocked };
}
