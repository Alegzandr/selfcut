import { AudioTrackInfo, MediaAsset, Project, isTrackPlayable } from '../types';
import { useStore } from '../store/store';
import { ensureAssetVisuals } from '../media/probe';
import { setTranscodedAudio } from '../media/mediaCache';
// Static, despite only being needed after a restore: both modules are already
// in the main chunk through the store, so importing them lazily would split
// nothing and only cost a round trip. The 32 MB core is NOT pulled in by this -
// the ffmpeg runtime imports it dynamically, on first job.
import { decodeCachedAudio } from '../media/transcodeAudio';
import { isMissingSource } from './missingSource';
import { ASSETS_STORE, PROJECT_STORE, db, requestDone, txDone } from './idb';
import { loadTranscodedAudio, pruneTranscodedAudio } from './audioCache';
import { t } from '../i18n';

// Surface a save failure once per session: repeated debounced saves must not
// spam the toast, but the user has to know their work is not being persisted
// (storage full, or IndexedDB blocked in private mode).
let saveErrorShown = false;
function reportSaveFailure(err: unknown): void {
  console.warn('[persistence] save failed:', err);
  if (saveErrorShown) return;
  saveErrorShown = true;
  useStore.getState().setError(t('errors.persistence.saveFailed'));
}

/**
 * Project persistence in IndexedDB. The project structure and every imported
 * media file (File blobs are structured-cloneable) are saved locally, so a
 * refresh or a closed tab never loses work. Saves are incremental: the
 * project JSON is debounced, assets are written/deleted one by one as the
 * library changes.
 */

const PROJECT_KEY = 'current';
const SAVE_DEBOUNCE_MS = 500;

/**
 * Ask the browser to stop counting this origin as disposable.
 *
 * Without it everything here is best-effort storage, which the browser is free
 * to wipe under disk pressure - not just the reconstructible audio cache, but
 * the project itself, with no event and no warning. The audio cache budget only
 * governs what SelfCut chooses to keep; this governs whether that choice is
 * ours to make at all. A refusal is normal (Firefox prompts, some contexts
 * decline outright) and changes nothing about how the app behaves.
 */
async function requestPersistentStorage(): Promise<void> {
  try {
    if (!(await navigator.storage?.persisted?.())) await navigator.storage?.persist?.();
  } catch {
    /* unsupported, or declined - best-effort storage still works */
  }
}

// Guards against a stale or corrupted database (older schema, interrupted
// write): a project that fails the check is discarded instead of crashing
// hydration, and invalid assets are dropped individually.
export function isValidProject(p: unknown): p is Project {
  if (typeof p !== 'object' || p === null) return false;
  const proj = p as Project;
  return (
    typeof proj.id === 'string' &&
    typeof proj.fps === 'number' &&
    // Absent on projects saved before markers existed - hydrate() defaults it.
    (proj.markers === undefined || Array.isArray(proj.markers)) &&
    Array.isArray(proj.tracks) &&
    proj.tracks.every(
      (tr) => typeof tr?.id === 'string' && Array.isArray(tr.clips) && tr.clips.every((c) => typeof c?.id === 'string'),
    )
  );
}

function isValidAsset(a: unknown): a is MediaAsset {
  if (typeof a !== 'object' || a === null) return false;
  const asset = a as MediaAsset;
  return (
    typeof asset.id === 'string' &&
    asset.file instanceof File &&
    typeof asset.durationMs === 'number' &&
    Array.isArray(asset.thumbnails)
  );
}

/**
 * A persisted File is only a reference to the on-disk file. Between sessions
 * that file can be moved, renamed or deleted, and any read then throws. Probe
 * a single byte so we can flag the asset up front instead of letting every
 * decode fail silently and leave the preview black.
 */
async function isFileReadable(file: File): Promise<boolean> {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/**
 * `transcoded` marks an undecodable track whose PCM sits in the in-memory cache.
 * That cache dies with the tab, so a restored asset must forget the flag:
 * keeping it would claim the track is audible and export it as silence.
 *
 * The flag is re-earned, not assumed: `restoreTranscodedTracks` puts it back
 * only for the tracks whose compressed copy is still in the database AND still
 * decodes. Between the two, a track whose cache is gone degrades to what it did
 * before the cache existed - peaks intact, one transcode to re-run.
 */
function dropTranscodedFlags(asset: MediaAsset): MediaAsset {
  if (!asset.audioTracks.some((track) => track.transcoded)) return asset;
  const audioTracks = asset.audioTracks.map(({ transcoded: _dropped, ...track }) => track);
  return { ...asset, audioTracks, hasAudio: audioTracks.some(isTrackPlayable) };
}

/**
 * Bring an asset stored before multi-track audio up to the current shape: a
 * legacy asset has `hasAudio` + a single top-level `peaks` array but no
 * `audioTracks`, so synthesize a one-entry list (the old primary track) that
 * carries those peaks. Assets already on the new shape pass through untouched.
 */
function migrateAsset(asset: MediaAsset): MediaAsset {
  if (Array.isArray(asset.audioTracks)) return dropTranscodedFlags(asset);
  const legacy = asset as MediaAsset & { peaks?: number[] };
  const audioTracks: AudioTrackInfo[] = legacy.hasAudio
    ? [{ index: 0, channels: 2, ...(legacy.peaks ? { peaks: legacy.peaks } : {}) }]
    : [];
  const { peaks: _dropped, ...rest } = legacy;
  return { ...rest, audioTracks };
}

async function loadPersisted(): Promise<{ project: Project; assets: MediaAsset[] } | null> {
  const d = await db();
  const tx = d.transaction([PROJECT_STORE, ASSETS_STORE], 'readonly');
  const project = await requestDone(tx.objectStore(PROJECT_STORE).get(PROJECT_KEY));
  if (!isValidProject(project)) return null;
  const stored = (await requestDone(tx.objectStore(ASSETS_STORE).getAll()))
    .filter(isValidAsset)
    .map(migrateAsset);
  // Flag every asset whose source file no longer reads (disconnected source).
  // An asset that came from a `.selfcut` file and has not been relinked yet
  // carries a placeholder instead of a real File: it reads fine (it is an empty
  // Blob) but holds no media, so it has to be recognized on its own.
  const assets = await Promise.all(
    stored.map(async (asset) => ({
      ...asset,
      disconnected: isMissingSource(asset.file) || !(await isFileReadable(asset.file)),
    })),
  );
  return { project, assets };
}

/**
 * Republish every transcoded track whose compressed copy survived, so a
 * reopened project is audible without re-running conversions that take minutes.
 *
 * Runs after hydrate rather than inside it: decoding is asynchronous and the
 * editor must not wait on it to appear. Tracks light up as they land, in the
 * same way a background thumbnail pass fills the strip.
 */
async function restoreTranscodedTracks(assets: MediaAsset[]): Promise<void> {
  await Promise.all(
    assets.flatMap((asset) =>
      // Only an undecodable track can have been transcoded; a disconnected
      // asset has no source to fall back on either way, but its cached audio is
      // still perfectly good, so it is deliberately not skipped here.
      asset.audioTracks
        .filter((track) => track.undecodable)
        .map(async (track) => {
          const bytes = await loadTranscodedAudio(asset.id, track.index);
          if (!bytes) return;
          const buffer = await decodeCachedAudio(bytes);
          if (!buffer) return;

          // The library can have changed while this decoded: an asset the user
          // removed in the meantime must not come back audible.
          const current = useStore.getState().assets[asset.id];
          if (!current || current.file !== asset.file) return;

          const peaks = setTranscodedAudio(asset.id, track.index, buffer, {
            alsoPrimary: current.audioTracks.length === 1,
          });
          const audioTracks = current.audioTracks.map((tr) =>
            tr.index === track.index ? { ...tr, transcoded: true, peaks } : tr,
          );
          useStore.setState({
            assets: {
              ...useStore.getState().assets,
              [asset.id]: { ...current, audioTracks, hasAudio: true },
            },
          });
        }),
    ),
  );
}

let saveTimer: number | null = null;

function scheduleProjectSave(project: Project): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void writeProject(project);
  }, SAVE_DEBOUNCE_MS);
}

async function writeProject(project: Project): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(PROJECT_STORE, 'readwrite');
    tx.objectStore(PROJECT_STORE).put(project, PROJECT_KEY);
    await txDone(tx);
  } catch (err) {
    reportSaveFailure(err);
  }
}

async function syncAssets(
  next: Record<string, MediaAsset>,
  prev: Record<string, MediaAsset>,
): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(ASSETS_STORE, 'readwrite');
    const store = tx.objectStore(ASSETS_STORE);
    for (const [id, asset] of Object.entries(next)) {
      if (prev[id] !== asset) store.put(asset);
    }
    // The asset itself goes now - the state is the library, and leaving its
    // blob behind would resurrect the card on the next hydrate. Its transcoded
    // audio stays: a removal is undoable for as long as the session lasts, and
    // orphans are swept at the next startup instead.
    for (const id of Object.keys(prev)) if (!(id in next)) store.delete(id);
    await txDone(tx);
  } catch (err) {
    reportSaveFailure(err);
  }
}

let started = false;

/**
 * Restore the last session (if the editor is still pristine), then keep
 * IndexedDB in sync with the store. Call once at startup.
 */
export async function initPersistence(): Promise<void> {
  if (started) return;
  started = true;

  try {
    const saved = await loadPersisted();
    const s = useStore.getState();
    const pristine =
      s.project.tracks.length === 0 && Object.keys(s.assets).length === 0 && s.past.length === 0;
    if (saved && pristine && (saved.project.tracks.length > 0 || saved.assets.length > 0)) {
      s.hydrate(saved.project, saved.assets);
      // Recompute anything saved before it finished (peaks, thumbnail strip).
      // Skip disconnected assets: their file cannot be read, so decoding would
      // only throw - they wait for the user to reconnect the source.
      for (const asset of saved.assets) if (!asset.disconnected) ensureAssetVisuals(asset, s);
      // Not awaited: the editor is usable now, and transcoded tracks light up
      // as their cached audio decodes.
      void restoreTranscodedTracks(saved.assets);
    }
  } catch (err) {
    console.warn('[persistence] restore failed:', err);
  }

  // Before the subscription, so the sweep reads a library no store write can be
  // racing it for. Cheap: key and metadata scans only, no blob is read.
  await pruneTranscodedAudio();
  // Not awaited: it can prompt in some browsers, and nothing below depends on
  // the answer.
  void requestPersistentStorage();

  useStore.subscribe((s, prev) => {
    if (s.project !== prev.project) scheduleProjectSave(s.project);
    if (s.assets !== prev.assets) void syncAssets(s.assets, prev.assets);
  });

  // Flush the pending debounced save when the page goes away.
  window.addEventListener('pagehide', () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
      void writeProject(useStore.getState().project);
    }
  });
}
