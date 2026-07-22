import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { audioKey, disposeAssetResources, setTranscodedAudio } from '../../media/mediaCache';
import { ensureAssetVisuals, probeFile } from '../../media/probe';
import { FFmpegCanceled, type FFmpegProgress } from '../../media/ffmpeg';
import { decodeCachedAudio, transcodeAudioTrack } from '../../media/transcodeAudio';
import { extractSubtitleTracks, subtitleKey } from '../../media/extractSubtitles';
import { loadTranscodedAudio, saveTranscodedAudio } from '../../lib/audioCache';
import { loadSubtitleCues, saveSubtitleCues } from '../../lib/subtitleCache';
import type { SubtitleCue } from '../../lib/subtitles';
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
  | 'setImportStatus'
  | 'transcodeAudioTrack'
  | 'cancelTranscode'
  | 'importSubtitleTrack'
  | 'importSubtitleTracks'
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

    setImportStatus: (msg) => set({ importStatus: msg }),

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

      /**
       * Make the track audible, wherever its audio came from. Answers false if
       * the asset went away while this was being produced.
       */
      const publish = (buffer: AudioBuffer): boolean => {
        // The asset can have been removed (or the file reconnected) during a
        // job that runs for minutes: committing then would resurrect it. Keyed
        // on the file, since background thumbnails/peaks respread the object
        // and an identity check would discard a finished transcode.
        const current = get().assets[assetId];
        if (!current || current.file !== asset.file) return false;

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
        // have at drop time. Footage still library-only lands whole instead:
        // the track counts as playable from the commit above, so the picture
        // arrives with every audible lane, this one included. Transcoding is
        // the user saying they want that sound - handing them a silent library
        // card and a second click to place it is not the ask.
        const placed = get().project.tracks.some((tr) =>
          tr.clips.some((c) => c.assetId === assetId),
        );
        if (placed) get().attachAudioTrack(assetId, audioTrackIndex);
        else get().addClipFromAsset(assetId);
        return true;
      };

      try {
        // The disk first, always. The startup restore only reaches tracks the
        // library held at hydrate time, which leaves out every way a file can
        // arrive later - re-imported after a removal, relinked, opened in a
        // second project - and each of those would otherwise pay minutes for
        // audio already sitting in IndexedDB. Cheap to be wrong about: a miss
        // is one indexed read before the work that was going to happen anyway.
        const cached = await loadTranscodedAudio(asset.file, audioTrackIndex);
        if (cached) {
          // Decoding is not interruptible and reports nothing, so say what is
          // happening rather than leave the card on 'queued'.
          setProgress(set, get, key, { phase: 'decoding', ratio: null });
          const buffer = await decodeCachedAudio(cached);
          // A cached copy that will not decode is not an error: the browser
          // reading it need not be the one that wrote it, and AAC leans on
          // system codecs. Fall through and transcode, as before the cache.
          if (buffer && !controller.signal.aborted) {
            // No 'ready' notice here. That toast exists because a transcode
            // runs long enough for the user to have looked away; this took a
            // second, and they are still looking at the card it changed.
            publish(buffer);
            return;
          }
        }
        if (controller.signal.aborted) throw new FFmpegCanceled();

        const { buffer, compressed } = await transcodeAudioTrack(asset, audioTrackIndex, {
          signal: controller.signal,
          onProgress: (progress) => setProgress(set, get, key, progress),
        });
        if (!publish(buffer)) return;
        // Keep the compressed copy so reopening the project does not re-run
        // this. Not awaited: the track is already audible, and a full disk must
        // not turn a successful transcode into a failed one.
        if (compressed) void saveTranscodedAudio(asset.file, audioTrackIndex, compressed);
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

    importSubtitleTrack: (assetId, subtitleTrackIndex) =>
      get().importSubtitleTracks(assetId, [subtitleTrackIndex]),

    importSubtitleTracks: async (assetId, subtitleTrackIndexes) => {
      const asset = get().assets[assetId];
      if (!asset) return;
      // A bitmap track has no text to extract: the UI never offers it, and a
      // command path must not be able to route around that. Same for a track
      // already being extracted - asking twice must not queue a second read.
      const tracks = (asset.subtitleTracks ?? []).filter(
        (tr) =>
          subtitleTrackIndexes.includes(tr.index) &&
          !tr.bitmap &&
          !(subtitleKey(assetId, tr.index) in get().transcodes),
      );
      if (tracks.length === 0) return;
      const indexes = tracks.map((tr) => tr.index);
      const keys = indexes.map((i) => subtitleKey(assetId, i));

      // One job, so one controller: cancelling any of the tracks it covers
      // cancels the pass, which is the only thing there is to cancel.
      const controller = new AbortController();
      for (const key of keys) {
        controllers.set(key, controller);
        setProgress(set, get, key, { phase: 'queued', ratio: null });
      }
      // A batch reports one progress for the whole pass: it IS one pass.
      const report = (progress: FFmpegProgress) => {
        for (const key of keys) setProgress(set, get, key, progress);
      };
      try {
        // Whatever the disk already holds, so an extraction only ever covers
        // what is genuinely missing. This matters more here than for audio: an
        // exec demuxes the container end to end, so re-pulling one track of a
        // disc rip reads several GB for a few hundred kB of text - and until
        // this cache existed, every repeat import paid it in full.
        const byTrack = new Map<number, SubtitleCue[]>();
        for (const index of indexes) {
          const cues = await loadSubtitleCues(asset.file, index);
          if (cues) byTrack.set(index, cues);
        }
        const missing = indexes.filter((i) => !byTrack.has(i));
        if (missing.length > 0) {
          const extracted = await extractSubtitleTracks(asset, missing, {
            signal: controller.signal,
            onProgress: report,
          });
          for (const [index, cues] of extracted) {
            byTrack.set(index, cues);
            // Cached even when empty: "the track decoded fine and held nothing"
            // is an answer worth keeping, and re-reading gigabytes to learn it
            // again is precisely what this avoids. Not awaited - the captions
            // are already on their way to the timeline.
            void saveSubtitleCues(asset.file, index, cues);
          }
        }
        // The asset can have been removed (or its file reconnected) during a job
        // that runs for a while: the cues would belong to a source that is gone.
        // Compare the FILE, not the object: thumbnails and peaks landing in the
        // background respread the asset, and an identity check would throw away
        // a perfectly good extraction.
        const current = get().assets[assetId];
        if (!current || current.file !== asset.file) return;

        const cueLists = indexes
          .map((i) => byTrack.get(i))
          .filter((cues): cues is NonNullable<typeof cues> => !!cues && cues.length > 0);
        if (cueLists.length === 0) {
          get().setError(t('errors.media.noCues', { name: asset.file.name }));
          return;
        }
        // Captions over nothing are not an edit. When the footage they were
        // pulled out of is still library-only, it lands on the timeline first
        // so the caption track has the picture it belongs to underneath it.
        const onTimeline = get().project.tracks.some((tr) =>
          tr.clips.some((c) => c.assetId === assetId),
        );
        // Footage + captions are one undo step, and so are several tracks
        // imported together: a Ctrl+Z takes back the whole import.
        get().beginGesture();
        if (!onTimeline) get().addClipFromAsset(assetId);
        // From here on an embedded track is indistinguishable from an imported
        // .srt: same cues, same parser, same caption track.
        for (const cues of cueLists) get().addSubtitleClips(cues, assetId);
        get().endGesture();
        const count = cueLists.reduce((n, cues) => n + cues.length, 0);
        get().setNotice(t('library.subtitles.ready', { count }));
      } catch (err) {
        if (!(err instanceof FFmpegCanceled)) {
          // The toast says what failed, in the user's terms; the console keeps
          // why, since a codec the core cannot handle looks like a plain failure.
          console.error('subtitle extraction failed', err);
          get().setError(
            t('errors.media.subtitleFailed', {
              name: asset.file.name,
              codec: tracks[0]?.codec ?? '?',
            }),
          );
        }
      } finally {
        for (const key of keys) {
          controllers.delete(key);
          clearProgress(set, get, key);
        }
      }
    },

    cancelSubtitleImport: (assetId, subtitleTrackIndex) => {
      controllers.get(subtitleKey(assetId, subtitleTrackIndex))?.abort();
    },
  };
}
