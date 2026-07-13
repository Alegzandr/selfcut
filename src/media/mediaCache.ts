import {
  Input,
  ALL_FORMATS,
  BlobSource,
  VideoSampleSink,
  AudioBufferSink,
} from 'mediabunny';
import { MediaAsset } from '../types';

/**
 * Decoding resource cache for the preview side (main thread).
 * Export uses its own Inputs inside the worker — the two pipelines share nothing.
 */

const inputs = new Map<string, Input>();

export function createInput(file: File): Input {
  return new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
}

export function registerInput(assetId: string, input: Input): void {
  inputs.get(assetId)?.dispose();
  inputs.set(assetId, input);
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

const audioPromises = new Map<string, Promise<AudioBuffer | null>>();

/**
 * Decode the full audio track of an asset into a single AudioBuffer (memoized).
 * Good enough for footage of a few minutes; documented as a v1 limitation.
 */
export function getAudioBuffer(asset: MediaAsset): Promise<AudioBuffer | null> {
  let promise = audioPromises.get(asset.id);
  if (!promise) {
    promise = decodeFullAudio(asset).catch(() => null);
    audioPromises.set(asset.id, promise);
  }
  return promise;
}

async function decodeFullAudio(asset: MediaAsset): Promise<AudioBuffer | null> {
  if (!asset.hasAudio) return null;
  const input = getInput(asset);
  const track = await input.getPrimaryAudioTrack();
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

/** Kick off background audio decoding right after import. */
export function warmAudio(asset: MediaAsset): void {
  void getAudioBuffer(asset);
}
