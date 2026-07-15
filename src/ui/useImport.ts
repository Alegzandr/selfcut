import { useCallback } from 'react';
import { useStore } from '../store/store';
import { ensureAssetVisuals, probeFile } from '../media/probe';
import { isSubtitleFile, parseSubtitles } from '../lib/subtitles';
import { t } from '../i18n';

/**
 * Import a batch of files: probe metadata, register assets in the media
 * library AND append them to the timeline in order - dropping five rushes
 * gives a rough cut ready to trim, no per-asset clicking.
 */
export function useImport(): (files: Iterable<File>) => Promise<void> {
  return useCallback(async (files: Iterable<File>) => {
    const { setImporting, setError, addAsset, addClipFromAsset, addSubtitleClips } =
      useStore.getState();
    // Materialize now: a FileList is LIVE, and callers reset their input
    // (value = '') right after calling us - awaiting first would empty it.
    const list = [...files];
    setImporting(true);
    try {
      for (const file of list) {
        try {
          // Subtitle files (.srt/.vtt) become caption clips, not media assets.
          if (isSubtitleFile(file)) {
            const cues = parseSubtitles(await file.text());
            if (cues.length === 0)
              throw new Error(t('errors.media.noCues', { name: file.name }));
            addSubtitleClips(cues);
            continue;
          }
          const asset = await probeFile(file);
          addAsset(asset);
          addClipFromAsset(asset.id);
          // Peaks and the full thumbnail strip arrive in the background.
          ensureAssetVisuals(asset, useStore.getState());
        } catch (err) {
          setError(
            err instanceof Error ? err.message : t('errors.media.importFailed', { name: file.name }),
          );
        }
      }
    } finally {
      setImporting(false);
    }
  }, []);
}
