import {
  AUDIO_META_STORE,
  AUDIO_STORE,
  ASSETS_STORE,
  db,
  isQuotaError,
  requestDone,
  txDone,
} from './idb';
import { useStore } from '../store/store';

/**
 * On-disk cache of transcoded audio tracks, and the policy that keeps it from
 * eating the user's disk.
 *
 * A transcode costs minutes, so the compressed result is worth keeping across
 * sessions; but an hour of AAC is ~57 MB and nothing here is ever explicitly
 * deleted by the user, so an unbounded cache is a slow leak that only shows up
 * as a full disk months later. The rule is that this cache is always
 * reconstructible: every entry can be regenerated from the source file, so
 * dropping one costs time, never data. That is what makes silent eviction the
 * right call instead of asking.
 */

/**
 * Share of the origin's quota this cache may occupy, and the absolute rails.
 *
 * A fraction rather than a fixed size because the quota already reflects the
 * machine: browsers derive it from free disk, so the same fraction is a few
 * hundred MB on a full laptop and several GB on a workstation, without the app
 * having to guess. The floor keeps a nearly-full disk from disabling the cache
 * outright (one long track still fits, which is the case it exists for); the
 * ceiling stops a 2 TB drive from handing us 800 GB of headroom we would
 * cheerfully fill.
 */
const QUOTA_SHARE = 0.4;
const MIN_BUDGET_BYTES = 256 * 1024 * 1024;
const MAX_BUDGET_BYTES = 6 * 1024 * 1024 * 1024;
/** Used when the browser will not estimate: conservative, still useful. */
const FALLBACK_BUDGET_BYTES = 1024 * 1024 * 1024;

export interface CacheMeta {
  assetId: string;
  trackIndex: number;
  byteLength: number;
  lastUsedAt: number;
}

/**
 * Which entries have to go for the cache to fit in `target`, and nothing more.
 *
 * Pure and exported for its own sake: this is where the policy actually lives,
 * and the alternative to testing it directly is asserting on the contents of a
 * database after a transcode - which would test IndexedDB, slowly, and still
 * not pin down the ordering.
 */
export function selectEvictions(
  entries: Iterable<readonly [string, CacheMeta]>,
  target: number,
  pinned: ReadonlySet<string>,
  keep?: string,
): string[] {
  let total = 0;
  const all = [...entries];
  for (const [, entry] of all) total += entry.byteLength;
  if (total <= target) return [];

  const candidates = all
    .filter(([key]) => key !== keep)
    // Least-recently-used within each tier, unpinned tier first. Sorting one
    // list by (pinned, lastUsedAt) rather than draining two keeps the fallback
    // implicit: pinned entries are simply last in line, and are only reached
    // when dropping every unpinned one was not enough.
    .sort(([, a], [, b]) => {
      const pa = pinned.has(a.assetId) ? 1 : 0;
      const pb = pinned.has(b.assetId) ? 1 : 0;
      return pa !== pb ? pa - pb : a.lastUsedAt - b.lastUsedAt;
    });

  const doomed: string[] = [];
  for (const [key, entry] of candidates) {
    if (total <= target) break;
    doomed.push(key);
    total -= entry.byteLength;
  }
  return doomed;
}

function cacheKey(assetId: string, audioTrackIndex: number): string {
  return `${assetId}#${audioTrackIndex}`;
}

/** Keys are `${assetId}#${index}`, and an asset id never contains a '#'. */
function assetIdOf(key: string): string {
  return key.slice(0, key.indexOf('#'));
}

async function budgetBytes(): Promise<number> {
  try {
    const { quota } = await navigator.storage.estimate();
    if (!quota) return FALLBACK_BUDGET_BYTES;
    return Math.min(MAX_BUDGET_BYTES, Math.max(MIN_BUDGET_BYTES, quota * QUOTA_SHARE));
  } catch {
    return FALLBACK_BUDGET_BYTES;
  }
}

/**
 * Assets the user would actually notice losing: the ones with a clip on the
 * timeline. Reopening the project re-decodes those immediately, so evicting one
 * turns into a visible wait, which is the single thing this cache is meant to
 * prevent. Everything else is library-only footage that may never be touched
 * again - dropping it costs nothing until the day it is used, and then only a
 * transcode with a progress bar in front of it.
 *
 * The distinction is soft, not a pin: a project whose timeline alone overflows
 * the budget still has to give something up, and `evict` falls through to these
 * last rather than failing to free anything.
 */
function timelineAssetIds(): Set<string> {
  const ids = new Set<string>();
  for (const track of useStore.getState().project.tracks) {
    for (const clip of track.clips) if (clip.assetId) ids.add(clip.assetId);
  }
  return ids;
}

/**
 * Serializes every mutation of the cache. Saves are fire-and-forget from the
 * transcode path, so two can be in flight at once; without this, both would
 * measure the total before either had written, and each would decide on its own
 * that nothing needed evicting.
 */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  // The chain must not inherit a rejection, or every later task is skipped.
  queue = run.catch(() => {});
  return run;
}

async function readMeta(): Promise<Map<string, CacheMeta>> {
  const d = await db();
  const tx = d.transaction(AUDIO_META_STORE, 'readonly');
  const store = tx.objectStore(AUDIO_META_STORE);
  // Both reads are issued before the first await: a transaction with no pending
  // request auto-commits, and awaiting them in turn would risk finding it
  // closed by the time the second one is asked for.
  const [keys, values] = await Promise.all([
    requestDone(store.getAllKeys()),
    requestDone(store.getAll()),
  ]);
  const meta = new Map<string, CacheMeta>();
  keys.forEach((key, i) => {
    if (typeof key === 'string') meta.set(key, values[i] as CacheMeta);
  });
  return meta;
}

async function deleteEntries(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const d = await db();
  const tx = d.transaction([AUDIO_STORE, AUDIO_META_STORE], 'readwrite');
  const bytes = tx.objectStore(AUDIO_STORE);
  const meta = tx.objectStore(AUDIO_META_STORE);
  for (const key of keys) {
    bytes.delete(key);
    meta.delete(key);
  }
  await txDone(tx);
}

/**
 * Bring the cache down to `target` bytes, oldest first, and answer how much was
 * freed.
 *
 * `keep` is the entry the caller is about to write or has just written: evicting
 * it would make the save pointless, and on the retry path it is the very thing
 * being made room for.
 */
async function evict(target: number, keep?: string): Promise<void> {
  const meta = await readMeta();
  const doomed = selectEvictions(meta, target, timelineAssetIds(), keep);
  if (doomed.length === 0) return;
  await deleteEntries(doomed);
  const freed = doomed.reduce((sum, key) => sum + (meta.get(key)?.byteLength ?? 0), 0);
  console.info(
    `[audioCache] evicted ${doomed.length} entr${doomed.length === 1 ? 'y' : 'ies'}, freed ${Math.round(freed / 1e6)} MB`,
  );
}

async function write(key: string, bytes: Uint8Array, now: number): Promise<void> {
  const d = await db();
  const tx = d.transaction([AUDIO_STORE, AUDIO_META_STORE], 'readwrite');
  tx.objectStore(AUDIO_STORE).put(bytes, key);
  const meta: CacheMeta = {
    assetId: assetIdOf(key),
    trackIndex: Number(key.slice(key.indexOf('#') + 1)),
    byteLength: bytes.byteLength,
    lastUsedAt: now,
  };
  tx.objectStore(AUDIO_META_STORE).put(meta, key);
  await txDone(tx);
}

/**
 * Keep the compressed copy of a transcoded track, so reopening the project does
 * not re-run a conversion that takes minutes.
 *
 * A failure here is deliberately swallowed rather than surfaced: the transcode
 * itself succeeded and the track is audible for this session. All that is lost
 * is the shortcut next time, which is not worth a toast over a full disk.
 */
export async function saveTranscodedAudio(
  assetId: string,
  audioTrackIndex: number,
  bytes: Uint8Array,
): Promise<void> {
  const key = cacheKey(assetId, audioTrackIndex);
  await serialize(async () => {
    const now = Date.now();
    try {
      // Make room first, so the common case never touches the quota ceiling and
      // the browser is never the one deciding what to drop. Its own eviction is
      // origin-wide and would take the project with it.
      const budget = await budgetBytes();
      await evict(Math.max(0, budget - bytes.byteLength), key);
      await write(key, bytes, now);
    } catch (err) {
      if (!isQuotaError(err)) {
        console.warn('[audioCache] transcoded audio not cached:', err);
        return;
      }
      // The estimate was optimistic - other origins, or our own assets, moved
      // under us. Free real room and try once more; a second failure means the
      // disk is genuinely full and the session is unaffected either way.
      try {
        await evict(Math.max(0, (await budgetBytes()) / 2 - bytes.byteLength), key);
        await write(key, bytes, now);
      } catch (retryErr) {
        console.warn('[audioCache] transcoded audio not cached after eviction:', retryErr);
      }
    }
  });
}

/**
 * The cached copy of a transcoded track, or null if there is none.
 *
 * A hit refreshes the entry's timestamp: last-used is what makes eviction track
 * the footage the user keeps coming back to, rather than the order things were
 * imported in.
 */
export async function loadTranscodedAudio(
  assetId: string,
  audioTrackIndex: number,
): Promise<Uint8Array | null> {
  const key = cacheKey(assetId, audioTrackIndex);
  try {
    const d = await db();
    const tx = d.transaction(AUDIO_STORE, 'readonly');
    const bytes = await requestDone(tx.objectStore(AUDIO_STORE).get(key));
    if (!(bytes instanceof Uint8Array)) return null;
    void touch(key);
    return bytes;
  } catch {
    return null;
  }
}

/** Not awaited by readers: a lost timestamp only costs eviction accuracy. */
async function touch(key: string): Promise<void> {
  try {
    const now = Date.now();
    await serialize(async () => {
      const d = await db();
      const tx = d.transaction(AUDIO_META_STORE, 'readwrite');
      const store = tx.objectStore(AUDIO_META_STORE);
      const meta = (await requestDone(store.get(key))) as CacheMeta | undefined;
      // Gone since the read: the entry lost a race with eviction. Writing the
      // metadata back would leave a record pointing at bytes that no longer
      // exist, and the total would never come down again.
      if (meta) store.put({ ...meta, lastUsedAt: now }, key);
      await txDone(tx);
    });
  } catch {
    /* the timestamp is a hint, not state anything depends on */
  }
}

/**
 * Drop the cached tracks of every asset the library no longer holds, then bring
 * whatever remains within budget.
 *
 * Deliberately a startup sweep rather than a delete on removal: removing an
 * asset is undoable, and a transcode costs minutes to redo, so the cache has to
 * outlive the removal for as long as a Ctrl+Z can bring the asset back. The
 * memory side already works this way (`disposeUnreachableAssets`), which keeps
 * an undone removal fully playable.
 *
 * Orphans are judged against the asset store rather than the live state: that
 * store IS the persisted library, so this stays correct whether or not the
 * session hydrated from it. Undo is a within-session affair - once the tab is
 * gone, so is the history that could have brought the asset back.
 */
export async function pruneTranscodedAudio(): Promise<void> {
  try {
    await serialize(async () => {
      const d = await db();
      const live = new Set(
        await requestDone(d.transaction(ASSETS_STORE, 'readonly').objectStore(ASSETS_STORE).getAllKeys()),
      );
      const meta = await readMeta();
      await deleteEntries([...meta.keys()].filter((key) => !live.has(assetIdOf(key))));
      // The budget can have shrunk since last run (a fuller disk means a
      // smaller quota), so orphans alone are not enough to call it clean.
      await evict(await budgetBytes());
    });
  } catch (err) {
    console.warn('[audioCache] transcoded audio not pruned:', err);
  }
}

/**
 * Empty the cache outright, for "New project".
 *
 * The only moment the user states plainly that none of this is wanted any more.
 * Waiting for the next startup sweep to notice would leave gigabytes behind for
 * as long as the tab stays open, which is exactly when someone clearing their
 * project is most likely to be clearing space.
 */
export async function clearTranscodedAudio(): Promise<void> {
  try {
    await serialize(async () => {
      const d = await db();
      const tx = d.transaction([AUDIO_STORE, AUDIO_META_STORE], 'readwrite');
      tx.objectStore(AUDIO_STORE).clear();
      tx.objectStore(AUDIO_META_STORE).clear();
      await txDone(tx);
    });
  } catch (err) {
    console.warn('[audioCache] transcoded audio not cleared:', err);
  }
}
