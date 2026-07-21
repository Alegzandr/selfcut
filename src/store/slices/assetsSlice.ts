import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { audioKey, disposeAssetResources, setTranscodedAudio } from '../../media/mediaCache';
import { ensureAssetVisuals, probeFile } from '../../media/probe';
import { FFmpegCanceled, type FFmpegProgress } from '../../media/ffmpeg';
import { transcodeAudioTrack } from '../../media/transcodeAudio';
import { extractSubtitleTrack, subtitleKey } from '../../media/extractSubtitles';
import { t } from '../../i18n';

/**
 * Abort handles of the running transcodes, keyed like `transcodes`. Kept module
 * side rather than in the store because an AbortController is not serializable
 * state and nothing renders from it.
 */
const controllers = new Map<string, AbortController>();

function setProgress(
  set: StoreSet,
  get: StoreGet,
  key: string,
  progress: FFmpegProgress,
): void {
  set({ transcodes: { ...get().transcodes, [key]: progress } });
}

function clearProgress(set: StoreSet, get: StoreGet, key: string): void {
  const transcodes = { ...get().transcodes };
  delete transcodes[key];
  set({ transcodes });
}

export function createAssetsSlice(
  set: StoreSet,
  get: StoreGet,
  { withHistory, pruneSelection }: SliceHelpers,
): Pick<
  EditorState,
  | 'addAsset'
  | 'removeAsset'
  | 'reconnectAsset'
  | 'setAssetPeaks'
  | 'setAssetThumbnails'
  | 'setImporting'
  | 'transcodeAudioTrack'
  | 'cancelTranscode'
  | 'importSubtitleTrack'
  | 'cancelSubtitleImport'
> {
  return {
    addAsset: (asset) => set({ assets: { ...get().assets, [asset.id]: asset } }),

    reconnectAsset: async (assetId, file) => {
      const existing = get().assets[assetId];
      if (!existing) return;
      try {
        // Reuse the id so the asset's clips stay linked; probe re-registers the
        // decoder input (disposing the stale one) under the same id.
        const { asset: probed, warning, notice } = await probeFile(file, assetId);
        // The asset may have been removed while the OS file dialog was open.
        if (!get().assets[assetId]) {
          disposeAssetResources(assetId);
          return;
        }

        // The replacement need not line up with the original: a shorter file
        // leaves clips trimmed past its end, a different kind changes what they
        // render. Warn before committing and let the user keep the original.
        const overrun = get()
          .project.tracks.flatMap((tr) => tr.clips)
          .filter((c) => c.assetId === assetId && c.sourceOutMs > probed.durationMs);
        const message =
          probed.kind !== existing.kind
            ? t('library.reconnectTypeMismatch')
            : overrun.length > 0
              ? t('library.reconnectMismatch', { count: overrun.length })
              : null;
        const accepted =
          !message ||
          (await get().requestConfirm({
            title: t('library.reconnectConfirm.title'),
            message,
            confirmLabel: t('library.reconnectConfirm.action'),
            danger: true,
          }));
        if (!accepted) {
          // Put the original file back under the id so its decoder is valid
          // again. A disconnected asset has no readable file to restore: it
          // simply stays disconnected.
          if (!existing.disconnected) {
            await probeFile(existing.file, assetId).catch(() => undefined);
          }
          return;
        }

        // Unlike the native confirm() this replaced, the dialog does not block
        // the app: the asset can have been removed while it was up.
        if (!get().assets[assetId]) {
          disposeAssetResources(assetId);
          return;
        }

        set({ assets: { ...get().assets, [assetId]: probed } });
        // Clamp what the new source can no longer cover, as one undoable step.
        if (overrun.length > 0) {
          const ids = new Set(overrun.map((c) => c.id));
          withHistory((p) => {
            for (const track of p.tracks) {
              for (const clip of track.clips) {
                if (!ids.has(clip.id)) continue;
                clip.sourceOutMs = probed.durationMs;
                // Keep a non-empty source window when the in point overran too.
                clip.sourceInMs = Math.min(clip.sourceInMs, Math.max(0, probed.durationMs - 1));
              }
            }
          });
        }
        ensureAssetVisuals(probed, get());
        // A degradation outranks an offer: both slots are the same toast.
        if (warning) get().setError(warning);
        else if (notice) get().setNotice(notice);
      } catch (err) {
        get().setError(
          err instanceof Error
            ? err.message
            : t('errors.media.importFailed', { name: file.name }),
        );
      }
    },

    setAssetPeaks: (assetId, audioTrackIndex, peaks) => {
      const asset = get().assets[assetId];
      if (!asset) return;
      // Attach the peaks to their own audio track, leaving the others untouched.
      const audioTracks = asset.audioTracks.map((tr) =>
        tr.index === audioTrackIndex ? { ...tr, peaks } : tr,
      );
      set({ assets: { ...get().assets, [assetId]: { ...asset, audioTracks } } });
    },

    setAssetThumbnails: (assetId, thumbnails) => {
      const asset = get().assets[assetId];
      if (!asset) return;
      set({ assets: { ...get().assets, [assetId]: { ...asset, thumbnails } } });
    },

    removeAsset: (assetId) => {
      withHistory((p) => {
        for (const track of p.tracks) {
          track.clips = track.clips.filter((c) => c.assetId !== assetId);
        }
      });
      const assets = { ...get().assets };
      delete assets[assetId];
      set({ assets });
      // No dispose here: the removal is undoable, and the history now holds the
      // asset - freeing its decoder would make the restored card unplayable.
      pruneSelection();
    },

    setImporting: (v) => set({ importing: v }),

    transcodeAudioTrack: async (assetId, audioTrackIndex) => {
      const asset = get().assets[assetId];
      const track = asset?.audioTracks.find((tr) => tr.index === audioTrackIndex);
      if (!asset || !track || !track.undecodable || track.transcoded) return;
      const key = audioKey(assetId, audioTrackIndex);
      if (key in get().transcodes) return;

      const controller = new AbortController();
      controllers.set(key, controller);
      // Jobs run one at a time: until the runtime reports its first phase this
      // one may just be waiting its turn, and saying 'downloading' would be a
      // lie the user reads as a stall.
      setProgress(set, get, key, { phase: 'queued', ratio: null });
      try {
        const buffer = await transcodeAudioTrack(asset, audioTrackIndex, {
          signal: controller.signal,
          onProgress: (progress) => setProgress(set, get, key, progress),
        });
        // The asset can have been removed (or the file reconnected) during a
        // job that runs for minutes: committing then would resurrect it. Keyed
        // on the file, since background thumbnails/peaks respread the object
        // and an identity check would discard a finished transcode.
        const current = get().assets[assetId];
        if (!current || current.file !== asset.file) return;

        // Publishing to the cache is what makes the track audible: preview mix,
        // export and waveform all read from there.
        const peaks = setTranscodedAudio(assetId, audioTrackIndex, buffer, {
          alsoPrimary: current.audioTracks.length === 1,
        });
        // Spread the CURRENT asset, not the captured one: anything that landed
        // during the job (thumbnails, peaks) must survive this commit.
        const audioTracks = current.audioTracks.map((tr) =>
          tr.index === audioTrackIndex ? { ...tr, transcoded: true, peaks } : tr,
        );
        set({
          assets: {
            ...get().assets,
            [assetId]: { ...current, audioTracks, hasAudio: true },
          },
        });
        // A clip already sitting on the timeline gains the lane it could not
        // have at drop time.
        get().attachAudioTrack(assetId, audioTrackIndex);
        // Long enough that the user has almost certainly looked away: say so.
        get().setNotice(t('library.audio.ready', { name: asset.file.name }));
      } catch (err) {
        if (!(err instanceof FFmpegCanceled)) {
          // The toast says what failed, in the user's terms; the console keeps
          // why. Without this the only symptom of a broken load path was a
          // sentence naming the file, which is not something anyone can act on.
          console.error('audio transcode failed', err);
          get().setError(
            t('errors.media.transcodeFailed', {
              name: asset.file.name,
              codec: track.codec ?? '?',
            }),
          );
        }
      } finally {
        controllers.delete(key);
        clearProgress(set, get, key);
      }
    },

    cancelTranscode: (assetId, audioTrackIndex) => {
      controllers.get(audioKey(assetId, audioTrackIndex))?.abort();
    },

    importSubtitleTrack: async (assetId, subtitleTrackIndex) => {
      const asset = get().assets[assetId];
      const track = asset?.subtitleTracks?.find((tr) => tr.index === subtitleTrackIndex);
      // A bitmap track has no text to extract: the UI never offers it, and a
      // command path must not be able to route around that.
      if (!asset || !track || track.bitmap) return;
      const key = subtitleKey(assetId, subtitleTrackIndex);
      if (key in get().transcodes) return;

      const controller = new AbortController();
      controllers.set(key, controller);
      setProgress(set, get, key, { phase: 'queued', ratio: null });
      try {
        const cues = await extractSubtitleTrack(asset, subtitleTrackIndex, {
          signal: controller.signal,
          onProgress: (progress) => setProgress(set, get, key, progress),
        });
        // The asset can have been removed (or its file reconnected) during a job
        // that runs for a while: the cues would belong to a source that is gone.
        // Compare the FILE, not the object: thumbnails and peaks landing in the
        // background respread the asset, and an identity check would throw away
        // a perfectly good extraction.
        const current = get().assets[assetId];
        if (!current || current.file !== asset.file) return;
        if (cues.length === 0) {
          get().setError(t('errors.media.noCues', { name: asset.file.name }));
          return;
        }
        // Captions over nothing are not an edit. When the footage they were
        // pulled out of is still library-only, it lands on the timeline first
        // so the caption track has the picture it belongs to underneath it.
        const onTimeline = get().project.tracks.some((tr) =>
          tr.clips.some((c) => c.assetId === assetId),
        );
        // Footage + captions are one undo step: a Ctrl+Z takes back the whole
        // import, not just the text.
        if (!onTimeline) {
          get().beginGesture();
          get().addClipFromAsset(assetId);
        }
        // From here on an embedded track is indistinguishable from an imported
        // .srt: same cues, same parser, same caption track.
        get().addSubtitleClips(cues, assetId);
        if (!onTimeline) get().endGesture();
        get().setNotice(t('library.subtitles.ready', { count: cues.length }));
      } catch (err) {
        if (!(err instanceof FFmpegCanceled)) {
          // The toast says what failed, in the user's terms; the console keeps
          // why, since a codec the core cannot handle looks like a plain failure.
          console.error('subtitle extraction failed', err);
          get().setError(
            t('errors.media.subtitleFailed', {
              name: asset.file.name,
              codec: track.codec ?? '?',
            }),
          );
        }
      } finally {
        controllers.delete(key);
        clearProgress(set, get, key);
      }
    },

    cancelSubtitleImport: (assetId, subtitleTrackIndex) => {
      controllers.get(subtitleKey(assetId, subtitleTrackIndex))?.abort();
    },
  };
}
