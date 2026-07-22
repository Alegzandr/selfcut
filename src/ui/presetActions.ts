import { useStore } from '../store/store';
import { SaveCanceledError } from '../lib/projectFile';
import { PresetFileError, extractPreset, type PresetLook } from '../effects/presetFile';
import { readPresetFile, savePresetFile } from '../effects/presetIo';
import { openPresetPicker } from './mediaPicker';
import { clipDurationMs } from '../model';
import { t } from '../i18n';

/**
 * Export and import of `.sfx` presets, one level above the file plumbing.
 *
 * Both the inspector and the library reach these rather than calling the I/O
 * directly, so a preset saved from one surface and a preset dropped on the other
 * report themselves with the same words.
 */

/**
 * Write the selected clip's look to a file.
 *
 * Not async by accident, same as `saveProject`: the save picker needs transient
 * user activation, which does not survive an await, so this must be called
 * straight from the click handler.
 */
export function exportClipPreset(clipId: string, name: string): void {
  const { project } = useStore.getState();
  const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clipId);
  if (!clip) return;

  const doc = extractPreset(clip, name, clipDurationMs(clip));
  if (Object.keys(doc.look).length === 0) {
    // Nothing to save is worth saying out loud: a preset file that restores
    // nothing would look like a bug the next time it was applied.
    useStore.getState().setError(t('errors.preset.empty'));
    return;
  }

  void savePresetFile(doc).then(
    () => useStore.getState().setNotice(t('preset.saved')),
    (err: unknown) => {
      // Dismissing the dialog is a decision, not a failure.
      if (err instanceof SaveCanceledError) return;
      console.warn('[preset] save failed:', err);
      useStore.getState().setError(t('errors.preset.saveFailed'));
    },
  );
}

/**
 * Pick a `.sfx` file and hand the parsed preset to the caller. Errors are
 * reported here so no caller has to translate them itself.
 */
export function importPreset(onLoaded: (name: string, look: PresetLook) => void): void {
  openPresetPicker((file) => {
    void (async () => {
      try {
        const doc = await readPresetFile(file);
        onLoaded(doc.name, doc.look);
      } catch (err) {
        useStore
          .getState()
          .setError(err instanceof PresetFileError ? err.message : t('errors.preset.invalidFile'));
      }
    })();
  });
}

/** Apply a preset to clips and report what landed, what was refused, what was trimmed. */
export function applyPresetToClips(look: PresetLook, clipIds: string[]): void {
  const s = useStore.getState();
  const { changed, truncated } = s.applyClipPreset(look, clipIds);
  if (!changed.length) {
    s.setError(t('preset.rejected'));
    return;
  }
  // Trimming is reported once for the whole batch: it is a property of the
  // preset outrunning the footage, not something to repeat per clip.
  s.setNotice(
    truncated
      ? `${t('preset.applied', { count: changed.length })} · ${t('preset.truncated')}`
      : t('preset.applied', { count: changed.length }),
  );
}
