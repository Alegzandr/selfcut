/**
 * The one IndexedDB connection, and the primitives every store shares.
 *
 * Split out of persistence.ts so the audio cache can own its stores without
 * either module reaching into the other's internals: a second `indexedDB.open`
 * on the same name would block on the first one's upgrade and deadlock startup.
 */

const DB_NAME = 'selfcut';
const DB_VERSION = 3;

export const PROJECT_STORE = 'project';
export const ASSETS_STORE = 'assets';
/** Compressed copies of transcoded audio tracks, keyed `${assetId}#${trackIndex}`. */
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

let dbPromise: Promise<IDBDatabase> | null = null;

export function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(PROJECT_STORE)) d.createObjectStore(PROJECT_STORE);
      if (!d.objectStoreNames.contains(ASSETS_STORE)) {
        d.createObjectStore(ASSETS_STORE, { keyPath: 'id' });
      }
      // v2 stored bare Uint8Arrays with no sizes and no timestamps, which is
      // exactly what eviction needs and cannot reconstruct. Dropping the store
      // is the migration: every entry is a transcode the app already knows how
      // to redo on demand, so the cost of starting over is one conversion the
      // next time that track is opened - against the alternative of carrying a
      // shape that can never be budgeted.
      if (d.objectStoreNames.contains(AUDIO_STORE)) d.deleteObjectStore(AUDIO_STORE);
      if (d.objectStoreNames.contains(AUDIO_META_STORE)) d.deleteObjectStore(AUDIO_META_STORE);
      d.createObjectStore(AUDIO_STORE);
      d.createObjectStore(AUDIO_META_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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
