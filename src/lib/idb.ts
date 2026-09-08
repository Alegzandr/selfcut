/**
 * The one IndexedDB connection, and the primitives every store shares.
 *
 * Split out of persistence.ts so the audio cache can own its stores without
 * either module reaching into the other's internals: a second `indexedDB.open`
 * on the same name would block on the first one's upgrade and deadlock startup.
 */

export const DB_NAME = 'selfcut';
const DB_VERSION = 5;

export const PROJECT_STORE = 'project';
/** Asset metadata (everything on a MediaAsset except its File), keyed by asset id. */
export const ASSETS_STORE = 'assets';
/**
 * The media File of each asset, keyed by asset id, apart from its metadata.
 *
 * A File put into IndexedDB is not a reference: Chrome copies the whole file
 * into the database's blob directory, and a second `put` of the same record
 * copies it again before the first copy is collected. Kept inline on the asset
 * record, every metadata update (peaks landing, the thumbnail strip filling
 * in) re-copied the source, so one import of a 2 GB recording wrote 6 GB and
 * held twice the file on disk while it did. Here the File is written once, on
 * import or relink, and the metadata record next to it stays a few kilobytes.
 */
export const FILES_STORE = 'assetFiles';
/** Compressed copies of transcoded audio tracks, keyed `${mediaKey}#${trackIndex}`. */
export const AUDIO_STORE = 'transcodedAudio';
/**
 * Bookkeeping for AUDIO_STORE under the same keys: size, owner, last use.
 *
 * A separate store rather than fields on the entry itself, because eviction has
 * to rank every entry before it deletes any, and the ranking only needs the
 * metadata. Kept next to the bytes, a `getAll` to decide what to drop would pull
 * every cached track into memory - gigabytes read to free gigabytes. These
 * records are a few dozen bytes each, so the same scan is free. Both stores are
 * always written in one transaction, so they cannot drift apart.
 */
export const AUDIO_META_STORE = 'transcodedAudioMeta';

/**
 * Cues pulled out of an embedded subtitle track, keyed `${mediaKey}#s${index}`.
 *
 * Stored as the parsed cue array rather than the raw ASS/SubRip bytes: parsing
 * is the cheap half, and keeping the text would mean re-running a parser whose
 * output shape can change between releases against input this cache promises
 * nothing about. The `s` in the key is what keeps a subtitle track 0 apart from
 * an audio track 0 if the two ever share a store.
 */
export const SUBTITLE_STORE = 'subtitleCues';
/** Bookkeeping for SUBTITLE_STORE under the same keys. See AUDIO_META_STORE. */
export const SUBTITLE_META_STORE = 'subtitleCuesMeta';

let dbPromise: Promise<IDBDatabase> | null = null;

export function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const d = req.result;
      if (!d.objectStoreNames.contains(PROJECT_STORE)) d.createObjectStore(PROJECT_STORE);
      if (!d.objectStoreNames.contains(ASSETS_STORE)) {
        d.createObjectStore(ASSETS_STORE, { keyPath: 'id' });
      }
      // v5: Files move out of the asset record. Not migrated here: an asset
      // saved by v4 still carries its File inline, persistence reads it from
      // there and moves it into this store on the asset's next write. Moving
      // them all during the upgrade would copy every library file again, on
      // the startup path, before the editor has appeared.
      if (!d.objectStoreNames.contains(FILES_STORE)) d.createObjectStore(FILES_STORE);
      // Dropped rather than migrated, twice over now. v2 stored bare
      // Uint8Arrays with no sizes and no timestamps, which is exactly what
      // eviction needs and cannot reconstruct; v3 keyed them by asset id, a
      // random per-import value, so its keys cannot be rewritten into v4's
      // file-derived ones without the assets to translate through - and the
      // translation would still be wrong for every entry whose asset is gone,
      // which is the very case this change exists to fix.
      //
      // Dropping is affordable because of what this store is: every entry is a
      // transcode the app knows how to redo, so starting over costs one
      // conversion the next time that track is opened, and nothing at all for
      // the ones never reopened.
      //
      // Only on the way up from those versions: a later upgrade (v5 added a
      // store elsewhere) must leave the caches alone, or every version bump
      // would cost the user their transcodes.
      const rebuildCaches = event.oldVersion < 4;
      for (const store of [AUDIO_STORE, AUDIO_META_STORE, SUBTITLE_STORE, SUBTITLE_META_STORE]) {
        if (rebuildCaches && d.objectStoreNames.contains(store)) d.deleteObjectStore(store);
        if (!d.objectStoreNames.contains(store)) d.createObjectStore(store);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * Drop the shared connection so the database can be deleted.
 *
 * `indexedDB.deleteDatabase` blocks for as long as any connection is open, and
 * this module deliberately keeps exactly one for the lifetime of the tab. The
 * memoised promise is cleared too, so a later call to `db()` reopens rather
 * than handing back a handle to a database that no longer exists.
 */
export async function closeDb(): Promise<void> {
  const pending = dbPromise;
  if (!pending) return;
  dbPromise = null;
  try {
    (await pending).close();
  } catch {
    /* never opened, or already gone - either way there is nothing to close */
  }
}

export function requestDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Resolve when a write transaction actually commits. Firing put/delete and
 * returning is not enough: the write can still fail at commit time (quota
 * exceeded, disk full), and only the transaction's own events report it - so a
 * silent data-loss would otherwise go unnoticed.
 */
export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * True when the failure is the disk saying no, rather than the database saying
 * the write was wrong.
 *
 * The name is checked instead of `instanceof DOMException` because a commit-time
 * quota failure surfaces as `tx.error`, which browsers do not all class the same
 * way. Only the name is specified.
 */
export function isQuotaError(err: unknown): boolean {
  return err instanceof Error && err.name === 'QuotaExceededError';
}
