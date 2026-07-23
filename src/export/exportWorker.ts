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
  StreamTarget,
  CanvasSource,
  AudioSampleSource,
  AudioSample,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny';
import { registerAacEncoder } from '@mediabunny/aac-encoder';
import { registerMp3Encoder } from '@mediabunny/mp3-encoder';
import { Clip } from '../types';
import { isTextClip, timelineToSourceMs } from '../model';
import { drawClip, visibleVideoClips } from '../preview/compositor';
import { syncLuts } from '../preview/colorPass';
import { loadFonts } from '../lib/fonts';
import { StillFrame, type DrawableFrame } from '../media/stillImage';
import type { Mp4Preset } from './presets';
import { ExportErrorCode, ExportRequest, WorkerReply } from './protocol';

/**
 * Offline export pipeline. Iterates output frames at the preset fps, maps
 * output time to source time per clip, decodes with mediabunny sinks,
 * composites on an OffscreenCanvas and encodes through WebCodecs.
 * Never touches the preview pipeline.
 *
 * The worker is a separate bundle with no i18n instance and no knowledge of the
 * user locale: expected failures travel as an `ExportErrorCode`, translated by
 * the main thread. Unexpected ones travel as a raw diagnostic `crash` detail.
 */

/** An expected, user-facing failure - carries a code, never a message. */
class ExportError extends Error {
  constructor(readonly code: ExportErrorCode) {
    super(code);
    this.name = 'ExportError';
  }
}

/** One clip to composite into the current frame, with its decoded source frame. */
interface FrameLayer {
  clip: Clip;
  xfadeInMs: number;
  alphaMul: number;
  sample: DrawableFrame | null;
}

/**
 * Sequential frame reader for one clip.
 *
 * An export walks a clip's source time strictly forward, so frames come from a
 * `samples()` async iterator: every packet is decoded exactly once and the
 * decoder stays configured for the whole clip. `getSample()` cannot do that -
 * it spins up a fresh `VideoDecoder` and re-decodes from the preceding key
 * frame on every call, so a 2 s GOP means decoding up to 60 frames to obtain
 * one. That is the same trap `FrameCursor` documents on the preview side, and
 * it dominated render time here.
 */
class ClipReader {
  private sink: VideoSampleSink | null = null;
  private opened = false;
  private iterator: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private exhausted = false;
  private current: VideoSample | null = null;
  private lookahead: VideoSample | null = null;
  private lastSec = 0;

  constructor(
    private readonly clip: Clip,
    private readonly openSink: (clip: Clip) => Promise<VideoSampleSink | null>,
  ) {}

  /** The source frame to display at `sourceSec`, or null if nothing decodes. */
  async frameAt(sourceSec: number): Promise<VideoSample | null> {
    if (!this.opened) {
      this.opened = true;
      this.sink = await this.openSink(this.clip);
    }
    if (!this.sink) return null;
    const target = Math.max(0, sourceSec);

    // Source time normally advances with output time, but a reversed or ramped
    // speed can jump: restart the iterator rather than decode the gap.
    if (this.iterator && (target < this.lastSec || target > this.lastSec + 1)) {
      await this.stopIterator();
    }
    if (!this.iterator) {
      this.iterator = this.sink.samples(target);
      this.exhausted = false;
    }

    // Advance while the next frame still starts at or before the target; the
    // last one reached is the frame on screen at that instant.
    while (!this.exhausted) {
      if (!this.lookahead) {
        const { value, done } = await this.iterator.next();
        if (done || !value) {
          this.exhausted = true;
          break;
        }
        // Take exclusive ownership: mediabunny's iterator can close a yielded
        // sample again from its own cleanup when iteration starts past the last
        // frame. Cloning is a refcount bump and makes that stray close() a no-op.
        this.lookahead = value.clone();
        value.close();
      }
      if (this.current && this.lookahead.timestamp > target) break;
      this.current?.close();
      this.current = this.lookahead;
      this.lookahead = null;
    }

    this.lastSec = target;
    // Past the last frame of the source, the clip holds on its final frame.
    return this.current;
  }

  /** Release the iterator and every frame it still holds. */
  async close(): Promise<void> {
    await this.stopIterator();
  }

  private async stopIterator(): Promise<void> {
    this.lookahead?.close();
    this.lookahead = null;
    // Dropped too: after a seek the pre-seek frame is no longer what plays at
    // the new time, so the first sample the restarted iterator yields wins.
    this.current?.close();
    this.current = null;
    const it = this.iterator;
    this.iterator = null;
    this.exhausted = false;
    if (it) {
      try {
        await it.return(undefined);
      } catch {
        // Iterator cleanup failures are non-fatal.
      }
    }
  }
}

const worker = self as unknown as {
  postMessage(message: WorkerReply, options?: StructuredSerializeOptions): void;
  onmessage: ((e: MessageEvent<ExportRequest>) => void) | null;
};

worker.onmessage = (e) => {
  void (async () => {
    try {
      if (e.data.type === 'export') {
        if (e.data.preset.kind === 'mp3') await exportMp3(e.data);
        else await exportMp4(e.data, e.data.preset);
      }
    } catch (err) {
      worker.postMessage(
        err instanceof ExportError
          ? { type: 'error', code: err.code }
          : { type: 'crash', detail: err instanceof Error ? err.message : String(err) },
      );
    }
  })();
};

function postProgress(value: number): void {
  worker.postMessage({ type: 'progress', value: Math.min(1, Math.max(0, value)) });
}

async function exportMp4(req: ExportRequest, preset: Mp4Preset): Promise<void> {
  const { project, files, startMs, durationMs, audio } = req;
  // Register the project's LUTs on this worker's colour pass, exactly as the
  // preview does, so the export grades every clip identically to what was seen.
  syncLuts(project.luts);
  // Still-image assets arrive pre-rasterized from the main thread.
  const stills = new Map<string, StillFrame>(
    Object.entries(req.stills).map(([assetId, bitmap]) => [assetId, new StillFrame(bitmap)]),
  );
  const width = preset.width;
  const height = preset.height;

  // Fail fast with a translatable message when this browser cannot encode
  // H.264 at the requested size - otherwise the failure surfaces mid-render as
  // a raw native crash string. The bitrate is part of the probe because a
  // configuration can be rejected on bitrate alone (our 4K preset asks for
  // 60 Mbps), and a geometry-only check would wave it through.
  if (!(await canEncodeVideo('avc', { width, height, bitrate: preset.videoBitrate }))) {
    throw new ExportError('videoEncoderUnsupported');
  }
  // Probe the exact configuration we are about to use, not just the codec: the
  // native AAC encoder advertises support for 'aac' in general while rejecting
  // specific parameter sets. Chrome tops out at 192 kbps for stereo 48 kHz,
  // well under the 384 kbps every MP4 preset asks for, so the bare-codec check
  // left the fallback encoder unregistered and the failure only surfaced at the
  // end of the render (audio is encoded after every video frame) as a raw
  // encoder string.
  if (
    audio &&
    !(await canEncodeAudio('aac', {
      numberOfChannels: audio.channels.length,
      sampleRate: audio.sampleRate,
      bitrate: preset.audioBitrate,
    }))
  ) {
    registerAacEncoder();
  }

  const totalFrames = Math.max(1, Math.ceil((durationMs / 1000) * preset.fps));

  // Streaming straight into the user's file keeps memory flat and still puts
  // the metadata up front ('reserve' writes moov into space reserved at the
  // head, rather than buffering every chunk to place it there at the end).
  // That mode needs an upper bound on packets per track, and overshooting only
  // reserves a few unused bytes while undershooting aborts the render, so both
  // bounds below are deliberately loose.
  const writable = req.fileHandle ? await req.fileHandle.createWritable() : null;
  const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: writable ? 'reserve' : 'in-memory' }),
    target,
  });
  // One encoded packet per frame added.
  const videoPackets = totalFrames;
  // AAC-LC packs 1024 samples per packet; assume half that, plus slack for the
  // encoder's priming and flush packets.
  const audioPackets = audio ? Math.ceil(audio.channels[0]!.length / 512) + 64 : 0;

  const canvas = new OffscreenCanvas(width, height);
  // No alpha channel: every frame starts as an opaque black fill, so the canvas
  // never needs one. Dropping it skips premultiplied blending on each drawImage
  // and lets the capture go straight to YUV - measurable at 4K over thousands
  // of frames.
  const ctx = canvas.getContext('2d', { alpha: false })!;
  // High-quality resampling so every export resolution (incl. 4K downscales and
  // upscaled sources) gets the cleanest fit/crop/zoom, not the default 'low' pass.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // A worker inherits nothing from `document.fonts`: without this the canvas
  // would silently fall back to the default face and the export would not match
  // the preview. Awaited up front, since wrapping measures against the real
  // metrics from the very first frame.
  await loadFonts(
    req.project.tracks.flatMap((track) =>
      track.clips.filter(isTextClip).map((clip) => clip.text.font),
    ),
  );
  const videoSource = new CanvasSource(canvas, {
    codec: 'avc',
    bitrate: preset.videoBitrate,
    // Offline export: never trade quality for latency, and never drop frames.
    // (This is mediabunny's default, pinned here so an export stays lossless-of-
    // intent even if the library default changes.)
    latencyMode: 'quality',
    // A key frame every 2 s matches YouTube's closed-GOP recommendation and keeps
    // seeking/scrubbing responsive on the platforms without bloating the file.
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, writable ? { maximumPacketCount: videoPackets } : undefined);

  let audioSource: AudioSampleSource | null = null;
  if (audio) {
    audioSource = new AudioSampleSource({ codec: 'aac', bitrate: preset.audioBitrate });
    output.addAudioTrack(audioSource, writable ? { maximumPacketCount: audioPackets } : undefined);
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

  const openSink = async (clip: Clip): Promise<VideoSampleSink | null> => {
    const input = getInput(clip.assetId);
    if (!input) return null;
    try {
      const track = await input.getPrimaryVideoTrack();
      if (track && (await track.canDecode())) return new VideoSampleSink(track);
    } catch {
      // Unreadable source (e.g. a still that failed to rasterize): the clip
      // renders nothing rather than killing the whole export.
    }
    return null;
  };

  // One reader per clip, created on first use and kept for the whole render.
  const readers = new Map<string, ClipReader>();
  const getReader = (clip: Clip): ClipReader => {
    let reader = readers.get(clip.id);
    if (!reader) {
      reader = new ClipReader(clip, openSink);
      readers.set(clip.id, reader);
    }
    return reader;
  };

  const frameDur = 1 / preset.fps;
  const videoWeight = audio ? 0.92 : 0.98;

  let finished = false;
  // Encode of the previous frame, awaited only once the next one is decoded, so
  // the encoder runs while the decoders do. CanvasSource.add() snapshots the
  // canvas synchronously and only the returned promise is deferred, so the
  // frame it captured is never the one we are about to draw.
  let pendingEncode: Promise<void> | null = null;
  try {
    for (let i = 0; i < totalFrames; i++) {
      // Output time i/fps maps to timeline time startMs + i/fps: exporting a
      // region shifts what we read, never where the frame lands in the file.
      const tMs = startMs + (i * 1000) / preset.fps;

      // Bottom-up over tracks so the timeline's top lane paints last, then
      // earliest-first within a track: during a crossfade the incoming clip
      // composites over the outgoing one with rising alpha (same as preview).
      const layers: FrameLayer[] = [];
      for (let t = project.tracks.length - 1; t >= 0; t--) {
        const track = project.tracks[t]!;
        const alphaMul = track.opacity ?? 1;
        if (alphaMul <= 0) continue;
        for (const { clip, xfadeInMs } of visibleVideoClips(track, tMs)) {
          layers.push({ clip, xfadeInMs, alphaMul, sample: null });
        }
      }

      // Decode every visible media clip concurrently: the readers are
      // independent, so N stacked tracks cost one decode wait instead of N.
      await Promise.all(
        layers.map(async (layer) => {
          const { clip } = layer;
          if (clip.kind !== 'media') return;
          const still = stills.get(clip.assetId);
          if (still) {
            // A still is the same frame at every output time - nothing to decode.
            layer.sample = still;
            return;
          }
          layer.sample = await getReader(clip).frameAt(timelineToSourceMs(clip, tMs) / 1000);
        }),
      );

      if (pendingEncode) {
        await pendingEncode;
        pendingEncode = null;
      }

      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, width, height);
      for (const { clip, xfadeInMs, alphaMul, sample } of layers) {
        drawClip(ctx, clip, width, height, tMs, alphaMul, xfadeInMs, sample);
      }

      pendingEncode = videoSource.add(i * frameDur, frameDur);
      // Post every 5th frame, but always on the last one, so a very short
      // (<5-frame) region still advances the bar past the video phase instead
      // of jumping straight from 0 to finalize.
      if (i % 5 === 0 || i === totalFrames - 1) postProgress((i / totalFrames) * videoWeight);
    }
    await pendingEncode;
    pendingEncode = null;

    for (const reader of readers.values()) await reader.close();
    readers.clear();
    for (const still of stills.values()) still.close();
    stills.clear();
    videoSource.close();

    if (audioSource && audio) {
      await pushAudioMix(audioSource, audio, (v) => postProgress(videoWeight + v * 0.06));
      audioSource.close();
    }

    postProgress(0.99);
    await output.finalize();
    finished = true;

    postDone(target, 'video/mp4');
  } finally {
    // On any failure path, release the decoded frames and rasterized stills the
    // success path would have closed (WebCodecs frames are scarce), and always
    // dispose the source inputs. The success path already cleared these maps, so
    // this only does work when the render threw.
    if (!finished) {
      // A deferred encode still in flight would otherwise reject unhandled once
      // the render has already failed for another reason.
      pendingEncode?.catch(() => {});
      for (const reader of readers.values()) {
        try {
          await reader.close();
        } catch {
          /* already released */
        }
      }
      for (const still of stills.values()) {
        try {
          still.close();
        } catch {
          /* already closed */
        }
      }
    }
    if (!finished) {
      // Release the destination file: without this the writable stays open and
      // the user is left with a locked, half-written file.
      try {
        await output.cancel();
      } catch {
        /* already torn down */
      }
    }
    for (const input of inputs.values()) input.dispose();
  }
}

/**
 * Hand the finished file back. A buffered render transfers its ArrayBuffer
 * (zero-copy); a streamed one has already written everything to disk and only
 * reports the mime type.
 */
function postDone(target: BufferTarget | StreamTarget, mime: string): void {
  if (target instanceof BufferTarget) {
    worker.postMessage({ type: 'done', buffer: target.buffer!, mime }, { transfer: [target.buffer!] });
  } else {
    worker.postMessage({ type: 'done', buffer: null, mime });
  }
}

async function exportMp3(req: ExportRequest): Promise<void> {
  const { preset, audio } = req;
  if (!audio) throw new ExportError('noAudibleAudio');

  // Same reasoning as the AAC probe in exportMp4: the parameters are part of
  // what has to be supported, so the fallback encoder is registered whenever
  // the native one cannot take this exact configuration.
  if (
    !(await canEncodeAudio('mp3', {
      numberOfChannels: audio.channels.length,
      sampleRate: audio.sampleRate,
      bitrate: preset.audioBitrate,
    }))
  ) {
    registerMp3Encoder();
  }

  // Same destination handling as the video path, so both presets behave the
  // same way. An mp3 is small enough that memory was never the issue here - it
  // is about the file landing where the user asked for it.
  const writable = req.fileHandle ? await req.fileHandle.createWritable() : null;
  const target = writable ? new StreamTarget(writable, { chunked: true }) : new BufferTarget();
  const output = new Output({ format: new Mp3OutputFormat(), target });
  const audioSource = new AudioSampleSource({ codec: 'mp3', bitrate: preset.audioBitrate });
  output.addAudioTrack(audioSource);
  await output.start();

  let finished = false;
  try {
    await pushAudioMix(audioSource, audio, (v) => postProgress(v * 0.97));
    audioSource.close();

    await output.finalize();
    finished = true;
    postDone(target, 'audio/mpeg');
  } finally {
    if (!finished) {
      try {
        await output.cancel();
      } catch {
        /* already torn down */
      }
    }
  }
}

/** Feed the pre-rendered mix to the encoder in ~1 s planar chunks. */
async function pushAudioMix(
  source: AudioSampleSource,
  audio: NonNullable<ExportRequest['audio']>,
  onProgress: (v: number) => void,
): Promise<void> {
  const { channels, sampleRate } = audio;
  const numberOfChannels = channels.length;
  const totalFrames = channels[0]!.length;
  const chunkFrames = sampleRate;

  for (let offset = 0; offset < totalFrames; offset += chunkFrames) {
    const frames = Math.min(chunkFrames, totalFrames - offset);
    const data = new Float32Array(frames * numberOfChannels);
    for (let ch = 0; ch < numberOfChannels; ch++) {
      data.set(channels[ch]!.subarray(offset, offset + frames), ch * frames);
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
