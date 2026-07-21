import { SUBTITLE_META_STORE, SUBTITLE_STORE, db, requestDone, txDone } from './idb';
import { mediaKeyOf } from './mediaKey';
import type { SubtitleCue } from './subtitles';

/**
 * On-disk cache of cues extracted from embedded subtitle tracks.
 *
 * The extraction is what costs, not the text: ffmpeg demuxes the container end
 * to end whatever it is asked for, so lifting a few hundred kB of dialogue out
 * of a disc rip reads several GB. Doing that twice for the same file is the
 * thing this exists to prevent - and until now it happened every single time,
 * since the cues only ever survived as caption clips inside the project.
 *
 * Keyed by the source file rather than the asset (see lib/mediaKey.ts), so the
 * cache hits whenever the same bytes come back: re-import after a removal, a
 * second project, a relinked source.
 *
 * Budgeting is by entry count, not bytes, which is the one real difference from
 * the audio cache. An hour of AAC is ~57 MB and a full track of dialogue is a
 * few dozen kB, so the quota arithmetic the audio cache needs would be three
 * orders of magnitude of machinery for a store that cannot plausibly fill a
 * disk. A flat cap on entries bounds it well enough.
 */

/**
 * At a few dozen kB per track, this is tens of MB at worst - and reaching it
 * takes a library of hundreds of subtitled files. The cap is a backstop against
 * unbounded growth over years, not a budget anyone should ever feel.
 */
const MAX_ENTRIES = 500;

export interface SubtitleCacheMeta {
  mediaKey: string;
  trackIndex: number;
  lastUsedAt: number;
}

function cacheKey(mediaKey: string, subtitleTrackIndex: number): string {
  return `${mediaKey}#s${subtitleTrackIndex}`;
}

/** See the same helper in audioCache: saves are fire-and-forget and can race. */
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

async function readMeta(): Promise<Map<string, SubtitleCacheMeta>> {
  const d = await db();
  const store = d.transaction(SUBTITLE_META_STORE, 'readonly').objectStore(SUBTITLE_META_STORE);
  // Issued before the first await: a transaction with no pending request
  // auto-commits, so awaiting in turn could find it closed.
  const [keys, values] = await Promise.all([
    requestDone(store.getAllKeys()),
    requestDone(store.getAll()),
  ]);
  const meta = new Map<string, SubtitleCacheMeta>();
  keys.forEach((key, i) => {
    if (typeof key === 'string') meta.set(key, values[i] as SubtitleCacheMeta);
  });
  return meta;
}

async function deleteEntries(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const d = await db();
  const tx = d.transaction([SUBTITLE_STORE, SUBTITLE_META_STORE], 'readwrite');
  for (const key of keys) {
    tx.objectStore(SUBTITLE_STORE).delete(key);
    tx.objectStore(SUBTITLE_META_STORE).delete(key);
  }
  await txDone(tx);
}

/**
 * Which entries to drop so at most `MAX_ENTRIES` remain, least recently used
 * first. Pure and exported for the same reason as the audio cache's: the policy
 * is the part worth testing, and the alternative is asserting on a database.
 */
export function selectEvictions(
  entries: Iterable<readonly [string, SubtitleCacheMeta]>,
  max: number,
  incoming?: string,
): string[] {
  const all = [...entries];
  // The entry about to be written counts against the cap but cannot be evicted
  // for it - unless it is an overwrite, in which case it occupies no new slot.
  const total = all.length + (incoming && !all.some(([key]) => key === incoming) ? 1 : 0);
  const excess = total - max;
  if (excess <= 0) return [];
  return all
    .filter(([key]) => key !== incoming)
    .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)
    .slice(0, excess)
    .map(([key]) => key);
}

/**
 * Keep the cues of one extracted track.
 *
 * Failures are swallowed: the extraction succeeded and the captions are on the
 * timeline. All that is lost is the shortcut next time, which is not worth a
 * toast over a full disk.
 */
export async function saveSubtitleCues(
  file: File,
  subtitleTrackIndex: number,
  cues: SubtitleCue[],
): Promise<void> {
  const mediaKey = mediaKeyOf(file);
  if (!mediaKey) return;
  const key = cacheKey(mediaKey, subtitleTrackIndex);
  try {
    await serialize(async () => {
      await deleteEntries(selectEvictions(await readMeta(), MAX_ENTRIES, key));
      const meta: SubtitleCacheMeta = {
        mediaKey,
        trackIndex: subtitleTrackIndex,
        lastUsedAt: Date.now(),
      };
      const d = await db();
      const tx = d.transaction([SUBTITLE_STORE, SUBTITLE_META_STORE], 'readwrite');
      tx.objectStore(SUBTITLE_STORE).put(cues, key);
      tx.objectStore(SUBTITLE_META_STORE).put(meta, key);
      await txDone(tx);
    });
  } catch (err) {
    console.warn('[subtitleCache] cues not cached:', err);
  }
}

/**
 * The cached cues of one track, or null if there are none.
 *
 * An empty array is a legitimate hit and must survive the round trip: "the
 * track decoded fine and held nothing" is a real answer, and re-running a
 * multi-GB read to learn it again is exactly what this prevents.
 */
export async function loadSubtitleCues(
  file: File,
  subtitleTrackIndex: number,
): Promise<SubtitleCue[] | null> {
  const mediaKey = mediaKeyOf(file);
  if (!mediaKey) return null;
  const key = cacheKey(mediaKey, subtitleTrackIndex);
  try {
    const d = await db();
    const tx = d.transaction(SUBTITLE_STORE, 'readonly');
    const cues = await requestDone(tx.objectStore(SUBTITLE_STORE).get(key));
    if (!Array.isArray(cues)) return null;
    void touch(key);
    return cues as SubtitleCue[];
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
      const tx = d.transaction(SUBTITLE_META_STORE, 'readwrite');
      const store = tx.objectStore(SUBTITLE_META_STORE);
      const meta = (await requestDone(store.get(key))) as SubtitleCacheMeta | undefined;
      // Gone since the read: it lost a race with eviction. Writing the record
      // back would leave one pointing at cues that no longer exist.
      if (meta) store.put({ ...meta, lastUsedAt: now }, key);
      await txDone(tx);
    });
  } catch {
    /* the timestamp is a hint, not state anything depends on */
  }
}

/**
 * Drop the cues of every file the persisted library no longer refers to, then
 * bring what remains within the entry cap.
 *
 * Null `live` means the library could not vouch for itself - see the audio
 * cache's equivalent. The cap still applies, so the store stays bounded either
 * way.
 */
export async function pruneSubtitleCues(live: ReadonlySet<string> | null): Promise<void> {
  try {
    await serialize(async () => {
      const meta = await readMeta();
      if (live) {
        await deleteEntries([...meta].filter(([, m]) => !live.has(m.mediaKey)).map(([key]) => key));
      }
      await deleteEntries(selectEvictions(await readMeta(), MAX_ENTRIES));
    });
  } catch (err) {
    console.warn('[subtitleCache] cues not pruned:', err);
  }
}

/** Empty the cache outright, for "New project". See clearTranscodedAudio. */
export async function clearSubtitleCues(): Promise<void> {
  try {
    await serialize(async () => {
      const d = await db();
      const tx = d.transaction([SUBTITLE_STORE, SUBTITLE_META_STORE], 'readwrite');
      tx.objectStore(SUBTITLE_STORE).clear();
      tx.objectStore(SUBTITLE_META_STORE).clear();
      await txDone(tx);
    });
  } catch (err) {
    console.warn('[subtitleCache] cues not cleared:', err);
  }
}
