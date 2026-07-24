import { AudioTrackInfo, MediaAsset, Project, ProjectSummary, isTrackPlayable } from '../types';
import { useStore } from '../store/store';
import { CURRENT_PROJECT_KEY } from '../store/constants';
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
import { pruneSubtitleCues } from './subtitleCache';
import { mediaKeyOf } from './mediaKey';
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

const SAVE_DEBOUNCE_MS = 500;

/** A persisted asset carries its owning project's id, so a project can be listed,
 * loaded and swept independently. Runtime `MediaAsset` never needs the field. */
type StoredAsset = MediaAsset & { projectId?: string };

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

/**
 * Load one project and only the assets that belong to it (tagged by `projectId`).
 * Returns null when the id isn't in the database. The disconnected flag is
 * computed here for the same reason as before: a `.selfcut` placeholder reads
 * fine but holds no media, and a moved source file no longer reads at all.
 */
export async function loadProjectById(
  id: string,
): Promise<{ project: Project; assets: MediaAsset[] } | null> {
  const d = await db();
  const tx = d.transaction([PROJECT_STORE, ASSETS_STORE], 'readonly');
  const project = await requestDone(tx.objectStore(PROJECT_STORE).get(id));
  if (!isValidProject(project)) return null;
  const stored = (await requestDone(tx.objectStore(ASSETS_STORE).getAll()))
    .filter(isValidAsset)
    .filter((a) => (a as StoredAsset).projectId === id)
    .map(migrateAsset);
  const assets = await Promise.all(
    stored.map(async (asset) => ({
      ...asset,
      disconnected: isMissingSource(asset.file) || !(await isFileReadable(asset.file)),
    })),
  );
  return { project, assets };
}

/** Every project in the database, newest first, as lightweight browser rows. */
export async function listProjectMetas(): Promise<ProjectSummary[]> {
  try {
    const d = await db();
    const projects = (
      await requestDone(d.transaction(PROJECT_STORE, 'readonly').objectStore(PROJECT_STORE).getAll())
    ).filter(isValidProject);
    return projects
      .map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt }))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  } catch (err) {
    console.warn('[persistence] project list failed:', err);
    return [];
  }
}

/**
 * One-time migration from the single-project era: the lone project lived under
 * the fixed key `'current'` and its assets carried no owner. Re-key it by its
 * own id and stamp every untagged asset with it, so the multi-project code sees
 * a normal project. A no-op once done, and on a fresh database.
 */
async function migrateSingleProject(): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction([PROJECT_STORE, ASSETS_STORE], 'readwrite');
    const ps = tx.objectStore(PROJECT_STORE);
    const keys = await requestDone(ps.getAllKeys());
    if (!keys.includes('current')) return;
    const legacy = await requestDone(ps.get('current'));
    if (isValidProject(legacy)) {
      ps.put({ ...legacy, updatedAt: legacy.updatedAt ?? Date.now() }, legacy.id);
      const as = tx.objectStore(ASSETS_STORE);
      const all = await requestDone(as.getAll());
      for (const a of all) {
        if (isValidAsset(a) && (a as StoredAsset).projectId === undefined) {
          as.put({ ...a, projectId: legacy.id });
        }
      }
    }
    ps.delete('current');
    await txDone(tx);
  } catch (err) {
    console.warn('[persistence] single-project migration failed:', err);
  }
}

/** Delete a project record and every asset owned by it (media caches sweep later). */
export async function deleteProjectFromDb(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction([PROJECT_STORE, ASSETS_STORE], 'readwrite');
  tx.objectStore(PROJECT_STORE).delete(id);
  const store = tx.objectStore(ASSETS_STORE);
  const all = await requestDone(store.getAll());
  for (const a of all) if (isValidAsset(a) && (a as StoredAsset).projectId === id) store.delete(a.id);
  await txDone(tx);
}

/** Rename a project that is NOT the open one (the open one is renamed via the store). */
export async function renameProjectInDb(id: string, name: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(PROJECT_STORE, 'readwrite');
  const store = tx.objectStore(PROJECT_STORE);
  const project = await requestDone(store.get(id));
  if (isValidProject(project)) store.put({ ...project, name, updatedAt: Date.now() }, id);
  await txDone(tx);
}

/**
 * Delete every asset whose owning project no longer exists (or that carries no
 * owner at all). The user's rule: losing unreferenced media is fine, but it must
 * not sit in storage forever. Runs once at startup, after migration.
 */
async function sweepOrphanAssets(validProjectIds: Set<string>): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(ASSETS_STORE, 'readwrite');
    const store = tx.objectStore(ASSETS_STORE);
    const all = await requestDone(store.getAll());
    for (const a of all) {
      if (!isValidAsset(a)) continue;
      const pid = (a as StoredAsset).projectId;
      if (pid === undefined || !validProjectIds.has(pid)) store.delete(a.id);
    }
    await txDone(tx);
  } catch (err) {
    console.warn('[persistence] orphan-asset sweep failed:', err);
  }
}

/**
 * Persist the OPEN project and its whole library in one shot, tagged with the
 * active project id. Used right after creating or opening a project, where the
 * incremental subscription is deliberately bypassed (a project switch adopts the
 * new library without diffing, so it never writes it on its own).
 */
export async function saveWholeProject(): Promise<void> {
  const { project, assets, currentProjectId } = useStore.getState();
  try {
    const d = await db();
    const tx = d.transaction([PROJECT_STORE, ASSETS_STORE], 'readwrite');
    tx.objectStore(PROJECT_STORE).put({ ...project, updatedAt: Date.now() }, project.id);
    const store = tx.objectStore(ASSETS_STORE);
    for (const a of Object.values(assets)) store.put({ ...a, projectId: currentProjectId });
    await txDone(tx);
  } catch (err) {
    reportSaveFailure(err);
  }
}

/**
 * Republish every transcoded track whose compressed copy survived, so a
 * reopened project is audible without re-running conversions that take minutes.
 *
 * Runs after hydrate rather than inside it: decoding is asynchronous and the
 * editor must not wait on it to appear. Tracks light up as they land, in the
 * same way a background thumbnail pass fills the strip.
 */
export async function restoreTranscodedTracks(assets: MediaAsset[]): Promise<void> {
  await Promise.all(
    assets.flatMap((asset) =>
      // Only an undecodable track can have been transcoded; an asset whose file
      // has MOVED is deliberately not skipped, since the persisted File still
      // carries the name, size and mtime its cache is keyed by - the bytes are
      // unreadable, the identity is not. An asset still on a `.selfcut`
      // placeholder has neither, so it misses here and picks its cache back up
      // on the first transcode request after being relinked.
      asset.audioTracks
        .filter((track) => track.undecodable)
        .map(async (track) => {
          const bytes = await loadTranscodedAudio(asset.file, track.index);
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

/**
 * Write the pending debounced project save right now. Called before switching
 * projects, so the outgoing project's last edits land before its library is
 * replaced. A no-op when nothing is pending.
 */
export function flushProjectSave(): void {
  if (saveTimer === null) return;
  window.clearTimeout(saveTimer);
  saveTimer = null;
  void writeProject(useStore.getState().project);
}

/** The project to reopen: the remembered one if it still exists, else the newest. */
function pickCurrentProjectId(metas: ProjectSummary[]): string | null {
  if (metas.length === 0) return null;
  try {
    const saved = localStorage.getItem(CURRENT_PROJECT_KEY);
    if (saved && metas.some((m) => m.id === saved)) return saved;
  } catch {
    /* no storage - fall through to the most recent */
  }
  return metas[0]!.id;
}

async function writeProject(project: Project): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(PROJECT_STORE, 'readwrite');
    // Keyed by the project's own id (out-of-line), and stamped now so the browser
    // can order by "most recently edited". The editor never touches `updatedAt`.
    tx.objectStore(PROJECT_STORE).put({ ...project, updatedAt: Date.now() }, project.id);
    await txDone(tx);
  } catch (err) {
    reportSaveFailure(err);
  }
}

async function syncAssets(
  next: Record<string, MediaAsset>,
  prev: Record<string, MediaAsset>,
  projectId: string,
): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(ASSETS_STORE, 'readwrite');
    const store = tx.objectStore(ASSETS_STORE);
    for (const [id, asset] of Object.entries(next)) {
      if (prev[id] !== asset) store.put({ ...asset, projectId });
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

/**
 * Drop everything both derived-media caches hold for files the library no
 * longer refers to.
 *
 * The live set is read from the asset store rather than the live state: that
 * store IS the persisted library, so this stays correct whether or not the
 * session hydrated from it. Undo is a within-session affair - once the tab is
 * gone, so is the history that could have brought a removed asset back.
 *
 * Assets are the source of truth, not the caches, and this is the only place
 * that reads them for this purpose: the caches key by file (lib/mediaKey.ts)
 * and cannot resolve an asset id, which is exactly the decoupling that lets two
 * assets of the same file share one entry.
 */
async function pruneMediaCaches(): Promise<void> {
  let live: Set<string> | null = null;
  try {
    const d = await db();
    const stored = (
      await requestDone(d.transaction(ASSETS_STORE, 'readonly').objectStore(ASSETS_STORE).getAll())
    ).filter(isValidAsset);
    const keys = stored.map((asset) => mediaKeyOf(asset.file));
    // An asset still on a `.selfcut` placeholder has no media key at all, so it
    // cannot vouch for its own cache - and its entries would read as orphaned
    // and be deleted, wiping hours of transcoding out from under a project the
    // user has merely not relinked yet. One such asset makes the whole library
    // an unreliable witness, so the orphan pass is skipped entirely; eviction
    // still runs and keeps the size bounded, which is the part that protects
    // the disk. Relinking restores the identity, and the next start sweeps.
    if (keys.every((key) => key !== null)) live = new Set(keys as string[]);
  } catch (err) {
    // Same reasoning, for a library that could not be read at all: skipping a
    // sweep costs disk space until the next start, getting it wrong costs the
    // user hours of transcoding.
    console.warn('[persistence] library unreadable, media caches swept by size only:', err);
  }
  await Promise.all([pruneTranscodedAudio(live), pruneSubtitleCues(live)]);
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
    await migrateSingleProject();
    const metas = await listProjectMetas();
    const chosen = pickCurrentProjectId(metas);
    const s = useStore.getState();
    const pristine =
      s.project.tracks.length === 0 && Object.keys(s.assets).length === 0 && s.past.length === 0;
    if (chosen && pristine) {
      const saved = await loadProjectById(chosen);
      if (saved && (saved.project.tracks.length > 0 || saved.assets.length > 0)) {
        s.hydrate(saved.project, saved.assets); // also sets currentProjectId
        // Recompute anything saved before it finished (peaks, thumbnail strip).
        // Skip disconnected assets: their file cannot be read, so decoding would
        // only throw - they wait for the user to reconnect the source.
        for (const asset of saved.assets) if (!asset.disconnected) ensureAssetVisuals(asset, s);
        // Not awaited: the editor is usable now, and transcoded tracks light up
        // as their cached audio decodes.
        void restoreTranscodedTracks(saved.assets);
      }
    }
  } catch (err) {
    console.warn('[persistence] restore failed:', err);
  }

  // Sweep assets whose project is gone, then the media caches. The valid set is
  // every project on disk plus the open one (a brand-new project may not be
  // persisted yet). Both run before the subscription, so no store write races.
  const validIds = new Set((await listProjectMetas()).map((m) => m.id));
  validIds.add(useStore.getState().currentProjectId);
  await sweepOrphanAssets(validIds);
  await pruneMediaCaches();
  // Not awaited: it can prompt in some browsers, and nothing below depends on
  // the answer.
  void requestPersistentStorage();

  let lastProjectId = useStore.getState().currentProjectId;
  try {
    localStorage.setItem(CURRENT_PROJECT_KEY, lastProjectId);
  } catch {
    /* no storage - the reopened project just won't be remembered */
  }
  useStore.subscribe((s, prev) => {
    // A project switch changes project, assets AND the id in one store update.
    // The target was loaded from disk (or explicitly saved by the orchestration),
    // so adopt it without diffing - a diff would read the old library as "removed"
    // and delete its assets out from under the project that still owns them.
    if (s.currentProjectId !== lastProjectId) {
      lastProjectId = s.currentProjectId;
      try {
        localStorage.setItem(CURRENT_PROJECT_KEY, s.currentProjectId);
      } catch {
        /* no storage */
      }
      return;
    }
    if (s.project !== prev.project) scheduleProjectSave(s.project);
    if (s.assets !== prev.assets) void syncAssets(s.assets, prev.assets, s.currentProjectId);
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
