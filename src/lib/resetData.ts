import { selfcutStorageKeys } from '../store/constants';
import { closeDb, DB_NAME } from './idb';
import { removeExportScratch } from './opfs';
import { suspendPersistence } from './persistence';
import { deleteCaptionCache } from '../media/captionsCache';

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
 *  - Cache Storage `transformers-cache`: the downloaded Whisper models. These
 *    are the one pile worth keeping on purpose, hence `keepModels` - they hold
 *    nothing personal, they are the slowest thing here to get back (up to a
 *    gigabyte over the network), and someone clearing out a finished project
 *    rarely means "and make me re-download the transcriber too".
 *
 * What this deliberately does NOT touch: the source files on the user's disk.
 * Media is referenced, never copied, so a cleared library leaves every original
 * exactly where it was. The COOP service worker stays registered as well - it is
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

/** Erase the stored data. The caller reloads the page once this resolves. */
export async function eraseSelfcutData({ keepModels }: EraseOptions): Promise<EraseResult> {
  suspendPersistence();
  clearLocalStorage();
  await closeDb();
  const { blocked } = await deleteDatabase(DB_NAME);
  await removeExportScratch();
  if (!keepModels) await deleteCaptionCache();
  return { blocked };
}
