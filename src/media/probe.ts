import { CanvasSink } from 'mediabunny';
import { MediaAsset } from '../types';
import { uid } from '../lib/id';
import { createInput, expectedPeakBins, getInput, getPeaks, registerInput, warmAudio } from './mediaCache';
import { t } from '../i18n';

/**
 * Where computed visuals are committed. The store satisfies this structurally,
 * so probe stays a pure media module with no store dependency (the caller owns
 * the commit).
 */
export interface AssetVisualsSink {
  setAssetPeaks: (assetId: string, peaks: number[]) => void;
  setAssetThumbnails: (assetId: string, thumbnails: string[]) => void;
}

/**
 * Probe an imported file: metadata + a first quick thumbnail.
 * Throws an Error (displayable message) if the file cannot be read.
 * The full thumbnail strip and audio peaks are filled in later by
 * ensureAssetVisuals() so importing stays fast.
 *
 * `reuseId` keeps an existing asset's id (and therefore its clips) when
 * reconnecting a source whose File reference went stale between sessions.
 */
export async function probeFile(file: File, reuseId?: string): Promise<MediaAsset> {
  const input = createInput(file);
  if (!(await input.canRead())) {
    input.dispose();
    throw new Error(t('errors.media.unsupportedFormat', { name: file.name }));
  }

  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!videoTrack && !audioTrack) {
    input.dispose();
    throw new Error(t('errors.media.noTrack', { name: file.name }));
  }
  if (videoTrack && !(await videoTrack.canDecode())) {
    input.dispose();
    throw new Error(t('errors.media.undecodableVideo', { name: file.name }));
  }

  const durationMs = (await input.computeDuration()) * 1000;
  if (!isFinite(durationMs) || durationMs <= 0) {
    input.dispose();
    throw new Error(t('errors.media.invalidDuration', { name: file.name }));
  }

  const asset: MediaAsset = {
    id: reuseId ?? uid('asset'),
    file,
    kind: videoTrack ? 'video' : 'audio',
    durationMs,
    width: videoTrack ? await videoTrack.getDisplayWidth() : undefined,
    height: videoTrack ? await videoTrack.getDisplayHeight() : undefined,
    hasAudio: !!audioTrack && (await audioTrack.canDecode()),
    thumbnails: [],
  };

  registerInput(asset.id, input);

  if (videoTrack) {
    try {
      // One quick frame so the asset card shows something right away.
      asset.thumbnails = await extractThumbnails(videoTrack, asset, [
        Math.min(1, durationMs / 2000),
      ]);
    } catch {
      // Thumbnails are cosmetic: keep going without them.
    }
  }

  warmAudio(asset);
  return asset;
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
  if (asset.hasAudio && (asset.peaks?.length ?? 0) < expectedPeakBins(asset.durationMs)) {
    void getPeaks(asset).then((peaks) => {
      if (peaks) sink.setAssetPeaks(asset.id, peaks);
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
