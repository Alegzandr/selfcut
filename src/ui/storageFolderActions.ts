import { t } from '../i18n';
import { useStore } from '../store/store';
import {
  flushProjectSave,
  moveLibraryToBrowser,
  moveLibraryToFolder,
  reconnectFolderAssets,
  type MoveProgress,
  type MoveResult,
} from '../lib/persistence';
import {
  activeStorageFolder,
  getStorageFolder,
  pickStorageFolder,
  requestStorageFolderAccess,
  setStorageFolder,
  setStorageFolderMoving,
} from '../lib/storageFolder';

/**
 * The storage-folder commands behind the Preferences pane and the access
 * banner: pick a folder and move the library in, move it back out, grant
 * access after a restart. The persistence layer does the moving; this decides
 * the order of operations and what the user is told.
 *
 * Every move ends in a page reload. The editor may be holding File objects
 * whose bytes just changed address (out of IndexedDB into the folder, or the
 * reverse, where the folder copy is deleted the moment it is back in the
 * database), and a fresh restore from the new records is the one state that
 * is known to be right.
 */

export type MoveProgressListener = (progress: MoveProgress | null) => void;

/**
 * Reload once the user has seen what did not move, if anything did not. The
 * dialog has a cancel button it cannot honour - the records are already
 * rewritten - so both answers restart; the message says so.
 */
async function restart(result: MoveResult): Promise<void> {
  if (result.failed > 0) {
    await useStore.getState().requestConfirm({
      title: t('preferences.data.location.moveFailed.title'),
      message: t('preferences.data.location.moveFailed', { count: result.failed }),
      confirmLabel: t('preferences.data.location.restart'),
    });
  }
  location.reload();
}

async function withMoving<T>(onProgress: MoveProgressListener, work: () => Promise<T>): Promise<T> {
  setStorageFolderMoving(true);
  try {
    // The debounced project save first: the reload at the end flushes it too,
    // but the transaction it starts would be racing the unload.
    flushProjectSave();
    return await work();
  } finally {
    setStorageFolderMoving(false);
    onProgress(null);
  }
}

/**
 * Pick a folder and move the library into it. Resolves false when the user
 * backed out of the picker; every other outcome ends in a reload.
 *
 * The folder is adopted even when some files could not be moved: the store
 * keeps both kinds of record side by side, so nothing is lost by it, and the
 * "still in the browser" note in Preferences offers to try again.
 */
export async function chooseStorageFolder(onProgress: MoveProgressListener): Promise<boolean> {
  // The previous folder's files come along, which needs it readable. Asked
  // before the picker: a permission prompt leaves the click's activation
  // intact, a picker consumes it, so the other order could not ask at all.
  const previous = await reachPreviousFolder();
  let handle: FileSystemDirectoryHandle | null;
  try {
    handle = await pickStorageFolder();
  } catch (err) {
    console.warn('[storageFolder] picker failed:', err);
    useStore.getState().setError(t('preferences.data.location.pickFailed'));
    return false;
  }
  if (!handle) return false;
  // Picking the folder already in use again is not a move: reading each copy
  // out of the folder and writing it back in would end by deleting it.
  const from = previous && !(await handle.isSameEntry(previous)) ? previous : null;
  const result = await withMoving(onProgress, async () => {
    const moved = await moveLibraryToFolder(handle, from, onProgress);
    await setStorageFolder(handle);
    return moved;
  });
  await restart(result);
  return true;
}

/**
 * Move the library back into the browser and forget the folder. Forgotten
 * even when a file could not be read out of it: a folder that has been
 * deleted from under the app must not be one the app can never leave. Such an
 * asset restores disconnected and is relinked like any other.
 */
export async function revertStorageFolder(onProgress: MoveProgressListener): Promise<void> {
  const readable = await reachPreviousFolder();
  const { handle } = getStorageFolder();
  if (!handle) return;
  const result = await withMoving(onProgress, async () => {
    const moved = readable
      ? await moveLibraryToBrowser(readable, onProgress)
      : { moved: 0, failed: 0 };
    await setStorageFolder(null);
    return moved;
  });
  await restart(result);
}

/**
 * The folder in use, readable, or null when there is none or the user will
 * not allow it. Asks when the session has not been allowed in yet, which is
 * the state every restart begins in.
 */
async function reachPreviousFolder(): Promise<FileSystemDirectoryHandle | null> {
  const { handle, access } = getStorageFolder();
  if (!handle) return null;
  const granted = access === 'granted' || (await requestStorageFolderAccess()) === 'granted';
  return granted ? handle : null;
}

/**
 * Move into the folder whatever the browser still holds: files imported while
 * access was pending, or left behind by an earlier move that partly failed.
 */
export async function moveBrowserFilesToFolder(onProgress: MoveProgressListener): Promise<void> {
  const dir = activeStorageFolder();
  if (!dir) return;
  const result = await withMoving(onProgress, () => moveLibraryToFolder(dir, null, onProgress));
  await restart(result);
}

/**
 * Ask for access to the stored folder (from a click: the prompt needs a user
 * gesture) and, once granted, open the assets the restore left waiting.
 */
export async function grantStorageFolderAccess(): Promise<void> {
  const access = await requestStorageFolderAccess();
  if (access !== 'granted') {
    useStore.getState().setError(t('storage.folder.denied'));
    return;
  }
  await reconnectFolderAssets();
}
