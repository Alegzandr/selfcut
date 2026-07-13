import { CanvasSink } from 'mediabunny';
import { MediaAsset } from '../types';
import { uid } from '../lib/id';
import { createInput, registerInput, warmAudio } from './mediaCache';

/**
 * Probe an imported file: metadata + thumbnails.
 * Throws an Error (displayable message) if the file cannot be read.
 */
export async function probeFile(file: File): Promise<MediaAsset> {
  const input = createInput(file);
  if (!(await input.canRead())) {
    input.dispose();
    throw new Error(`Unsupported format: ${file.name}`);
  }

  const videoTrack = await input.getPrimaryVideoTrack();
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!videoTrack && !audioTrack) {
    input.dispose();
    throw new Error(`No audio or video track in ${file.name}`);
  }
  if (videoTrack && !(await videoTrack.canDecode())) {
    input.dispose();
    throw new Error(`Video codec cannot be decoded: ${file.name}`);
  }

  const durationMs = (await input.computeDuration()) * 1000;
  if (!isFinite(durationMs) || durationMs <= 0) {
    input.dispose();
    throw new Error(`Invalid duration: ${file.name}`);
  }

  const asset: MediaAsset = {
    id: uid('asset'),
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
      asset.thumbnails = await extractThumbnails(videoTrack, durationMs / 1000);
    } catch {
      // Thumbnails are cosmetic: keep going without them.
    }
  }

  warmAudio(asset);
  return asset;
}

async function extractThumbnails(
  videoTrack: ConstructorParameters<typeof CanvasSink>[0],
  durationSec: number,
): Promise<string[]> {
  const count = Math.min(8, Math.max(1, Math.ceil(durationSec / 4)));
  const sink = new CanvasSink(videoTrack, { width: 128, fit: 'cover', height: 72 });
  const timestamps = Array.from({ length: count }, (_, i) => (durationSec * (i + 0.5)) / count);

  const out: string[] = [];
  const scratch = document.createElement('canvas');
  scratch.width = 128;
  scratch.height = 72;
  const ctx = scratch.getContext('2d')!;

  for await (const wrapped of sink.canvasesAtTimestamps(timestamps)) {
    if (!wrapped) continue;
    ctx.drawImage(wrapped.canvas as CanvasImageSource, 0, 0, 128, 72);
    out.push(scratch.toDataURL('image/jpeg', 0.6));
  }
  return out;
}
