import { useCallback } from 'react';
import { useStore } from '../store/store';
import { ensureAssetVisuals, probeFile } from '../media/probe';
import type { FFmpegProgress } from '../media/ffmpeg';
import { isSubtitleFile, parseSubtitles } from '../lib/subtitles';
import { findExistingAsset, isDetached } from './importDedup';
import { findClip } from '../store/projectOps';
import { clipEndMs } from '../model';
import i18n, { t } from '../i18n';
import {
  BATCH_NOTICE_FACTOR,
  audioCacheBudgetBytes,
  estimateAudioTracks,
  formatBytes,
  readMemoryEnv,
  trackDecodeCapBytes,
} from '../media/audioMemory';
import type { MediaAsset } from '../types';

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

/**
 * What this file's audio will cost to decode, and whether that is worth saying.
 *
 * Every source audio track is decoded into one full `AudioBuffer` (a deliberate
 * choice: instant to schedule, identical in preview and export), which is
 * ~23 MB per stereo minute. A track past the cap is a single allocation large
 * enough to fail outright, and no eviction can help - there is nothing to free
 * that makes one object fit.
 *
 * The warning therefore has to carry the remedy, not just the number: it is
 * raised at import, and the failure it predicts may land ten minutes later when
 * the clip is finally played. Someone who read "this is big" and nothing else
 * will not connect the two.
 */
function audioMemoryWarnings(
  asset: MediaAsset,
  capBytes: number,
): { lines: string[]; bytes: number } {
  const lines: string[] = [];
  let bytes = 0;
  const multiTrack = asset.audioTracks.length > 1;
  for (const track of estimateAudioTracks(asset.durationMs, asset.audioTracks)) {
    bytes += track.bytes;
    if (track.bytes <= capBytes) continue;
    const size = formatBytes(track.bytes, i18n.language);
    lines.push(
      multiTrack
        ? t('errors.audio.heavyTrack', { name: asset.file.name, track: track.index + 1, size })
        : t('errors.audio.heavy', { name: asset.file.name, size }),
    );
  }
  return { lines, bytes };
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
    // Decoded-audio budget for this machine, read once for the whole batch.
    const audioBudget = audioCacheBudgetBytes(readMemoryEnv());
    const trackCap = trackDecodeCapBytes(audioBudget);
    let audioBytes = 0;
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
          // Same rank: the file is in and usable, and something about it is
          // going to bite later if nothing is done about it.
          const audio = audioMemoryWarnings(asset, trackCap);
          warnings.push(...audio.lines);
          audioBytes += audio.bytes;
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
      // A batch well past the budget breaks nothing - the cache evicts - but it
      // will re-decode as the playhead moves between files, and a pause nobody
      // explained reads as the editor being slow.
      if (audioBytes > audioBudget * BATCH_NOTICE_FACTOR) {
        notices.push(
          t('library.audio.batchHeavy', { size: formatBytes(audioBytes, i18n.language) }),
        );
      }
      const problems = [...failures, ...warnings];
      if (problems.length > 0) setError(problems.join('\n'));
      else if (notices.length > 0) setNotice([...new Set(notices)].join('\n'));
    }
  }, []);
}
