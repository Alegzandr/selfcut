import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { countBrowserHeldFiles, type MoveProgress } from '../lib/persistence';
import {
  getStorageFolder,
  subscribeStorageFolder,
  type StorageFolderState,
} from '../lib/storageFolder';
import {
  chooseStorageFolder,
  grantStorageFolderAccess,
  moveBrowserFilesToFolder,
  revertStorageFolder,
} from './storageFolderActions';
import { Row, ROW_BUTTON_CLASS } from './preferenceRows';

/**
 * The storage-location preference: where the media library's bytes go.
 *
 * Split into a row and the notes under it because they sit on either side of
 * the other rows of the Data section, and both read the same state - which
 * folder, whether it can be used right now, whether a move is running. The
 * hook is that shared state; the two components only render it.
 */

/** The folder state as React state. */
export function useStorageFolder(): StorageFolderState {
  return useSyncExternalStore(subscribeStorageFolder, getStorageFolder, getStorageFolder);
}

export interface StorageLocationModel {
  folder: StorageFolderState;
  /** The move in flight, for the progress line. */
  progress: MoveProgress | null;
  /** Library files the browser still holds while a folder is in use. */
  browserHeld: number;
  busy: boolean;
  choose: () => void;
  revert: () => void;
  grant: () => void;
  moveRest: () => void;
}

export function useStorageLocation(): StorageLocationModel {
  const folder = useStorageFolder();
  const [progress, setProgress] = useState<MoveProgress | null>(null);
  const [browserHeld, setBrowserHeld] = useState(0);
  const busy = progress !== null || folder.moving;

  // Counted whenever the folder state changes: granting access, or finishing
  // a move, is what changes the answer.
  useEffect(() => {
    if (!folder.handle) return;
    let live = true;
    void countBrowserHeldFiles().then((n) => {
      if (live) setBrowserHeld(n);
    });
    return () => {
      live = false;
    };
  }, [folder]);

  return {
    folder,
    progress,
    browserHeld,
    busy,
    choose: () => void chooseStorageFolder(setProgress),
    revert: () => void revertStorageFolder(setProgress),
    grant: () => void grantStorageFolderAccess(),
    moveRest: () => void moveBrowserFilesToFolder(setProgress),
  };
}

/** The row itself: the current location and the buttons that change it. */
export function StorageLocationRow({ model }: { model: StorageLocationModel }) {
  const { t } = useTranslation();
  const { folder, busy, choose, revert } = model;
  return (
    <Row label={t('preferences.data.location')}>
      <div className="flex min-w-44 flex-col items-end gap-1.5">
        <span className="max-w-64 truncate text-xs text-zinc-200" title={folder.name ?? undefined}>
          {folder.name ?? t('preferences.data.location.browser')}
        </span>
        <div className="flex flex-wrap justify-end gap-1.5">
          <button type="button" disabled={busy} className={ROW_BUTTON_CLASS} onClick={choose}>
            {folder.handle
              ? t('preferences.data.location.change')
              : t('preferences.data.location.choose')}
          </button>
          {folder.handle && (
            <button type="button" disabled={busy} className={ROW_BUTTON_CLASS} onClick={revert}>
              {t('preferences.data.location.revert')}
            </button>
          )}
        </div>
      </div>
    </Row>
  );
}

const NOTE_CLASS =
  'mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-2xs leading-relaxed text-amber-100';
const NOTE_BUTTON_CLASS =
  'flex-none rounded-lg bg-amber-400/20 px-2.5 py-1 text-xs font-medium text-amber-100 hover:bg-amber-400/30';

/**
 * What the row cannot say in one line: what the folder does, how a move is
 * going, and the two conditions that need a click - access not granted since
 * the restart, and files that never made it out of the browser.
 */
export function StorageLocationNotes({ model }: { model: StorageLocationModel }) {
  const { t } = useTranslation();
  const { folder, progress, browserHeld, busy, grant, moveRest } = model;
  return (
    <>
      <p className="mt-3 text-2xs leading-relaxed text-zinc-500">
        {t('preferences.data.location.hint')}
      </p>
      {progress && (
        <p role="status" className="mt-3 text-2xs leading-relaxed text-zinc-300">
          {progress.name
            ? t('preferences.data.location.moving', {
                name: progress.name,
                done: progress.done + 1,
                total: progress.total,
              })
            : t('preferences.data.location.finishing')}
        </p>
      )}
      {folder.handle && folder.access !== 'granted' && !busy && (
        <div className={NOTE_CLASS}>
          <span className="min-w-0 flex-1">{t('preferences.data.location.needsAccess')}</span>
          <button type="button" className={NOTE_BUTTON_CLASS} onClick={grant}>
            {t('storage.folder.allow')}
          </button>
        </div>
      )}
      {folder.handle && folder.access === 'granted' && browserHeld > 0 && !busy && (
        <div className={NOTE_CLASS}>
          <span className="min-w-0 flex-1">
            {t('preferences.data.location.pending', { count: browserHeld })}
          </span>
          <button type="button" className={NOTE_BUTTON_CLASS} onClick={moveRest}>
            {t('preferences.data.location.move')}
          </button>
        </div>
      )}
    </>
  );
}
