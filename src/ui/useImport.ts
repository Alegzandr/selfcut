import { useCallback } from 'react';
import { useStore } from '../store/store';
import { ensureAssetVisuals, probeFile } from '../media/probe';
import type { FFmpegProgress } from '../media/ffmpeg';
import { isSubtitleFile, parseSubtitles } from '../lib/subtitles';
import { findExistingAsset, isDetached } from './importDedup';
import { findClip } from '../store/projectOps';
import { clipEndMs } from '../model';
import { t } from '../i18n';

/**
 * A line for the import badge while an unreadable container is being remuxed.
 * The download of the 32 MB core and the conversion itself fail and progress
 * differently, so they read as different steps rather than one silent wait.
 */
function remuxStatus(name: string, progress: FFmpegProgress): string {
  if (progress.phase === 'downloading') return t('app.remux.preparing', { name });
  const pct = progress.ratio != null ? ` ${Math.round(progress.ratio * 100)}%` : '';
  return t('app.remux.converting', { name }) + pct;
}

/** Options for a single import batch. */
export type ImportOptions = {
  /**
   * Also append every imported asset to the timeline, in order. Opt-in: an
   * import fills the media library, and what lands on the timeline stays the
   * user's call (from a card, or by dragging it over). The one exception is
   * the empty-project dropzone, which exists precisely to build a first cut.
   */
  placeOnTimeline?: boolean;
  /**
   * Place at this exact spot instead of at the end of the track - a file
   * dragged from the desktop straight onto the timeline lands where it was let
   * go. A batch lays itself out end to end from there, so dropping four files
   * at once builds a sequence rather than a pile at one instant.
   * Requires `placeOnTimeline`.
   */
  at?: { ms: number; trackId?: string };
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
      setImportStatus,
      setError,
      setNotice,
      addAsset,
      addClipFromAsset,
      reconnectAsset,
      addSubtitleClips,
      beginGesture,
      endGesture,
    } = useStore.getState();
    // Materialize now: a FileList is LIVE, and callers reset their input
    // (value = '') right after calling us - awaiting first would empty it.
    const list = [...files];
    // Cursor for a positioned drop: each file starts where the previous one
    // ended, on the track it actually landed on. Reading the track back matters
    // for the new-track case - the second file has to join the track the first
    // one created instead of opening yet another one.
    let cursorMs = Math.max(0, opts.at?.ms ?? 0);
    let cursorTrackId = opts.at?.trackId;
    const place = (assetId: string) => {
      if (!opts.placeOnTimeline) return;
      if (!opts.at) {
        addClipFromAsset(assetId);
        return;
      }
      useStore.getState().addClipFromAssetAt(assetId, cursorMs, cursorTrackId);
      // Re-read: the placement just replaced the state, and it selects the clip
      // it laid down. If it cannot be found the cursor stays put and the next
      // file lands on the same instant - no worse than the old behaviour.
      const next = useStore.getState();
      const placed = next.selectedClipId ? findClip(next.project, next.selectedClipId) : null;
      if (placed) {
        cursorMs = clipEndMs(placed.clip);
        cursorTrackId = placed.track.id;
      }
    };
    setImporting(true);
    // Collect everything and report once at the end: the toast is a single slot,
    // so per-file calls would only ever leave the last one standing. The three
    // lists are ranked, not merged - a batch that lost something says so, and an
    // informational notice never gets to hide a failure.
    const failures: string[] = [];
    const warnings: string[] = [];
    const notices: string[] = [];
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
          // Already in the library: reuse that asset rather than minting a
          // second one. A detached entry gets its bytes back (relink), a live
          // one needs nothing at all - either way the id, and everything cached
          // in memory under it, survives the re-import. A file NOT in the
          // library falls through to a fresh asset and still finds its on-disk
          // caches, which key by the file rather than the id.
          const existing = findExistingAsset(useStore.getState().assets, file);
          if (existing) {
            if (isDetached(existing)) await reconnectAsset(existing.id, file);
            else notices.push(t('library.alreadyImported', { name: file.name }));
            place(existing.id);
            continue;
          }
          // An unreadable container is remuxed inside probe; that is the only
          // step slow enough to narrate. Cleared once the file is in, whichever
          // way probe returns.
          const { asset, warning, notice } = await probeFile(file, undefined, {
            onRemuxProgress: (progress) => setImportStatus(remuxStatus(file.name, progress)),
          }).finally(() => setImportStatus(null));
          // Library entry + timeline clips are one undo step: a Ctrl+Z right
          // after an import takes the whole file back out, card included.
          beginGesture();
          try {
            addAsset(asset);
            place(asset.id);
          } finally {
            // An open gesture swallows every later edit's history entry.
            endGesture();
          }
          // Peaks and the full thumbnail strip arrive in the background.
          ensureAssetVisuals(asset, useStore.getState());
          // Partial import (e.g. undecodable video codec, audio kept): the
          // file landed, but the user must know what was left out.
          if (warning) warnings.push(warning);
          // Nothing missing, just something extra on offer (advanced audio).
          if (notice) notices.push(notice);
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
      setImportStatus(null);
      const problems = [...failures, ...warnings];
      if (problems.length > 0) setError(problems.join('\n'));
      else if (notices.length > 0) setNotice([...new Set(notices)].join('\n'));
    }
  }, []);
}
