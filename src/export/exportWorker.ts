import {
  Input,
  ALL_FORMATS,
  BlobSource,
  VideoSampleSink,
  VideoSample,
  Output,
  Mp4OutputFormat,
  Mp3OutputFormat,
  BufferTarget,
  CanvasSource,
  AudioSampleSource,
  AudioSample,
  canEncodeAudio,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { Clip, timelineToSourceMs } from '../types';
import { drawClipSample, topClipAt } from '../preview/compositor';
import { ExportRequest, WorkerReply } from './protocol';

/**
 * Offline export pipeline. Iterates output frames at the preset fps, maps
 * output time to source time per clip, decodes with mediabunny sinks,
 * composites on an OffscreenCanvas and encodes through WebCodecs.
 * Never touches the preview pipeline.
 */

const worker = self as unknown as {
  postMessage(message: WorkerReply, options?: StructuredSerializeOptions): void;
  onmessage: ((e: MessageEvent<ExportRequest>) => void) | null;
};

worker.onmessage = (e) => {
  void (async () => {
    try {
      if (e.data.type === 'export') {
        if (e.data.preset.kind === 'mp3') await exportMp3(e.data);
        else await exportMp4(e.data);
      }
    } catch (err) {
      worker.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
};

function postProgress(value: number): void {
  worker.postMessage({ type: 'progress', value: Math.min(1, Math.max(0, value)) });
}

async function exportMp4(req: ExportRequest): Promise<void> {
  const { project, preset, files, durationMs, audio } = req;
  const width = preset.width!;
  const height = preset.height!;

  if (audio && !(await canEncodeAudio('aac'))) registerAacEncoder();

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: preset.videoBitrate!,
  });
  output.addVideoTrack(videoSource);

  let audioSource: AudioSampleSource | null = null;
  if (audio) {
    audioSource = new AudioSampleSource({ codec: 'aac', bitrate: preset.audioBitrate });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  const inputs = new Map<string, Input>();
  const getInput = (assetId: string): Input | null => {
    let input = inputs.get(assetId) ?? null;
    if (!input) {
      const file = files[assetId];
      if (!file) return null;
      input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
      inputs.set(assetId, input);
    }
    return input;
  };

  // One sink per clip: source timestamps are monotonic within a clip,
  // which keeps each decoder in efficient sequential mode.
  const sinks = new Map<string, VideoSampleSink | null>();
  const getSink = async (clip: Clip): Promise<VideoSampleSink | null> => {
    if (sinks.has(clip.id)) return sinks.get(clip.id)!;
    let sink: VideoSampleSink | null = null;
    const input = getInput(clip.assetId);
    if (input) {
      const track = await input.getPrimaryVideoTrack();
      if (track && (await track.canDecode())) sink = new VideoSampleSink(track);
    }
    sinks.set(clip.id, sink);
    return sink;
  };

  // Last decoded sample per clip, reused when the sink has no newer frame.
  const lastSamples = new Map<string, VideoSample>();

  const totalFrames = Math.max(1, Math.ceil((durationMs / 1000) * preset.fps));
  const frameDur = 1 / preset.fps;
  const videoWeight = audio ? 0.92 : 0.98;

  for (let i = 0; i < totalFrames; i++) {
    const tMs = (i * 1000) / preset.fps;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    for (const track of project.tracks) {
      if (track.kind !== 'video' || track.hidden) continue;
      const clip = topClipAt(track.clips, tMs);
      if (!clip) continue;
      const sink = await getSink(clip);
      if (!sink) continue;

      const sourceSec = timelineToSourceMs(clip, tMs) / 1000;
      const sample = await sink.getSample(Math.max(0, sourceSec));
      if (sample) {
        lastSamples.get(clip.id)?.close();
        lastSamples.set(clip.id, sample);
      }
      const toDraw = sample ?? lastSamples.get(clip.id) ?? null;
      if (toDraw) drawClipSample(ctx, toDraw, clip, width, height, tMs);
    }

    await videoSource.add(i * frameDur, frameDur);
    if (i % 5 === 0) postProgress((i / totalFrames) * videoWeight);
  }

  for (const sample of lastSamples.values()) sample.close();
  videoSource.close();

  if (audioSource && audio) {
    await pushAudioMix(audioSource, audio, (v) => postProgress(videoWeight + v * 0.06));
    audioSource.close();
  }

  postProgress(0.99);
  await output.finalize();
  for (const input of inputs.values()) input.dispose();

  worker.postMessage(
    { type: 'done', buffer: target.buffer!, mime: 'video/mp4' },
    { transfer: [target.buffer!] },
  );
}

async function exportMp3(req: ExportRequest): Promise<void> {
  const { preset, audio } = req;
  if (!audio) throw new Error('Nothing to export: the project has no audible audio.');

  if (!(await canEncodeAudio('mp3'))) registerMp3Encoder();

  const target = new BufferTarget();
  const output = new Output({ format: new Mp3OutputFormat(), target });
  const audioSource = new AudioSampleSource({ codec: 'mp3', bitrate: preset.audioBitrate });
  output.addAudioTrack(audioSource);
  await output.start();

  await pushAudioMix(audioSource, audio, (v) => postProgress(v * 0.97));
  audioSource.close();

  await output.finalize();
  worker.postMessage(
    { type: 'done', buffer: target.buffer!, mime: 'audio/mpeg' },
    { transfer: [target.buffer!] },
  );
}

/** Feed the pre-rendered mix to the encoder in ~1 s planar chunks. */
async function pushAudioMix(
  source: AudioSampleSource,
  audio: NonNullable<ExportRequest['audio']>,
  onProgress: (v: number) => void,
): Promise<void> {
  const { channels, sampleRate } = audio;
  const numberOfChannels = channels.length;
  const totalFrames = channels[0].length;
  const chunkFrames = sampleRate;

  for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
    const frames = Math.min(chunkFrames, totalFrames - offset);
    const data = new Float32Array(frames * numberOfChannels);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      data.set(channels[ch].subarray(offset, offset + frames), ch * frames);
    }
    const sample = new AudioSample({
      data,
      format: 'f32-planar',
      numberOfChannels,
      sampleRate,
      timestamp: offset / sampleRate,
    });
    await source.add(sample);
    sample.close();
    onProgress(offset / totalFrames);
  }
}
