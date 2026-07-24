import { useStore } from '../store/store';
import {
  ProjectFileError,
  SaveCanceledError,
  bindOpenedProject,
  readProjectFile,
  saveProjectFile,
} from '../lib/projectFile';
import { openProjectPicker } from './mediaPicker';
import { ensureAssetVisuals } from '../media/probe';
import { saveWholeProject } from '../lib/persistence';
import { t } from '../i18n';

/**
 * Save / open a `.selfcut` project. Shared by the menu bar and the keyboard
 * shortcuts so both paths agree on the confirmations and the error wording.
 */

/**
 * Write the project out. `saveAs` forces the OS dialog; otherwise the file the
 * project is already bound to is overwritten in place.
 *
 * Not async by accident: the save picker needs transient user activation, which
 * does not survive an await, so this must be called straight from the click or
 * keydown handler with nothing awaited in between.
 */
export function saveProject(saveAs: boolean): void {
  const { project, assets } = useStore.getState();
  void saveProjectFile(project, assets, saveAs).then(
    () => useStore.getState().setNotice(t('project.saved')),
    (err: unknown) => {
      // Dismissing the dialog is a decision, not a failure.
      if (err instanceof SaveCanceledError) return;
      console.warn('[project] save failed:', err);
      useStore.getState().setError(t('errors.project.saveFailed'));
    },
  );
}

/**
 * Confirm throwing the whole project away. Shared by File ▸ New, its mobile
 * button and the relink banner's "start over", so all three ask the same
 * question and none of them can reset the editor without one.
 */
export function confirmDiscardProject(): Promise<boolean> {
  return useStore.getState().requestConfirm({
    title: t('restore.startNewConfirm.title'),
    message: t('restore.startNewConfirm'),
    confirmLabel: t('restore.startNewConfirm.action'),
    danger: true,
  });
}

/**
 * Replace the editor contents with a project read from disk. Confirms first
 * when the current timeline is not empty: opening discards it, and the autosave
 * that follows overwrites the locally restored session too.
 */
export function openProject(): void {
  openProjectPicker((file) => {
    void (async () => {
      let loaded;
      try {
        loaded = await readProjectFile(file);
      } catch (err) {
        useStore.getState().setError(
          err instanceof ProjectFileError ? err.message : t('errors.project.invalidFile'),
        );
        return;
      }

      const hasWork = useStore
        .getState()
        .project.tracks.some((tr) => tr.clips.length > 0);
      if (
        hasWork &&
        !(await useStore.getState().requestConfirm({
          title: t('project.openConfirm.title'),
          message: t('project.openConfirm'),
          confirmLabel: t('project.openConfirm.action'),
          danger: true,
        }))
      ) {
        return;
      }

      // Re-read: the dialog was up for arbitrarily long, so the state captured
      // before it is stale.
      const s = useStore.getState();
      s.hydrate(loaded.project, loaded.assets);
      bindOpenedProject(file.name);
      // Hydrate is treated as a project switch by the persistence layer (it
      // adopts the new library without diffing), so the opened project and its
      // assets are written once, explicitly, instead of via the diff.
      void saveWholeProject();
      // Every asset arrives disconnected (the file holds no media), so there is
      // nothing to decode yet - the relink banner takes over from here. Visuals
      // are recomputed per asset as it reconnects.
      for (const asset of loaded.assets) {
        if (!asset.disconnected) ensureAssetVisuals(asset, useStore.getState());
      }
    })();
  });
}
