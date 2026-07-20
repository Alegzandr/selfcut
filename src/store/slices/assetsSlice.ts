import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { audioKey, disposeAssetResources, setTranscodedAudio } from '../../media/mediaCache';
import { ensureAssetVisuals, probeFile } from '../../media/probe';
import { TranscodeCanceled, transcodeAudioTrack } from '../../media/transcodeAudio';
import { t } from '../../i18n';

/**
 * Abort handles of the running transcodes, keyed like `transcodes`. Kept module
 * side rather than in the store because an AbortController is not serializable
 * state and nothing renders from it.
 */
const controllers = new Map<string, AbortController>();

function setProgress(set: StoreSet, get: StoreGet, key: string, ratio: number): void {
  set({ transcodes: { ...get().transcodes, [key]: ratio } });
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
> {
  return {
    addAsset: (asset) => set({ assets: { ...get().assets, [asset.id]: asset } }),

    reconnectAsset: async (assetId, file) => {
      const existing = get().assets[assetId];
      if (!existing) return;
      try {
        // Reuse the id so the asset's clips stay linked; probe re-registers the
        // decoder input (disposing the stale one) under the same id.
        const { asset: probed, warning } = await probeFile(file, assetId);
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
        if (warning) get().setError(warning);
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
      setProgress(set, get, key, 0);
      try {
        const buffer = await transcodeAudioTrack(asset, audioTrackIndex, {
          signal: controller.signal,
          onProgress: (ratio) => setProgress(set, get, key, ratio),
        });
        // The asset can have been removed (or the file reconnected) during a
        // job that runs for minutes: committing then would resurrect it.
        if (get().assets[assetId] !== asset) return;

        // Publishing to the cache is what makes the track audible: preview mix,
        // export and waveform all read from there.
        const peaks = setTranscodedAudio(assetId, audioTrackIndex, buffer, {
          alsoPrimary: asset.audioTracks.length === 1,
        });
        const audioTracks = asset.audioTracks.map((tr) =>
          tr.index === audioTrackIndex ? { ...tr, transcoded: true, peaks } : tr,
        );
        set({
          assets: {
            ...get().assets,
            [assetId]: { ...asset, audioTracks, hasAudio: true },
          },
        });
        // A clip already sitting on the timeline gains the lane it could not
        // have at drop time.
        get().attachAudioTrack(assetId, audioTrackIndex);
      } catch (err) {
        if (!(err instanceof TranscodeCanceled)) {
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
  };
}
