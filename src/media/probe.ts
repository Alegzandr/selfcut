import { CanvasSink, Input } from 'mediabunny';
import { AudioTrackInfo, MediaAsset, isTrackPlayable } from '../types';
import { uid } from '../lib/id';
import { IMAGE_CLIP_DEFAULT_MS } from '../app/config';
import {
  createInput,
  expectedPeakBins,
  getInput,
  getPeaks,
  registerInput,
  resetStillFrame,
  warmAudio,
} from './mediaCache';
import { decodeImageFile, isImageFile } from './stillImage';
import { detectSubtitleTracks } from './containerSubtitles';
import { remuxUnreadableContainer } from './remuxContainer';
import { FFmpegLoadFailed, type FFmpegProgress } from './ffmpeg';
import { t } from '../i18n';

/**
 * Where computed visuals are committed. The store satisfies this structurally,
 * so probe stays a pure media module with no store dependency (the caller owns
 * the commit). Peaks are committed per audio track (`audioTrackIndex`).
 */
export interface AssetVisualsSink {
  setAssetPeaks: (assetId: string, audioTrackIndex: number, peaks: number[]) => void;
  setAssetThumbnails: (assetId: string, thumbnails: string[]) => void;
}

/**
 * Enumerate every audio track of a source, in file order.
 *
 * Tracks the browser cannot decode (E-AC-3, AC-3, DTS - common in MKV rips) are
 * kept and flagged rather than dropped: they carry real sound the user can bring
 * in through an on-demand transcode, and listing them is what lets the UI offer
 * that. `index` is the position in the FULL list, so mediaCache always re-fetches
 * the exact track.
 */
async function probeAudioTracks(input: Input): Promise<AudioTrackInfo[]> {
  const tracks = await input.getAudioTracks();
  const out: AudioTrackInfo[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!;
    const decodable = await track.canDecode();
    out.push({
      index: i,
      language: track.languageCode && track.languageCode !== 'und' ? track.languageCode : undefined,
      label: track.name ?? undefined,
      channels: Math.max(1, track.numberOfChannels),
      ...(track.codec ? { codec: track.codec } : {}),
      ...(decodable ? {} : { undecodable: true as const }),
    });
  }
  return out;
}

/** Codecs of the tracks no browser can decode, deduped, in file order. */
function undecodableCodecs(tracks: AudioTrackInfo[]): string[] {
  const out: string[] = [];
  for (const track of tracks) {
    if (!track.undecodable) continue;
    const codec = track.codec ?? '?';
    if (!out.includes(codec)) out.push(codec);
  }
  return out;
}

/**
 * Estimate a video track's average frame rate. `computePacketStats` scans only a
 * bounded prefix of packets for a fast, accurate estimate without reading the
 * whole file; any failure degrades to "unknown" (undefined) rather than blocking
 * the import.
 */
async function probeFrameRate(
  videoTrack: NonNullable<Awaited<ReturnType<Input['getPrimaryVideoTrack']>>>,
): Promise<number | undefined> {
  try {
    const { averagePacketRate } = await videoTrack.computePacketStats(120);
    return isFinite(averagePacketRate) && averagePacketRate > 0 ? averagePacketRate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Result of probing a file: the asset, plus what to tell the user about it.
 *
 * The two channels are deliberately separate. A `warning` is a degradation, so
 * something the file carries did not make it in. A `notice` is the opposite: the
 * import went fine and there is simply more available on request. Advanced audio
 * codecs belong in the second, since the app can in fact play them - reporting
 * them in red would claim a failure where there is a capability.
 */
export interface ProbeResult {
  asset: MediaAsset;
  warning?: string;
  notice?: string;
}

export interface ProbeOptions {
  /**
   * Reported while an unreadable container is being remuxed - the one part of a
   * probe that is not instant (it pulls the ffmpeg core and reads the whole
   * file). Absent everywhere else: probing a readable file is a handful of reads.
   */
  onRemuxProgress?: (progress: FFmpegProgress) => void;
}

/**
 * Probe an imported file: metadata + a first quick thumbnail.
 * Throws an Error (displayable message) if the file cannot be read.
 * The full thumbnail strip and audio peaks are filled in later by
 * ensureAssetVisuals() so importing stays fast.
 *
 * Degrades instead of rejecting whenever something usable remains: a file
 * whose video codec the browser cannot decode still imports as audio-only
 * when it carries decodable audio (with a warning naming the codec).
 *
 * `reuseId` keeps an existing asset's id (and therefore its clips) when
 * reconnecting a source whose File reference went stale between sessions.
 */
export async function probeFile(
  file: File,
  reuseId?: string,
  { onRemuxProgress }: ProbeOptions = {},
): Promise<ProbeResult> {
  // Still images have no decoder pipeline: rasterize once, no mediabunny input.
  if (isImageFile(file)) return { asset: await probeImageFile(file, reuseId) };

  // The identity of the file the user actually picked. Captured before a remux
  // can replace `file`, and kept on the asset only when it does - so re-importing
  // the same source is recognized as a duplicate rather than remuxed afresh.
  let originalSource: MediaAsset['originalSource'];

  let input = createInput(file);
  if (!(await input.canRead())) {
    input.dispose();
    const source = { name: file.name, size: file.size, lastModified: file.lastModified };
    // mediabunny cannot demux this container, but ffmpeg very likely can. Remux
    // it (stream copy, no re-encode) into Matroska and probe THAT instead, so a
    // file the browser never recognized still imports whenever its actual codecs
    // are ones it can play. The remuxed blob becomes the asset's file from here
    // on - it persists directly (see persistence.ts), so a reopened project
    // reads it back without paying for the remux again.
    let remuxed: File | null;
    try {
      remuxed = await remuxUnreadableContainer(file, { onProgress: onRemuxProgress });
    } catch (err) {
      // The converter itself never came up - a different failure from an unusable
      // file, and one the user can sometimes act on (offline, or a page that is
      // not cross-origin isolated). Say so rather than blame the format.
      if (err instanceof FFmpegLoadFailed) {
        throw new Error(t('errors.media.converterUnavailable', { name: file.name }), { cause: err });
      }
      throw err;
    }
    if (!remuxed) throw new Error(t('errors.media.unsupportedFormat', { name: file.name }));
    file = remuxed;
    originalSource = source;
    input = createInput(file);
    // A remux that ffmpeg reported as successful but mediabunny still cannot read
    // is not something the pipeline can use: treat it as the unsupported file it
    // effectively is rather than carry a half-broken asset forward.
    if (!(await input.canRead())) {
      input.dispose();
      throw new Error(t('errors.media.unsupportedFormat', { name: file.name }));
    }
  }

  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTracks = await probeAudioTracks(input);
  // Header-only, so it costs a couple of reads and never blocks on a decoder.
  const subtitleTracks = await detectSubtitleTracks(file);
  const extractableSubtitles = subtitleTracks.filter((track) => !track.bitmap).length;
  const playableAudio = audioTracks.filter(isTrackPlayable);
  const skippedCodecs = undecodableCodecs(audioTracks);
  if (!videoTrack && audioTracks.length === 0) {
    input.dispose();
    throw new Error(t('errors.media.noTrack', { name: file.name }));
  }
  const videoDecodable = videoTrack ? await videoTrack.canDecode() : false;
  if (videoTrack && !videoDecodable && playableAudio.length === 0) {
    input.dispose();
    throw new Error(
      t('errors.media.undecodableVideo', { name: file.name, codec: videoTrack.codec ?? '?' }),
    );
  }
  // Undecodable picture but decodable sound: keep the audio rather than
  // rejecting the whole file (common with exotic-codec MKV/AVI-era footage).
  const decodableVideo = videoTrack && videoDecodable ? videoTrack : null;

  const durationMs = (await input.computeDuration()) * 1000;
  if (!isFinite(durationMs) || durationMs <= 0) {
    input.dispose();
    throw new Error(t('errors.media.invalidDuration', { name: file.name }));
  }

  const asset: MediaAsset = {
    id: reuseId ?? uid('asset'),
    file,
    kind: decodableVideo ? 'video' : 'audio',
    durationMs,
    width: decodableVideo ? await decodableVideo.getDisplayWidth() : undefined,
    height: decodableVideo ? await decodableVideo.getDisplayHeight() : undefined,
    fps: decodableVideo ? await probeFrameRate(decodableVideo) : undefined,
    hasAudio: playableAudio.length > 0,
    audioTracks,
    ...(subtitleTracks.length > 0 ? { subtitleTracks } : {}),
    ...(originalSource ? { originalSource } : {}),
    thumbnails: [],
  };

  registerInput(asset.id, input);

  if (decodableVideo) {
    try {
      // One quick frame so the asset card shows something right away.
      asset.thumbnails = await extractThumbnails(decodableVideo, asset, [
        Math.min(1, durationMs / 2000),
      ]);
    } catch {
      // Thumbnails are cosmetic: keep going without them.
    }
  }

  warmAudio(asset);
  return {
    asset,
    warning:
      videoTrack && !videoDecodable
        ? t('errors.media.videoAudioOnly', { name: file.name, codec: videoTrack.codec ?? '?' })
        : undefined,
    // Not a problem to report: the tracks are there and one click away. The card
    // in the library carries the actual buttons, so this only points at them.
    notice:
      [
        skippedCodecs.length > 0
          ? t('library.audio.detected', { codec: skippedCodecs.join(', ') })
          : null,
        // Only the tracks the user can actually act on: a rip whose subtitles
        // are all PGS has nothing to offer, and the card already explains why.
        extractableSubtitles > 0
          ? t('library.subtitles.detected', { count: extractableSubtitles })
          : null,
      ]
        .filter(Boolean)
        .join('\n') || undefined,
  };
}

/**
 * Probe a still image: rasterize it once for its dimensions and thumbnail.
 * The bitmap is discarded here - preview and export rasterize on demand
 * through their own caches.
 */
async function probeImageFile(file: File, reuseId?: string): Promise<MediaAsset> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await decodeImageFile(file);
  } catch {
    throw new Error(t('errors.media.unsupportedFormat', { name: file.name }));
  }
  // Reconnecting under an existing id: the cached still belongs to the stale
  // file - drop it so the preview rasterizes the new one.
  if (reuseId) resetStillFrame(reuseId);
  const asset: MediaAsset = {
    id: reuseId ?? uid('asset'),
    file,
    kind: 'image',
    durationMs: IMAGE_CLIP_DEFAULT_MS,
    width: bitmap.width,
    height: bitmap.height,
    hasAudio: false,
    audioTracks: [],
    thumbnails: [],
  };
  try {
    asset.thumbnails = [stillThumbnail(bitmap)];
  } catch {
    // Thumbnails are cosmetic: keep going without them.
  }
  bitmap.close();
  return asset;
}

/** One 160px-wide JPEG tile of the still, same shape as video thumbnails. */
function stillThumbnail(bitmap: ImageBitmap): string {
  const w = 160;
  const h = Math.max(16, Math.round((w * bitmap.height) / Math.max(1, bitmap.width)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.7);
}

/** Thumbnails to cover an asset's duration (filmstrip tiles pick the closest one). */
export function targetThumbnailCount(durationMs: number): number {
  return Math.min(32, Math.max(4, Math.ceil(durationMs / 10_000)));
}

/**
 * Kick off whatever visual data the asset is missing (audio peaks, full
 * thumbnail strip) and commit the results through `sink` when ready.
 * Called after import and after an IndexedDB restore.
 */
export function ensureAssetVisuals(asset: MediaAsset, sink: AssetVisualsSink): void {
  const wantBins = expectedPeakBins(asset.durationMs);
  for (const track of asset.audioTracks) {
    // An undecodable track has no waveform until it is transcoded, and the
    // transcode publishes its own peaks.
    if (!isTrackPlayable(track)) continue;
    if ((track.peaks?.length ?? 0) >= wantBins) continue;
    void getPeaks(asset, track.index).then((peaks) => {
      if (peaks) sink.setAssetPeaks(asset.id, track.index, peaks);
    });
  }
  if (asset.kind === 'video' && asset.thumbnails.length < targetThumbnailCount(asset.durationMs)) {
    void extractAssetThumbnails(asset).then((thumbs) => {
      if (thumbs.length) sink.setAssetThumbnails(asset.id, thumbs);
    });
  }
}

async function extractAssetThumbnails(asset: MediaAsset): Promise<string[]> {
  try {
    const track = await getInput(asset).getPrimaryVideoTrack();
    if (!track) return [];
    const count = targetThumbnailCount(asset.durationMs);
    const timestamps = Array.from(
      { length: count },
      (_, i) => ((asset.durationMs / 1000) * (i + 0.5)) / count,
    );
    return await extractThumbnails(track, asset, timestamps);
  } catch {
    return [];
  }
}

async function extractThumbnails(
  videoTrack: ConstructorParameters<typeof CanvasSink>[0],
  asset: Pick<MediaAsset, 'width' | 'height'>,
  timestamps: number[],
): Promise<string[]> {
  // Tiles are drawn at the source aspect ratio, so bake it into the thumbnail.
  const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9;
  const w = 160;
  const h = Math.max(16, Math.round(w / aspect));
  const sink = new CanvasSink(videoTrack, { width: w, height: h, fit: 'cover' });

  const out: string[] = [];
  const scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  const ctx = scratch.getContext('2d')!;

  for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
    if (!wrapped) continue;
    ctx.drawImage(wrapped.canvas as CanvasImageSource, 0, 0, w, h);
    out.push(scratch.toDataURL('image/jpeg', 0.6));
  }
  return out;
}
