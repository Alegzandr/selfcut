import { useStore } from '../store/store';
import { SaveCanceledError } from '../lib/projectFile';
import { cuesFromProject, saveSubtitleFile, subtitleFileName } from '../lib/subtitleExport';
import { t } from '../i18n';

/**
 * Export of the project's cues, one level above the file plumbing - the mirror
 * of the import path, and reachable from the same two places: the File menu and
 * the subtitles pane.
 *
 * Not async, same as `saveProject` and `exportClipPreset`: the save picker needs
 * transient user activation, which does not survive an await, so this must be
 * called straight from the click handler.
 */
export function exportSubtitles(): void {
  const { project } = useStore.getState();
  const cues = cuesFromProject(project);
  if (cues.length === 0) {
    useStore.getState().setError(t('errors.subtitles.empty'));
    return;
  }

  void saveSubtitleFile(cues, subtitleFileName(project.name, 'srt')).then(
    () => useStore.getState().setNotice(t('subtitles.exported', { count: cues.length })),
    (err: unknown) => {
      // Dismissing the dialog is a decision, not a failure.
      if (err instanceof SaveCanceledError) return;
      console.warn('[subtitles] export failed:', err);
      useStore.getState().setError(t('errors.subtitles.exportFailed'));
    },
  );
}
