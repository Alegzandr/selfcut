import { SETTINGS_STORE, db, requestDone, txDone } from './idb';

/**
 * The folder the user chose to hold the media library, instead of the browser.
 *
 * A File put into IndexedDB is copied into the browser profile, which sits on
 * the system drive: every import of a 2 GB recording is another 2 GB on C:,
 * with no way to point the browser elsewhere. The File System Access API is
 * the one door out. The user picks a directory once (`showDirectoryPicker`),
 * the handle is kept in IndexedDB, and from then on imported media is copied
 * into that directory and the database only records where.
 *
 * This module owns the handle, its permission state and the raw directory
 * I/O; what goes in the folder and when is persistence.ts's business.
 *
 * Chromium-only (Chrome, Edge, Brave, Opera on desktop): Firefox and Safari
 * have no directory picker, and there the preference simply does not exist.
 * The other thing that does not travel is the permission: a handle read back
 * from IndexedDB starts each session in the `prompt` state, and only a user
 * gesture can ask again. Startup therefore restores the project with its
 * folder-backed assets disconnected, and a banner carries the button that
 * grants access and reconnects them.
 */

const SETTINGS_KEY = 'storageFolder';

/**
 * What FILES_STORE holds for an asset whose bytes live in the folder, in place
 * of the File itself. `name`, `type`, `lastModified` and `size` are the
 * original File's, so the restored File keeps the identity everything else is
 * keyed on: the relink banner matches on the name, the caches on
 * size + mtime + name (see lib/mediaKey.ts). `path` is the file's name inside
 * the folder, which is not the original name (two projects can each hold an
 * `interview.mp4`).
 */
export interface FolderFileRef {
  folder: true;
  path: string;
  name: string;
  type: string;
  lastModified: number;
  size: number;
}

export function isFolderFileRef(value: unknown): value is FolderFileRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as FolderFileRef;
  return (
    ref.folder === true &&
    typeof ref.path === 'string' &&
    typeof ref.name === 'string' &&
    typeof ref.type === 'string' &&
    typeof ref.lastModified === 'number' &&
    typeof ref.size === 'number'
  );
}

/**
 * The on-disk name for an asset's file: the original name with the asset id
 * folded in before the extension, `interview [asset_3f2a1b2c].mp4`.
 *
 * Unique per asset without hiding the file behind an opaque id: someone who
 * opens the folder in Explorer should recognise their footage. The whole id
 * goes in, not a prefix of it - ids are `asset_` plus eight random characters
 * (lib/id.ts), and the first eight of THAT are the same for every asset.
 * Deterministic on purpose, so a relink under the same name overwrites the
 * previous copy rather than leaving it behind. Exported for its test.
 */
export function folderFileName(originalName: string, assetId: string): string {
  const tag = assetId.replace(/[^A-Za-z0-9_-]/g, '') || 'asset';
  // Windows will not take these in a file name, and the original could have
  // come from anywhere (a relinked file from another OS, a drag from a browser).
  const clean = originalName.replace(/[\\/:*?"<>|]/g, '_').trim() || 'media';
  const dot = clean.lastIndexOf('.');
  // A leading dot is a hidden file's name, not an extension.
  if (dot <= 0) return `${clean} [${tag}]`;
  return `${clean.slice(0, dot)} [${tag}]${clean.slice(dot)}`;
}

/** Not in the DOM typings: File System Access extensions on the handle. */
type PermissionedDirectory = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
};

interface DirectoryPickerWindow {
  showDirectoryPicker?: (options: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}

export type FolderAccess = 'granted' | 'prompt' | 'denied';

export interface StorageFolderState {
  /** The chosen folder, or null while media lives in the browser. */
  handle: FileSystemDirectoryHandle | null;
  /** The folder's own name, for the UI. Null with no folder. */
  name: string | null;
  /** Whether this session may read and write it. Meaningless with no folder. */
  access: FolderAccess;
  /**
   * True while the library is being moved between the browser and the folder.
   * Writes fall back to the browser during a move, so a file imported mid-way
   * never lands in a folder the app is about to stop using.
   */
  moving: boolean;
}

let state: StorageFolderState = { handle: null, name: null, access: 'prompt', moving: false };
const listeners = new Set<() => void>();

/** Shaped for `useSyncExternalStore`: the snapshot only changes identity on a change. */
export function getStorageFolder(): StorageFolderState {
  return state;
}

export function subscribeStorageFolder(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function commit(next: Partial<StorageFolderState>): void {
  state = { ...state, ...next };
  for (const fn of [...listeners]) fn();
}

/** True where the browser can offer a folder at all. */
export function storageFolderSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

/**
 * The folder every media write should go to right now, or null for the
 * browser. Null also while access is pending: a File that cannot reach the
 * folder is better off in the browser than lost, and the Preferences pane
 * offers to move it over once access is back.
 */
export function activeStorageFolder(): FileSystemDirectoryHandle | null {
  return state.handle && state.access === 'granted' && !state.moving ? state.handle : null;
}

async function queryAccess(handle: FileSystemDirectoryHandle): Promise<FolderAccess> {
  const query = (handle as PermissionedDirectory).queryPermission;
  if (!query) return 'granted';
  try {
    return await query.call(handle, { mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/**
 * Read the stored handle and find out what this session may do with it. Runs
 * once at startup, before the project is restored, so the restore knows
 * whether a folder-backed asset can be opened or has to wait for the banner.
 */
export async function loadStorageFolder(): Promise<StorageFolderState> {
  try {
    const d = await db();
    const stored = await requestDone(
      d.transaction(SETTINGS_STORE, 'readonly').objectStore(SETTINGS_STORE).get(SETTINGS_KEY),
    );
    if (
      typeof FileSystemDirectoryHandle !== 'undefined' &&
      stored instanceof FileSystemDirectoryHandle
    ) {
      commit({ handle: stored, name: stored.name, access: await queryAccess(stored) });
    }
  } catch (err) {
    console.warn('[storageFolder] handle could not be read:', err);
  }
  return state;
}

/**
 * Ask for read-write access to the stored folder. Needs a user gesture (a
 * click on the banner); calling it from startup code returns `prompt` without
 * showing anything.
 */
export async function requestStorageFolderAccess(): Promise<FolderAccess> {
  const handle = state.handle;
  if (!handle) return 'denied';
  const request = (handle as PermissionedDirectory).requestPermission;
  let access: FolderAccess = 'granted';
  if (request) {
    try {
      access = await request.call(handle, { mode: 'readwrite' });
    } catch {
      access = 'denied';
    }
  }
  commit({ access });
  return access;
}

/**
 * Open the OS directory picker. Resolves null when the user backs out. The
 * handle is NOT adopted here: adopting means moving the library, which the
 * caller (ui/storageFolderActions.ts) runs with progress before committing.
 */
export async function pickStorageFolder(): Promise<FileSystemDirectoryHandle | null> {
  const show = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!show) return null;
  try {
    // `readwrite` asks for both permissions in one prompt instead of a second
    // prompt on the first write; `id` makes the dialog reopen where it was.
    return await show({ id: 'selfcut-storage', mode: 'readwrite', startIn: 'videos' });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

/** Record `handle` as the storage folder, or forget the folder with null. */
export async function setStorageFolder(handle: FileSystemDirectoryHandle | null): Promise<void> {
  const d = await db();
  const tx = d.transaction(SETTINGS_STORE, 'readwrite');
  if (handle) tx.objectStore(SETTINGS_STORE).put(handle, SETTINGS_KEY);
  else tx.objectStore(SETTINGS_STORE).delete(SETTINGS_KEY);
  await txDone(tx);
  commit(
    handle
      ? { handle, name: handle.name, access: await queryAccess(handle) }
      : { handle: null, name: null, access: 'prompt' },
  );
}

export function setStorageFolderMoving(moving: boolean): void {
  if (state.moving !== moving) commit({ moving });
}

/**
 * Files handed out by `readFolderFile`, so a write can tell "this File already
 * IS the folder's copy" from "this File has to be copied in". Without it, the
 * File the restore produced would be copied over itself on its first metadata
 * write - a 2 GB read and write to change nothing.
 */
const folderFiles = new WeakMap<File, FolderFileRef>();

/** The folder record a File was restored from, if it was. */
export function folderRefOf(file: File): FolderFileRef | undefined {
  return folderFiles.get(file);
}

/**
 * Copy `file` into `dir` under the asset's own name and describe where it went.
 *
 * Streamed, never buffered: the files this exists for are the ones that do not
 * fit in memory. A failed write is cleaned up so a full disk does not leave a
 * truncated file that the next start would take for the real thing.
 */
export async function writeFolderFile(
  dir: FileSystemDirectoryHandle,
  file: File,
  assetId: string,
): Promise<FolderFileRef> {
  const path = folderFileName(file.name, assetId);
  // A relink under the same name lands on the same path: the copy already
  // there is the one the record still points at until this write commits, so
  // a failure must leave it alone rather than tidy it away.
  const existed = await dir.getFileHandle(path).then(() => true, () => false);
  const handle = await dir.getFileHandle(path, { create: true });
  const writable = await handle.createWritable();
  try {
    await file.stream().pipeTo(writable);
  } catch (err) {
    // pipeTo aborts the writable itself, which discards the partial write; an
    // entry this call created is what is left.
    if (!existed) await dir.removeEntry(path).catch(() => undefined);
    throw err;
  }
  return {
    folder: true,
    path,
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    size: file.size,
  };
}

/**
 * The File a record points at, or null when it is no longer in the folder.
 *
 * Re-wrapped so it carries the ORIGINAL name and mtime rather than the folder
 * copy's: a File built from another Blob references its bytes, it does not
 * copy them, so this costs nothing and keeps every key derived from the file
 * (dedup, relink, caches) identical to the one the import computed.
 */
export async function readFolderFile(
  dir: FileSystemDirectoryHandle,
  ref: FolderFileRef,
): Promise<File | null> {
  try {
    const raw = await (await dir.getFileHandle(ref.path)).getFile();
    const file = new File([raw], ref.name, { type: ref.type, lastModified: ref.lastModified });
    folderFiles.set(file, ref);
    return file;
  } catch {
    return null;
  }
}

/** Delete a folder copy. Already gone is fine: the goal is that it is not there. */
export async function removeFolderFile(dir: FileSystemDirectoryHandle, ref: FolderFileRef): Promise<void> {
  try {
    await dir.removeEntry(ref.path);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'NotFoundError')) {
      console.warn('[storageFolder] could not delete', ref.path, err);
    }
  }
}
