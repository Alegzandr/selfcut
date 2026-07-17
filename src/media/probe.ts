import { CanvasSink, Input } from 'mediabunny';
import { AudioTrackInfo, MediaAsset } from '../types';
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

/** Enumerate every decodable audio track of a source, in file order. */
async function probeAudioTracks(input: Input): Promise<AudioTrackInfo[]> {
  const tracks = await input.getAudioTracks();
  const out: AudioTrackInfo[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!;
    // Skip tracks the browser can't decode - they would only fail silently
    // later. `index` is the position in the FULL list, so mediaCache can
    // re-fetch the exact track even when earlier ones were skipped.
    if (!(await track.canDecode())) continue;
    out.push({
      index: i,
      language: track.languageCode && track.languageCode !== 'und' ? track.languageCode : undefined,
      label: track.name ?? undefined,
      channels: Math.max(1, track.numberOfChannels),
    });
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
 * Result of probing a file: the asset, plus an optional non-fatal warning to
 * surface (e.g. the video codec is not decodable but the audio was kept).
 */
export interface ProbeResult {
  asset: MediaAsset;
  warning?: string;
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
export async function probeFile(file: File, reuseId?: string): Promise<ProbeResult> {
  // Still images have no decoder pipeline: rasterize once, no mediabunny input.
  if (isImageFile(file)) return { asset: await probeImageFile(file, reuseId) };

  const input = createInput(file);
  if (!(await input.canRead())) {
    input.dispose();
    throw new Error(t('errors.media.unsupportedFormat', { name: file.name }));
  }

  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTracks = await probeAudioTracks(input);
  if (!videoTrack && audioTracks.length === 0) {
    input.dispose();
    throw new Error(t('errors.media.noTrack', { name: file.name }));
  }
  const videoDecodable = videoTrack ? await videoTrack.canDecode() : false;
  if (videoTrack && !videoDecodable && audioTracks.length === 0) {
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
    hasAudio: audioTracks.length > 0,
    audioTracks,
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
