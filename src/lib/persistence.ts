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
import { sweepExportScratch } from './opfs';
import { nextSaveDelay } from './saveSchedule';
import { ASSETS_STORE, FILES_STORE, PROJECT_STORE, db, requestDone, txDone } from './idb';
import { loadTranscodedAudio, pruneTranscodedAudio } from './audioCache';
import { pruneSubtitleCues } from './subtitleCache';
import { mediaKeyOf, mediaKeyOfParts } from './mediaKey';
import { missingSourceFile } from './missingSource';
import {
  activeStorageFolder,
  folderRefOf,
  getStorageFolder,
  isFolderFileRef,
  loadStorageFolder,
  readFolderFile,
  removeFolderFile,
  writeFolderFile,
  type FolderFileRef,
} from './storageFolder';
import { t } from '../i18n';
import { reportSaveFailed, reportSaveOk } from './saveHealth';

/**
 * Record a failed write. The toast fires on entering a failing streak, not once
 * per session: the banner driven by `saveHealth` is what keeps the condition
 * visible for as long as it lasts, and a failure AFTER a recovery is news
 * again rather than being swallowed by a session-wide latch.
 */
function reportSaveFailure(err: unknown): void {
  console.warn('[persistence] save failed:', err);
  if (reportSaveFailed()) useStore.getState().setError(t('errors.persistence.saveFailed'));
}

/** Record a successful write, which is what clears the warning banner. */
function reportSaveSuccess(): void {
  reportSaveOk();
}

/**
 * Project persistence in IndexedDB. The project structure and every imported
 * media file (File blobs are structured-cloneable) are saved locally, so a
 * refresh or a closed tab never loses work. Saves are incremental: the
 * project JSON is debounced, assets are written/deleted one by one as the
 * library changes.
 *
 * An asset is two records under the same id: its metadata in ASSETS_STORE and
 * its File in FILES_STORE. The split exists because the browser copies a File
 * into the database on every `put` (see FILES_STORE): the metadata changes a
 * handful of times right after import, the File only on import or relink, and
 * a 2 GB source must not be copied along with a 100 KB peaks array.
 *
 * With a storage folder chosen (lib/storageFolder.ts) the File record is a
 * `FolderFileRef` instead: the bytes are copied into that folder and the
 * database only says where. Both kinds coexist in the same store, record by
 * record, so a library imported before the folder was chosen, or while its
 * access was pending, is still whole - and can be moved over later.
 *
 * When the project JSON is actually written is decided by `saveSchedule.ts`.
 */

/**
 * The metadata record: a MediaAsset without its File, tagged with the owning
 * project's id so a project can be listed, loaded and swept independently
 * (runtime `MediaAsset` never needs the tag). `file` is still present on
 * records written before FILES_STORE existed; it is read from there until the
 * asset's next write moves it.
 */
type StoredAsset = Omit<MediaAsset, 'file'> & { projectId?: string; file?: File };

/**
 * The File on disk for each asset id, by identity.
 *
 * What decides whether a write touches FILES_STORE: an asset whose File is the
 * very object recorded here has nothing to copy, whatever else on it changed.
 * A new import, a relink and a legacy record whose File was never moved out of
 * its metadata all miss here and get their File written. Filled from the
 * library as it is read and from each write as it commits, so it never claims
 * more than the database actually holds.
 */
const persistedFiles = new Map<string, File>();

/**
 * Where each folder-backed asset's copy is, for the ids this session has seen.
 * Filled the same way as `persistedFiles`, and consulted by every removal: the
 * record alone says which file in the folder to delete.
 */
const persistedRefs = new Map<string, FolderFileRef>();

/** True while the folder is there and this session may touch it. */
function folderReachable(): FileSystemDirectoryHandle | null {
  const { handle, access } = getStorageFolder();
  return handle && access === 'granted' ? handle : null;
}

/** Delete folder copies, best-effort and after the records are gone. */
async function removeFromFolder(refs: readonly FolderFileRef[]): Promise<void> {
  const dir = refs.length > 0 ? folderReachable() : null;
  if (!dir) return;
  for (const ref of refs) await removeFolderFile(dir, ref);
}

/** What a committed file write leaves to record: see `commitWritten`. */
type WrittenFile = { id: string; file: File; ref: FolderFileRef | null };

/**
 * Queue an asset's records on `tx`, which must include ASSETS_STORE and
 * FILES_STORE. Returns what to record once the transaction commits - not
 * before, since a write that fails at commit time has written nothing.
 *
 * `ref` is the folder copy `stageFolderWrites` made for this asset, if any.
 * Without one, a File that was itself read out of the folder is recorded by
 * its own reference rather than copied over itself; any other File goes into
 * the database as before.
 */
function putAsset(
  tx: IDBTransaction,
  asset: MediaAsset,
  projectId: string,
  ref: FolderFileRef | null = null,
): WrittenFile | null {
  const { file, ...meta } = asset;
  tx.objectStore(ASSETS_STORE).put({ ...meta, projectId } satisfies StoredAsset);
  if (persistedFiles.get(asset.id) === file) return null;
  const record = ref ?? folderRefOf(file) ?? null;
  tx.objectStore(FILES_STORE).put(record ?? file, asset.id);
  return { id: asset.id, file, ref: record };
}

/**
 * Record what a committed transaction wrote. A copy the asset no longer points
 * at (a relink under another name) is deleted from the folder now: nothing
 * can bring it back, and the point of the folder is that it holds the library
 * and not its history.
 */
function commitWritten(written: readonly (WrittenFile | null)[]): void {
  const stale: FolderFileRef[] = [];
  for (const entry of written) {
    if (!entry) continue;
    persistedFiles.set(entry.id, entry.file);
    const previous = persistedRefs.get(entry.id);
    if (entry.ref) persistedRefs.set(entry.id, entry.ref);
    else persistedRefs.delete(entry.id);
    if (previous && previous.path !== entry.ref?.path) stale.push(previous);
  }
  void removeFromFolder(stale);
}

/**
 * Copies in flight, so two saves of the same asset (an import, then its peaks
 * landing seconds later while a 2 GB copy is still streaming) share one write
 * instead of racing two into the same file.
 */
const stagingWrites = new Map<string, { file: File; promise: Promise<FolderFileRef> }>();

/**
 * Copy into the storage folder every File among `assets` that has yet to be
 * persisted. Runs BEFORE the transaction that records the assets: a directory
 * write is asynchronous, and an IndexedDB transaction commits the moment
 * nothing is pending on it. Empty when the folder is not in use, or not
 * reachable right now - those Files go into the database instead.
 */
async function stageFolderWrites(assets: readonly MediaAsset[]): Promise<Map<string, FolderFileRef>> {
  const refs = new Map<string, FolderFileRef>();
  const dir = activeStorageFolder();
  if (!dir) return refs;
  for (const asset of assets) {
    const { id, file } = asset;
    if (persistedFiles.get(id) === file) continue;
    // Already the folder's own copy, or a `.selfcut` placeholder with no bytes
    // worth a file of their own.
    if (folderRefOf(file) || isMissingSource(file)) continue;
    let pending = stagingWrites.get(id);
    if (!pending || pending.file !== file) {
      const promise = writeFolderFile(dir, file, id).finally(() => {
        if (stagingWrites.get(id)?.promise === promise) stagingWrites.delete(id);
      });
      pending = { file, promise };
      stagingWrites.set(id, pending);
    }
    refs.set(id, await pending.promise);
  }
  return refs;
}

/**
 * Queue the removal of an asset's records. Returns the folder copy to delete
 * once the transaction commits, if there is one and the folder can be reached.
 * When it cannot, the reference record is deliberately left behind: the next
 * sweep that can reach the folder finds it there and deletes the file, where
 * deleting the record now would orphan the copy on disk for good.
 */
function deleteAsset(
  tx: IDBTransaction,
  id: string,
  ref: FolderFileRef | null = persistedRefs.get(id) ?? null,
): FolderFileRef | null {
  tx.objectStore(ASSETS_STORE).delete(id);
  const reachable = ref ? folderReachable() !== null : true;
  if (reachable) tx.objectStore(FILES_STORE).delete(id);
  persistedFiles.delete(id);
  persistedRefs.delete(id);
  return ref && reachable ? ref : null;
}

/**
 * Every valid asset record in the database joined with its File, on a
 * transaction that includes both stores. Records without a File anywhere (an
 * interrupted write, a hand-edited database) are dropped, like any other
 * invalid record. `getAll` on the file store is cheap: it hands back handles,
 * the bytes are only read when someone reads them.
 */
type LibraryRecord = Omit<StoredAsset, 'file'> & { stored: File | FolderFileRef };

async function readLibrary(tx: IDBTransaction): Promise<LibraryRecord[]> {
  const files = tx.objectStore(FILES_STORE);
  const [records, fileKeys, fileValues] = await Promise.all([
    requestDone(tx.objectStore(ASSETS_STORE).getAll()),
    requestDone(files.getAllKeys()),
    requestDone(files.getAll()),
  ]);
  const filesById = new Map<IDBValidKey, unknown>();
  fileKeys.forEach((key, i) => filesById.set(key, fileValues[i]));
  const out: LibraryRecord[] = [];
  for (const record of records) {
    if (!isValidStoredAsset(record)) continue;
    const { file: inline, ...meta } = record;
    const stored = filesById.get(record.id);
    if (stored instanceof File) {
      persistedFiles.set(record.id, stored);
      out.push({ ...meta, stored });
    } else if (isFolderFileRef(stored)) {
      persistedRefs.set(record.id, stored);
      out.push({ ...meta, stored });
    } else if (inline instanceof File) {
      // Written before FILES_STORE: the File rides on the record until the
      // asset's next write moves it, which `persistedFiles` not knowing this
      // id is what makes happen.
      out.push({ ...meta, stored: inline });
    }
  }
  return out;
}

/** The cache key of a record's file, without opening it. */
function storedMediaKey(stored: File | FolderFileRef): string | null {
  return stored instanceof File
    ? mediaKeyOf(stored)
    : mediaKeyOfParts(stored.size, stored.lastModified, stored.name);
}

/**
 * The File behind a record. A folder copy that cannot be opened - access not
 * granted yet, or the file gone from the folder - comes back as a placeholder,
 * so the asset restores disconnected and the banner (or a relink) can put it
 * right, exactly like a `.selfcut` project's media.
 */
async function materialize(id: string, stored: File | FolderFileRef): Promise<File> {
  if (stored instanceof File) return stored;
  const dir = folderReachable();
  const file = dir ? await readFolderFile(dir, stored) : null;
  if (!file) return missingSourceFile(stored.name, stored.lastModified);
  persistedFiles.set(id, file);
  return file;
}

/**
 * Project ids known to have a record in PROJECT_STORE.
 *
 * An asset is only reachable through its owner: the restore lists projects and
 * loads the library of one of them, and `sweepOrphanAssets` deletes anything
 * whose owner is not on disk. So a library written under a project that was
 * never recorded is not merely unreachable, it is collected at the next start -
 * and a project only got recorded when its TIMELINE changed, which importing
 * media does not do. Filling the library and reloading lost the whole import.
 *
 * Tracking what is on disk is what lets `syncAssets` write the missing owner in
 * the same transaction as the asset, so the two can never come apart.
 */
const persistedProjects = new Set<string>();

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
    isValidLanes(proj.tracks) &&
    // Absent on projects saved before precompositions existed. Each composition
    // is checked as strictly as the project's own timeline: a comp with a
    // malformed lane would render as a black layer nobody could open.
    (proj.comps === undefined ||
      (Array.isArray(proj.comps) &&
        proj.comps.every(
          (c) =>
            typeof c?.id === 'string' &&
            typeof c.name === 'string' &&
            Array.isArray(c.markers) &&
            isValidLanes(c.tracks),
        )))
  );
}

/** One stack of lanes: ids present, clips an array, every clip identifiable. */
function isValidLanes(tracks: unknown): boolean {
  return (
    Array.isArray(tracks) &&
    tracks.every(
      (tr) =>
        typeof tr?.id === 'string' &&
        Array.isArray(tr.clips) &&
        tr.clips.every((c: unknown) => typeof (c as { id?: unknown })?.id === 'string'),
    )
  );
}

function isValidStoredAsset(a: unknown): a is StoredAsset {
  if (typeof a !== 'object' || a === null) return false;
  const asset = a as StoredAsset;
  return (
    typeof asset.id === 'string' &&
    typeof asset.durationMs === 'number' &&
    Array.isArray(asset.thumbnails)
  );
}

/**
 * A persisted File can stop being readable between sessions: a browser that
 * keeps it as a reference loses it when the file is moved, renamed or deleted,
 * and one that keeps a copy can still evict it under storage pressure. Probe
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
  const tx = d.transaction([PROJECT_STORE, ASSETS_STORE, FILES_STORE], 'readonly');
  const project = await requestDone(tx.objectStore(PROJECT_STORE).get(id));
  if (!isValidProject(project)) return null;
  const records = (await readLibrary(tx)).filter((a) => a.projectId === id);
  const assets = await Promise.all(
    records.map(async ({ projectId: _owner, stored, ...meta }) => {
      const asset = migrateAsset({ ...meta, file: await materialize(meta.id, stored) } as MediaAsset);
      return {
        ...asset,
        disconnected: isMissingSource(asset.file) || !(await isFileReadable(asset.file)),
      };
    }),
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
        if (isValidStoredAsset(a) && a.projectId === undefined) {
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
  const tx = d.transaction([PROJECT_STORE, ASSETS_STORE, FILES_STORE], 'readwrite');
  tx.objectStore(PROJECT_STORE).delete(id);
  const all = await requestDone(tx.objectStore(ASSETS_STORE).getAll());
  const files = tx.objectStore(FILES_STORE);
  const doomed: FolderFileRef[] = [];
  for (const a of all) {
    if (!isValidStoredAsset(a) || a.projectId !== id) continue;
    // This project need not be the open one, so its copies are not in
    // `persistedRefs`: ask the record.
    const stored = await requestDone(files.get(a.id));
    const ref = deleteAsset(tx, a.id, isFolderFileRef(stored) ? stored : null);
    if (ref) doomed.push(ref);
  }
  await txDone(tx);
  persistedProjects.delete(id);
  await removeFromFolder(doomed);
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
    const tx = d.transaction([ASSETS_STORE, FILES_STORE], 'readwrite');
    const files = tx.objectStore(FILES_STORE);
    const [all, fileKeys, fileValues] = await Promise.all([
      requestDone(tx.objectStore(ASSETS_STORE).getAll()),
      requestDone(files.getAllKeys()),
      requestDone(files.getAll()),
    ]);
    // `getAll` on the file store hands back File handles, not bytes; the
    // values are read for the references among them, which name the copies in
    // the folder that have to go with their records.
    const refsByKey = new Map<IDBValidKey, FolderFileRef>();
    fileKeys.forEach((key, i) => {
      const value = fileValues[i];
      if (isFolderFileRef(value)) refsByKey.set(key, value);
    });
    const doomed: FolderFileRef[] = [];
    const drop = (id: string) => {
      const ref = deleteAsset(tx, id, refsByKey.get(id) ?? null);
      if (ref) doomed.push(ref);
    };
    const kept = new Set<string>();
    for (const a of all) {
      if (!isValidStoredAsset(a)) continue;
      const pid = a.projectId;
      if (pid === undefined || !validProjectIds.has(pid)) drop(a.id);
      else kept.add(a.id);
    }
    // A File whose metadata record is gone (an invalid record dropped above, or
    // a write that landed the File and lost the metadata) is unreachable and
    // the biggest thing in the database: collect it with the rest. This is
    // also where a folder copy left behind by an in-session removal (see
    // `syncAssets`) is finally deleted.
    for (const key of fileKeys) {
      if (typeof key === 'string' && !kept.has(key)) drop(key);
    }
    await txDone(tx);
    await removeFromFolder(doomed);
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
    const library = Object.values(assets);
    const refs = await stageFolderWrites(library);
    const d = await db();
    const tx = d.transaction([PROJECT_STORE, ASSETS_STORE, FILES_STORE], 'readwrite');
    tx.objectStore(PROJECT_STORE).put({ ...project, updatedAt: Date.now() }, project.id);
    const written = library.map((a) => putAsset(tx, a, currentProjectId, refs.get(a.id) ?? null));
    await txDone(tx);
    commitWritten(written);
    persistedProjects.add(project.id);
    reportSaveSuccess();
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
/** When the oldest change waiting to be written was made (see nextSaveDelay). */
let oldestPendingAt = 0;
let suspended = false;

/**
 * Stop writing to disk, permanently for this page.
 *
 * The data erase deletes the database and then reloads, and every writer here is
 * racing that: a debounced save can be mid-flight, `pagehide` flushes one more on
 * the way out, and an asset sync fires on the store update that empties the
 * library. Any one of them would recreate the database the erase just removed and
 * leave a "cleared" app holding a project again. There is no resume, by design -
 * the only thing that follows a suspend is the reload.
 */
export function suspendPersistence(): void {
  suspended = true;
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function scheduleProjectSave(project: Project): void {
  if (suspended) return;
  const now = Date.now();
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  else oldestPendingAt = now;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void writeProject(project);
  }, nextSaveDelay(now, oldestPendingAt));
}

/**
 * Write the pending debounced project save right now. Called before switching
 * projects (so the outgoing project's last edits land before its library is
 * replaced), when the tab is backgrounded, and before an export. A no-op when
 * nothing is pending.
 */
export function flushProjectSave(): void {
  if (suspended) return;
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
  if (suspended) return;
  try {
    const d = await db();
    const tx = d.transaction(PROJECT_STORE, 'readwrite');
    // Keyed by the project's own id (out-of-line), and stamped now so the browser
    // can order by "most recently edited". The editor never touches `updatedAt`.
    tx.objectStore(PROJECT_STORE).put({ ...project, updatedAt: Date.now() }, project.id);
    await txDone(tx);
    persistedProjects.add(project.id);
    reportSaveSuccess();
  } catch (err) {
    reportSaveFailure(err);
  }
}

async function syncAssets(
  next: Record<string, MediaAsset>,
  prev: Record<string, MediaAsset>,
  project: Project,
): Promise<void> {
  if (suspended) return;
  const projectId = project.id;
  // An import changes the library and nothing else, so the debounced project
  // save is never scheduled - and a library whose owner is not on disk is
  // swept at the next start. Write the owner alongside the first asset, in one
  // transaction: either both land or neither does, so media can never outlive
  // the record that makes it reachable.
  const ownerMissing = !persistedProjects.has(projectId);
  try {
    const changed = Object.entries(next)
      .filter(([id, asset]) => prev[id] !== asset)
      .map(([, asset]) => asset);
    // The bytes first, outside the transaction: see `stageFolderWrites`.
    const refs = await stageFolderWrites(changed);
    const d = await db();
    const tx = d.transaction(
      ownerMissing
        ? [PROJECT_STORE, ASSETS_STORE, FILES_STORE]
        : [ASSETS_STORE, FILES_STORE],
      'readwrite',
    );
    if (ownerMissing) {
      tx.objectStore(PROJECT_STORE).put({ ...project, updatedAt: Date.now() }, projectId);
    }
    const written = changed.map((asset) => putAsset(tx, asset, projectId, refs.get(asset.id) ?? null));
    // The asset itself goes now - the state is the library, and leaving its
    // blob behind would resurrect the card on the next hydrate. Its transcoded
    // audio stays: a removal is undoable for as long as the session lasts, and
    // orphans are swept at the next startup instead.
    for (const id of Object.keys(prev)) {
      if (id in next) continue;
      if (persistedRefs.has(id)) {
        // A folder copy stays too, and so does its record: a File read out of
        // the folder has no bytes of its own, so once the copy is deleted the
        // undo that brings the card back has nothing to save. The metadata
        // record alone is what makes the asset reachable on the next hydrate;
        // with it gone the startup sweep collects the copy.
        tx.objectStore(ASSETS_STORE).delete(id);
      } else {
        deleteAsset(tx, id);
      }
    }
    await txDone(tx);
    commitWritten(written);
    if (ownerMissing) persistedProjects.add(projectId);
    reportSaveSuccess();
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
    const stored = await readLibrary(d.transaction([ASSETS_STORE, FILES_STORE], 'readonly'));
    const keys = stored.map((asset) => storedMediaKey(asset.stored));
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

/** One step of a library move, for a progress line. */
export interface MoveProgress {
  done: number;
  total: number;
  /** The file being moved; empty once the last one has landed. */
  name: string;
}

/** What a library move managed. Failures leave the file where it was. */
export interface MoveResult {
  moved: number;
  failed: number;
}

/**
 * Every file record with its key, read in one transaction. Handles, not
 * bytes: the values are cheap until someone reads them.
 */
async function readFileRecords(): Promise<[string, unknown][]> {
  const d = await db();
  const store = d.transaction(FILES_STORE, 'readonly').objectStore(FILES_STORE);
  const [keys, values] = await Promise.all([
    requestDone(store.getAllKeys()),
    requestDone(store.getAll()),
  ]);
  const out: [string, unknown][] = [];
  keys.forEach((key, i) => {
    if (typeof key === 'string') out.push([key, values[i]]);
  });
  return out;
}

/** True for a record whose bytes sit in the database and are worth moving. */
function isBrowserHeld(value: unknown): value is File {
  return value instanceof File && !isMissingSource(value);
}

/** How many library files the browser still holds, folder or no folder. */
export async function countBrowserHeldFiles(): Promise<number> {
  try {
    return (await readFileRecords()).filter(([, value]) => isBrowserHeld(value)).length;
  } catch {
    return 0;
  }
}

/**
 * Replace one file record, provided it is still the one the move started from.
 * The asset can have been removed while its bytes were copying, and a record
 * that is gone must stay gone: the caller then deletes the copy it just made.
 */
async function swapFileRecord(
  id: string,
  stillCurrent: (value: unknown) => boolean,
  next: File | FolderFileRef,
): Promise<boolean> {
  const d = await db();
  const tx = d.transaction(FILES_STORE, 'readwrite');
  const store = tx.objectStore(FILES_STORE);
  const current = await requestDone(store.get(id));
  const keep = stillCurrent(current);
  if (keep) store.put(next, id);
  await txDone(tx);
  return keep;
}

/**
 * Move every library file into `dir`: the ones the database holds, and the
 * ones in `from`, the previous folder, when there is one that can be read.
 * Idempotent, so it doubles as the "move what is still in the browser" action
 * for a library that was partly imported while folder access was pending.
 *
 * The caller reloads the page afterwards. A File read out of IndexedDB or out
 * of the old folder is still in the editor's hands, and whether its bytes stay
 * readable once the record or the copy behind them is gone is the browser's
 * business, not a promise this code can make. The restore reads from the new
 * records and is the one path known to be right.
 */
export async function moveLibraryToFolder(
  dir: FileSystemDirectoryHandle,
  from: FileSystemDirectoryHandle | null,
  onProgress: (progress: MoveProgress) => void,
): Promise<MoveResult> {
  const pending = (await readFileRecords()).filter(
    ([, value]) => isBrowserHeld(value) || (from !== null && isFolderFileRef(value)),
  );
  const result: MoveResult = { moved: 0, failed: 0 };
  for (const [i, [id, value]] of pending.entries()) {
    const name = value instanceof File ? value.name : (value as FolderFileRef).name;
    onProgress({ done: i, total: pending.length, name });
    try {
      const source =
        value instanceof File ? value : await readFolderFile(from!, value as FolderFileRef);
      if (!source) throw new Error(`${name} is no longer in the previous folder`);
      const ref = await writeFolderFile(dir, source, id);
      const kept = await swapFileRecord(
        id,
        (current) =>
          value instanceof File
            ? current instanceof File
            : isFolderFileRef(current) && current.path === (value as FolderFileRef).path,
        ref,
      );
      if (!kept) {
        await removeFolderFile(dir, ref);
        continue;
      }
      if (isFolderFileRef(value) && from) await removeFolderFile(from, value);
      persistedRefs.set(id, ref);
      result.moved += 1;
    } catch (err) {
      console.warn('[persistence] could not move', name, 'to the storage folder:', err);
      result.failed += 1;
    }
  }
  onProgress({ done: pending.length, total: pending.length, name: '' });
  return result;
}

/**
 * The reverse: copy every folder-backed file back into the database and delete
 * the copy. A file that cannot be read (gone from the folder) is left as it
 * is, so the caller can decide whether to give the folder up with it still
 * referenced - once the folder is forgotten such an asset restores
 * disconnected, and a relink puts it right.
 */
export async function moveLibraryToBrowser(
  dir: FileSystemDirectoryHandle,
  onProgress: (progress: MoveProgress) => void,
): Promise<MoveResult> {
  const pending = (await readFileRecords()).filter((entry): entry is [string, FolderFileRef] =>
    isFolderFileRef(entry[1]),
  );
  const result: MoveResult = { moved: 0, failed: 0 };
  for (const [i, [id, ref]] of pending.entries()) {
    onProgress({ done: i, total: pending.length, name: ref.name });
    try {
      const copy = await readFolderFile(dir, ref);
      if (!copy) throw new Error(`${ref.name} is no longer in the folder`);
      // The bytes have to be the browser's own before the folder copy goes. A
      // File read out of a directory is a reference to the path, and what the
      // database keeps of one is not always a copy: an ephemeral (incognito)
      // profile keeps the reference, and the record would then die with the
      // file it points at. Draining the stream into a Blob hands the bytes to
      // the browser's blob storage - paged to disk when large, never all in
      // memory at once - which the database stores by content.
      const bytes = await new Response(copy.stream()).blob();
      const file = new File([bytes], ref.name, { type: ref.type, lastModified: ref.lastModified });
      const kept = await swapFileRecord(
        id,
        (current) => isFolderFileRef(current) && current.path === ref.path,
        file,
      );
      if (kept) await removeFolderFile(dir, ref);
      persistedRefs.delete(id);
      result.moved += 1;
    } catch (err) {
      console.warn('[persistence] could not move', ref.name, 'back into the browser:', err);
      result.failed += 1;
    }
  }
  onProgress({ done: pending.length, total: pending.length, name: '' });
  return result;
}

/**
 * Open every folder-backed asset the restore had to leave disconnected, now
 * that access has been granted. Goes through the relink path on purpose: a
 * reconnect re-probes the file and re-registers its decoder under the same id,
 * which is exactly what an asset restored on a placeholder needs.
 */
export async function reconnectFolderAssets(): Promise<void> {
  const dir = folderReachable();
  if (!dir) return;
  const s = useStore.getState();
  const pending = Object.values(s.assets).filter((a) => a.disconnected);
  if (pending.length === 0) return;
  const d = await db();
  const store = d.transaction(FILES_STORE, 'readonly').objectStore(FILES_STORE);
  const records = await Promise.all(pending.map((a) => requestDone(store.get(a.id))));
  const reconnected: MediaAsset[] = [];
  for (const [i, asset] of pending.entries()) {
    const ref = records[i];
    if (!isFolderFileRef(ref)) continue;
    const file = await readFolderFile(dir, ref);
    if (!file) continue;
    persistedRefs.set(asset.id, ref);
    await s.reconnectAsset(asset.id, file);
    const current = useStore.getState().assets[asset.id];
    if (current && current.file === file) reconnected.push(current);
  }
  // What the startup restore would have done had the files been readable then.
  void restoreTranscodedTracks(reconnected);
}

/**
 * Delete every copy the library keeps in the storage folder. Part of the data
 * erase: those copies are SelfCut's, not the user's originals, and a "delete my
 * data" that left gigabytes in a folder the user had forgotten about would be
 * the erase lying. Only the files the records name are touched.
 */
export async function deleteFolderLibrary(): Promise<void> {
  const dir = folderReachable();
  if (!dir) return;
  try {
    const refs = (await readFileRecords())
      .map(([, value]) => value)
      .filter(isFolderFileRef);
    for (const ref of refs) await removeFolderFile(dir, ref);
  } catch (err) {
    console.warn('[persistence] folder copies could not be deleted:', err);
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

  // The library as the subscription below would have first seen it, had it
  // been installed at hydrate time.
  let hydratedAssets = useStore.getState().assets;
  try {
    // Before the restore: whether a folder-backed asset can be opened, or has
    // to wait for the banner, is decided by what this answers.
    await loadStorageFolder();
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
        hydratedAssets = useStore.getState().assets;
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
  for (const id of validIds) persistedProjects.add(id);
  validIds.add(useStore.getState().currentProjectId);
  await sweepOrphanAssets(validIds);
  await pruneMediaCaches();
  // An export that streamed into private scratch storage leaves its file behind
  // on purpose: the download reads from it long after the render is done (see
  // lib/opfs.ts). Startup is where it is finally safe to reclaim.
  void sweepExportScratch();
  // Not awaited: it can prompt in some browsers, and nothing below depends on
  // the answer.
  void requestPersistentStorage();

  let lastProjectId = useStore.getState().currentProjectId;
  try {
    localStorage.setItem(CURRENT_PROJECT_KEY, lastProjectId);
  } catch {
    /* no storage - the reopened project just won't be remembered */
  }
  // Catch up on library changes made while the sweeps ran: a peaks pass over
  // a short file lands before this point, and without this its result was
  // recomputed on every start and never written - which also left a record
  // saved before FILES_STORE existed carrying its File inline for good.
  {
    const s = useStore.getState();
    if (s.assets !== hydratedAssets) void syncAssets(s.assets, hydratedAssets, s.project);
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
    if (s.assets !== prev.assets) void syncAssets(s.assets, prev.assets, s.project);
  });

  // Flush the pending debounced save when the page goes away.
  window.addEventListener('pagehide', flushProjectSave);
  // And as soon as the tab is merely hidden, which is the last moment the
  // browser reliably gives us: `pagehide` does not fire when the renderer is
  // killed under memory pressure or the process crashes, and by then the
  // transaction has no chance to commit either. Backgrounding is also when a
  // user alt-tabs away from a long export, so it is a natural save point.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushProjectSave();
  });
}
