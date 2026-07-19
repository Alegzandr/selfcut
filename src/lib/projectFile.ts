import type { AudioTrackInfo, MediaAsset, Project } from '../types';
import { APP_NAME, APP_VERSION } from '../app/config';
import { isValidProject } from './persistence';
import { missingSourceFile } from './missingSource';
import { t } from '../i18n';

/**
 * The `.selfcut` project file: a plain JSON document holding the timeline and
 * the media *metadata*, never the media bytes. Source files stay on disk where
 * the user put them - a project of a 4 GB shoot saves in a few hundred
 * kilobytes and in a few milliseconds.
 *
 * The cost is that a reopened project has no File to decode from. Each asset
 * comes back flagged `disconnected`, exactly like a restored session whose
 * files moved, and reuses the same relink path (the banner matches the picked
 * files back by name, then `reconnectAsset` re-probes them under the original
 * id so every clip stays attached). Keeping the thumbnails and the waveform
 * peaks in the file means the timeline still draws itself before relinking, so
 * the user sees their edit rather than an empty grid.
 */

const FORMAT = 'selfcut-project';
const VERSION = 1;
export const PROJECT_FILE_EXT = '.selfcut';
const PROJECT_FILE_MIME = 'application/json';

/** What we remember of a source file, and all we need to find it again. */
interface AssetSource {
  name: string;
  size: number;
  lastModified: number;
}

/** A `MediaAsset` minus its `File`, plus the fingerprint of that file. */
interface StoredAsset {
  id: string;
  kind: MediaAsset['kind'];
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  audioTracks: AudioTrackInfo[];
  thumbnails: string[];
  source: AssetSource;
}

interface ProjectFile {
  format: typeof FORMAT;
  version: number;
  /** Informational only - never parsed back, purely to make the file readable. */
  app: string;
  savedAt: string;
  project: Project;
  assets: StoredAsset[];
}

function toStored(asset: MediaAsset): StoredAsset {
  const { id, kind, durationMs, width, height, fps, hasAudio, audioTracks, thumbnails } = asset;
  return {
    id,
    kind,
    durationMs,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(fps !== undefined ? { fps } : {}),
    hasAudio,
    audioTracks,
    thumbnails,
    source: {
      name: asset.file.name,
      size: asset.file.size,
      lastModified: asset.file.lastModified,
    },
  };
}

function fromStored(stored: StoredAsset): MediaAsset {
  const { source, ...rest } = stored;
  return {
    ...rest,
    file: missingSourceFile(source.name, source.lastModified),
    disconnected: true,
  };
}

export function serializeProject(project: Project, assets: Record<string, MediaAsset>): string {
  const doc: ProjectFile = {
    format: FORMAT,
    version: VERSION,
    app: `${APP_NAME} ${APP_VERSION}`,
    savedAt: new Date().toISOString(),
    project,
    assets: Object.values(assets).map(toStored),
  };
  return JSON.stringify(doc);
}

/** Thrown with an already-translated message when a file is not a usable project. */
export class ProjectFileError extends Error {}

function isValidStoredAsset(a: unknown): a is StoredAsset {
  if (typeof a !== 'object' || a === null) return false;
  const asset = a as StoredAsset;
  return (
    typeof asset.id === 'string' &&
    typeof asset.durationMs === 'number' &&
    Array.isArray(asset.thumbnails) &&
    Array.isArray(asset.audioTracks) &&
    typeof asset.source?.name === 'string'
  );
}

/**
 * Parse a `.selfcut` document. Rejects anything that is not this format, and a
 * version from a newer build - loading a file we only half understand would
 * silently drop whatever it holds that we cannot read, and the save that
 * follows would make that loss permanent.
 */
export function parseProjectFile(text: string): { project: Project; assets: MediaAsset[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ProjectFileError(t('errors.project.invalidFile'));
  }
  const file = doc as ProjectFile;
  if (typeof doc !== 'object' || doc === null || file.format !== FORMAT) {
    throw new ProjectFileError(t('errors.project.invalidFile'));
  }
  if (typeof file.version !== 'number' || file.version > VERSION) {
    throw new ProjectFileError(t('errors.project.futureVersion'));
  }
  if (!isValidProject(file.project)) throw new ProjectFileError(t('errors.project.invalidFile'));
  const assets = Array.isArray(file.assets) ? file.assets.filter(isValidStoredAsset) : [];
  return { project: file.project, assets: assets.map(fromStored) };
}

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

/** `queryPermission` is a File System Access extension, absent from the DOM typings. */
type PermissionedHandle = FileSystemFileHandle & {
  queryPermission?: (d: { mode: 'readwrite' }) => Promise<PermissionState>;
};

/**
 * The file the project is currently bound to, so a plain Save overwrites it
 * without a dialog. Session-scoped on purpose: a handle cannot be persisted
 * without also persisting the permission grant, and silently rewriting a file
 * the user picked days ago is not something a reload should inherit.
 */
let boundHandle: FileSystemFileHandle | null = null;
let boundName: string | null = null;

/** Name of the file the project is bound to, for the title bar. Null when unsaved. */
export function boundProjectName(): string | null {
  return boundName;
}

/** Forget the current binding - called when the editor moves to another project. */
export function unbindProjectFile(): void {
  boundHandle = null;
  boundName = null;
}

function suggestedName(): string {
  return boundName ?? `project${PROJECT_FILE_EXT}`;
}

/** The user dismissed the save dialog: not an error, nothing to report. */
export class SaveCanceledError extends Error {}

/**
 * Write the project to disk.
 *
 * `saveAs` (or a first save) opens the OS dialog; a plain save reuses the bound
 * handle. The picker needs transient user activation, which does not survive
 * the first await - hence the synchronous serialization above the call, and the
 * `show(...)` reached before anything else is awaited.
 *
 * Browsers without the File System Access API (Firefox, Safari) fall back to a
 * download, which cannot overwrite: there every save produces a new file.
 */
export async function saveProjectFile(
  project: Project,
  assets: Record<string, MediaAsset>,
  saveAs: boolean,
): Promise<void> {
  const json = serializeProject(project, assets);
  const show = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;

  let handle = saveAs ? null : boundHandle;
  if (handle && !(await hasWritePermission(handle))) handle = null;

  if (!handle && show) {
    try {
      handle = await show({
        suggestedName: suggestedName(),
        types: [
          {
            description: t('project.fileType'),
            accept: { [PROJECT_FILE_MIME]: [PROJECT_FILE_EXT] },
          },
        ],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw new SaveCanceledError();
      throw err;
    }
  }

  const blob = new Blob([json], { type: PROJECT_FILE_MIME });
  if (handle) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    boundHandle = handle;
    boundName = handle.name;
    return;
  }

  downloadBlob(blob, suggestedName());
  boundName = suggestedName();
}

async function hasWritePermission(handle: FileSystemFileHandle): Promise<boolean> {
  const query = (handle as PermissionedHandle).queryPermission;
  if (!query) return true;
  try {
    return (await query.call(handle, { mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Read a picked `.selfcut` file. Binding is deliberately left to the caller,
 * once the project is actually loaded: reading is not committing, and a user
 * who backs out of the "discard your timeline?" prompt must keep the file their
 * current project was already bound to.
 */
export async function readProjectFile(
  file: File,
): Promise<{ project: Project; assets: MediaAsset[] }> {
  return parseProjectFile(await file.text());
}

/**
 * Point subsequent saves at the file a project was just opened from. Only the
 * name carries over: an `<input type="file">` yields no writable handle, so the
 * first save still goes through the dialog, pre-filled with this name.
 */
export function bindOpenedProject(name: string): void {
  boundHandle = null;
  boundName = name;
}
