import { useCallback } from 'react';
import { useStore } from '../store/store';
import { ensureAssetVisuals, probeFile } from '../media/probe';
import { isSubtitleFile, parseSubtitles } from '../lib/subtitles';
import { t } from '../i18n';

/** Options for a single import batch. */
export type ImportOptions = {
  /**
   * Also append every imported asset to the timeline, in order. Opt-in: an
   * import fills the media library, and what lands on the timeline stays the
   * user's call (from a card, or by dragging it over). The one exception is
   * the empty-project dropzone, which exists precisely to build a first cut.
   */
  placeOnTimeline?: boolean;
};

/**
 * Import a batch of files: probe metadata and register assets in the media
 * library. Subtitle files have no library entry - they can only ever become
 * caption clips, so they go straight to the timeline either way.
 */
export function useImport(): (files: Iterable<File>, opts?: ImportOptions) => Promise<void> {
  return useCallback(async (files: Iterable<File>, opts: ImportOptions = {}) => {
    const {
      setImporting,
      setError,
      addAsset,
      addClipFromAsset,
      addSubtitleClips,
      beginGesture,
      endGesture,
    } = useStore.getState();
    // Materialize now: a FileList is LIVE, and callers reset their input
    // (value = '') right after calling us - awaiting first would empty it.
    const list = [...files];
    setImporting(true);
    // Collect failures and report them once: successive setError calls replace
    // the toast, so a per-file report would only ever show the last failure.
    const failures: string[] = [];
    try {
      for (const file of list) {
        try {
          // Subtitle files (.srt/.vtt) become caption clips, not media assets.
          if (isSubtitleFile(file)) {
            const cues = parseSubtitles(await file.text());
            if (cues.length === 0) throw new Error(t('errors.media.noCues', { name: file.name }));
            addSubtitleClips(cues);
            continue;
          }
          const { asset, warning } = await probeFile(file);
          // Library entry + timeline clips are one undo step: a Ctrl+Z right
          // after an import takes the whole file back out, card included.
          beginGesture();
          try {
            addAsset(asset);
            if (opts.placeOnTimeline) addClipFromAsset(asset.id);
          } finally {
            // An open gesture swallows every later edit's history entry.
            endGesture();
          }
          // Peaks and the full thumbnail strip arrive in the background.
          ensureAssetVisuals(asset, useStore.getState());
          // Partial import (e.g. undecodable video codec, audio kept): the
          // file landed, but the user must know what was left out.
          if (warning) setError(warning);
        } catch (err) {
          failures.push(
            err instanceof Error
              ? err.message
              : t('errors.media.importFailed', { name: file.name }),
          );
        }
      }
    } finally {
      setImporting(false);
      if (failures.length > 0) setError(failures.join('\n'));
    }
  }, []);
}
