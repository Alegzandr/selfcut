import type { Clip, MediaAsset } from '../types';
import { LoudnessMeter, type LoudnessResult } from '../lib/loudness';
import { segmentIndexes } from './audioSegments';
import { getAudioSegment } from './mediaCache';

/**
 * The integrated loudness of what one clip plays: its source track over its
 * own in/out points, before its volume, fades and effects.
 *
 * Measured from the same decoded segments the preview and the export read,
 * one at a time and in order. Sequential on purpose: a clip that spans an hour
 * of source would otherwise ask for 120 segments at once, blow through the
 * decoded-audio budget and have the cache evict what it was about to read.
 * Asked for one by one, each segment is metered while the next decodes and
 * may be dropped the moment it has been read.
 *
 * Trimmed to the sample: the gate would otherwise count the silence (or the
 * neighbour's speech) just outside the cut, and a one-word clip cut out of a
 * 30 s segment would measure the segment.
 *
 * Null when nothing of the range could be decoded (an undecodable track, a
 * disconnected file, a range past the end of the source).
 */
export async function measureClipLoudness(
  asset: MediaAsset,
  clip: Clip,
  signal?: AbortSignal,
): Promise<LoudnessResult | null> {
  const fromMs = clip.sourceInMs;
  const toMs = Math.min(clip.sourceOutMs, asset.durationMs || clip.sourceOutMs);
  if (!(toMs > fromMs)) return null;

  let meter: LoudnessMeter | null = null;
  for (const index of segmentIndexes(fromMs, toMs)) {
    if (signal?.aborted) return null;
    const segment = await getAudioSegment(asset, clip.audioTrackIndex, index).catch(() => null);
    if (!segment) continue;
    const { buffer } = segment;
    // Every segment of one track shares its format, so the meter is built from
    // the first one that arrives.
    meter ??= new LoudnessMeter(buffer.sampleRate, buffer.numberOfChannels);
    const first = Math.max(0, Math.round(((fromMs - segment.startMs) / 1000) * buffer.sampleRate));
    const last = Math.min(
      buffer.length,
      Math.round(((toMs - segment.startMs) / 1000) * buffer.sampleRate),
    );
    if (last <= first) continue;
    const channels: Float32Array[] = [];
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      channels.push(buffer.getChannelData(ch).subarray(first, last));
    }
    meter.process(channels);
  }
  return meter ? meter.result() : null;
}
