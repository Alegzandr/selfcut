import {
  Input,
  ALL_FORMATS,
  BlobSource,
  VideoSampleSink,
  AudioBufferSink,
  InputAudioTrack,
} from 'mediabunny';
import { MediaAsset } from '../types';

/**
 * Cache key for a single audio track of an asset. `undefined` means the source's
 * primary track (the historical single-track path); an explicit index addresses
 * one specific track of a multi-track source. Kept distinct so the primary and
 * "track 0" never collide.
 */
export function audioKey(assetId: string, audioTrackIndex?: number): string {
  return `${assetId}#${audioTrackIndex ?? 'p'}`;
}

/**
 * Decoding resource cache for the preview side (main thread).
 * Export uses its own Inputs inside the worker - the two pipelines share nothing.
 */

const inputs = new Map<string, Input>();

export function createInput(file: File): Input {
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
}

export function registerInput(assetId: string, input: Input): void {
  inputs.get(assetId)?.dispose();
  inputs.set(assetId, input);
}

/** Release everything cached for an asset (decoder input, audio buffers, peaks). */
export function disposeAssetResources(assetId: string): void {
  inputs.get(assetId)?.dispose();
  inputs.delete(assetId);
  // Buffers/peaks are keyed per audio track (`${assetId}#…`): drop every entry
  // belonging to this asset, whatever its track index.
  const prefix = `${assetId}#`;
  for (const key of [...audioPromises.keys()]) if (key.startsWith(prefix)) audioPromises.delete(key);
  for (const key of [...peaksPromises.keys()]) if (key.startsWith(prefix)) peaksPromises.delete(key);
}

export function getInput(asset: MediaAsset): Input {
  let input = inputs.get(asset.id);
  if (!input) {
    input = createInput(asset.file);
    inputs.set(asset.id, input);
  }
  return input;
}

/** Create a dedicated video sink (one per playback cursor, for independent iteration). */
export async function createVideoSink(asset: MediaAsset): Promise<VideoSampleSink | null> {
  const input = getInput(asset);
  const track = await input.getPrimaryVideoTrack();
  if (!track || !(await track.canDecode())) return null;
  return new VideoSampleSink(track);
}

/**
 * Resolve which source audio track to decode: an explicit `audioTrackIndex`
 * addresses one track of a multi-track file (falling back to the primary if it
 * is out of range), while `undefined` keeps the historical primary-track path.
 */
async function resolveAudioTrack(
  input: Input,
  audioTrackIndex?: number,
): Promise<InputAudioTrack | null> {
  if (audioTrackIndex == null) return input.getPrimaryAudioTrack();
  const tracks = await input.getAudioTracks();
  return tracks[audioTrackIndex] ?? (await input.getPrimaryAudioTrack());
}

const audioPromises = new Map<string, Promise<AudioBuffer | null>>();

/**
 * Decode one audio track of an asset into a single AudioBuffer (memoized per
 * track). Good enough for footage of a few minutes; documented as a v1
 * limitation. `audioTrackIndex` selects a track of a multi-track source.
 */
export function getAudioBuffer(
  asset: MediaAsset,
  audioTrackIndex?: number,
): Promise<AudioBuffer | null> {
  const key = audioKey(asset.id, audioTrackIndex);
  let promise = audioPromises.get(key);
  if (!promise) {
    promise = decodeFullAudio(asset, audioTrackIndex).catch(() => null);
    audioPromises.set(key, promise);
  }
  return promise;
}

async function decodeFullAudio(
  asset: MediaAsset,
  audioTrackIndex?: number,
): Promise<AudioBuffer | null> {
  if (!asset.hasAudio) return null;
  const input = getInput(asset);
  const track = await resolveAudioTrack(input, audioTrackIndex);
  if (!track || !(await track.canDecode())) return null;

  const sink = new AudioBufferSink(track);
  const sampleRate = track.sampleRate;
  const numberOfChannels = Math.max(1, track.numberOfChannels);
  const totalFrames = Math.ceil((asset.durationMs / 1000) * sampleRate) + sampleRate;
  const target = new AudioBuffer({ length: totalFrames, numberOfChannels, sampleRate });

  for await (const wrapped of sink.buffers()) {
    const offset = Math.round(wrapped.timestamp * sampleRate);
    if (offset < 0 || offset >= totalFrames) continue;
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const srcCh = Math.min(ch, wrapped.buffer.numberOfChannels - 1);
      const data = wrapped.buffer.getChannelData(srcCh);
      const room = totalFrames - offset;
      target.copyToChannel(room < data.length ? data.subarray(0, room) : data, ch, offset);
    }
  }
  return target;
}

/** Kick off background audio decoding (every audio track) right after import. */
export function warmAudio(asset: MediaAsset): void {
  if (asset.audioTracks.length === 0) {
    if (asset.hasAudio) void getAudioBuffer(asset);
    return;
  }
  for (const track of asset.audioTracks) void getAudioBuffer(asset, track.index);
}

const peaksPromises = new Map<string, Promise<number[] | null>>();

/** Peak resolution: 50 bins per second, enough for one bin per pixel at high zoom. */
export function expectedPeakBins(durationMs: number): number {
  return Math.round(Math.min(30000, Math.max(200, (durationMs / 1000) * 50)));
}

/** Normalized waveform peaks (0..1) across the asset's duration (memoized per track). */
export function getPeaks(
  asset: MediaAsset,
  audioTrackIndex?: number,
): Promise<number[] | null> {
  const key = audioKey(asset.id, audioTrackIndex);
  let promise = peaksPromises.get(key);
  if (!promise) {
    promise = streamPeaks(asset, audioTrackIndex).catch(() => null);
    peaksPromises.set(key, promise);
  }
  return promise;
}

/**
 * Compute peaks by streaming decoded chunks - never materializes the full
 * AudioBuffer, so hour-long footage works without a 100s-of-MB allocation.
 */
async function streamPeaks(
  asset: MediaAsset,
  audioTrackIndex?: number,
): Promise<number[] | null> {
  if (!asset.hasAudio) return null;
  const input = getInput(asset);
  const track = await resolveAudioTrack(input, audioTrackIndex);
  if (!track || !(await track.canDecode())) return null;

  const sink = new AudioBufferSink(track);
  const durationSec = asset.durationMs / 1000;
  const bins = expectedPeakBins(asset.durationMs);
  const out = new Array<number>(bins).fill(0);

  for await (const wrapped of sink.buffers()) {
    const data = wrapped.buffer.getChannelData(0);
    const sr = wrapped.buffer.sampleRate;
    // Sampling every few frames is plenty for a visual envelope.
    const stride = Math.max(1, Math.floor(((durationSec / bins) * sr) / 32));
    for (let j = 0; j < data.length; j += stride) {
      const bin = Math.floor(((wrapped.timestamp + j / sr) / durationSec) * bins);
      if (bin < 0 || bin >= bins) continue;
      const v = Math.abs(data[j]!);
      if (v > out[bin]!) out[bin] = v;
    }
  }

  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < bins; i++) out[i]! /= max;
  return out;
}
