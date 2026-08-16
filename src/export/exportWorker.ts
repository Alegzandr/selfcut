import {
  Input,
  ALL_FORMATS,
  BufferSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
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
import { FrameRenderer } from './frameRenderer';
import { planSegments, type SegmentPlan } from './segmentPlan';
import type { SegmentReply, SegmentRequest } from './segmentProtocol';
import type { ExportVideoCodec, Mp4Preset } from './presets';
import { endFrame, endSpan, mergeSnapshots, type PerfSnapshot, setPerfEnabled, snapshot, span } from '../perf/probe';
import {
  AUDIO_CHUNK_FRAMES,
  type AudioMixInfo,
  ExportErrorCode,
  ExportRequest,
  type MainToWorker,
  WorkerReply,
} from './protocol';

/**
 * Offline export pipeline. Iterates output frames at the preset fps, maps
 * output time to source time per clip, decodes with mediabunny sinks,
 * composites on an OffscreenCanvas and encodes through WebCodecs.
 * Never touches the preview pipeline.
 *
 * Long enough renders fan out: the loop is encoder-bound (measured: 84% of
 * every frame is spent waiting for the encoder even with four encodes in
 * flight), and one encoder stays one encoder however deep its queue is. So the
 * output is cut into slices, each rendered and encoded by its own worker into a
 * standalone MP4, and this worker re-muxes the already-encoded packets into the
 * real file. Nothing is encoded twice and nothing is decoded twice.
 *
 * The worker is a separate bundle with no i18n instance and no knowledge of the
 * user locale: expected failures travel as an `ExportErrorCode`, translated by
 * the main thread. Unexpected ones travel as a raw diagnostic `crash` detail.
 */

/**
 * How many encodes may be outstanding at once in the serial path.
 *
 * Each one is a `VideoFrame` the encoder holds until it has produced a packet,
 * so this is a memory cost as much as a throughput one: at 4K that is ~12 MB
 * apiece. Four is deep enough to keep a hardware encoder fed across the jitter
 * of a decode-heavy frame, and shallow enough that the queue is never the thing
 * that runs the browser out of frames.
 */
const ENCODE_QUEUE_DEPTH = 4;

/**
 * Encoder preferences shared by every path that encodes.
 *
 * Deliberately WITHOUT `hardwareAcceleration: 'prefer-hardware'`.
 *
 * Asking for it looks free - it is documented as a hint, and a browser with no
 * hardware encoder is supposed to fall back to software silently. It is not
 * free: with `prefer-hardware` set, the "120 fps · 4K" preset stops producing a
 * file at all. The hardware encoder accepts the configuration, cannot sustain
 * 4K at 120 fps, and stalls rather than failing, so the render hangs instead of
 * degrading. Measured, reproduced, and the reason this constant does not carry
 * the line that an audit would expect it to.
 *
 * The browser's own default already picks hardware where hardware is the right
 * answer. What was actually missing was not the preference but the OBSERVATION:
 * see `reportEncoderConfig`, which sends back the configuration the browser
 * settled on.
 *
 * `contentHint: 'detail'` stays: it tells the encoder this is an edit, not a
 * video call, so it spends bits on sharpness rather than on smooth motion,
 * which is what a cut with text and graphics in it needs.
 */
export const ENCODER_PREFERENCES = {
  contentHint: 'detail',
} as const;

/**
 * Report the encoder configuration the browser actually settled on, once.
 *
 * Whether an export is running on hardware is the single largest factor in how
 * long it takes, and until now nothing anywhere said which one happened.
 */
function reportEncoderConfig(config: VideoEncoderConfig): void {
  worker.postMessage({
    type: 'encoder',
    codec: config.codec,
    hardwareAcceleration: config.hardwareAcceleration ?? 'no-preference',
    width: config.width,
    height: config.height,
    bitrate: config.bitrate ?? 0,
  });
}

/** An expected, user-facing failure - carries a code, never a message. */
class ExportError extends Error {
  constructor(readonly code: ExportErrorCode) {
    super(code);
    this.name = 'ExportError';
  }
}

const worker = self as unknown as {
  postMessage(message: WorkerReply, options?: StructuredSerializeOptions): void;
  onmessage: ((e: MessageEvent<MainToWorker>) => void) | null;
};

/**
 * Resolver for the mix chunk currently being awaited.
 *
 * Exactly one request is ever in flight (see `pullAudio`), so a single slot is
 * the whole queue. Null means nothing is waiting, in which case a stray chunk
 * is dropped rather than resurrecting a settled promise.
 */
let awaitingAudio: ((chunk: Float32Array[] | null) => void) | null = null;

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'audioChunk') {
    const resolve = awaitingAudio;
    awaitingAudio = null;
    resolve?.(msg.channels);
    return;
  }
  if (msg.type === 'audioFailed') {
    const resolve = awaitingAudio;
    awaitingAudio = null;
    resolve?.(null);
    return;
  }
  void (async () => {
    try {
      if (msg.type === 'export') {
        if (msg.preset.kind === 'mp3') await exportMp3(msg);
        else await exportMp4(msg, msg.preset);
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

/**
 * Ask the main thread for the next slice of the mix and wait for it.
 *
 * `OfflineAudioContext` does not exist here, so the mix has to be rendered on
 * the main thread - but pulling it slice by slice means neither side ever holds
 * more than one slice. Resolves to null when that slice could not be rendered,
 * which ends the audio track rather than failing the whole export: a video with
 * a truncated soundtrack beats no video at all.
 */
function pullAudio(offset: number, frames: number): Promise<Float32Array[] | null> {
  return new Promise((resolve) => {
    awaitingAudio = resolve;
    worker.postMessage({ type: 'needAudio', offset, frames });
  });
}

/**
 * The best available codec: the one asked for, or H.264, or nothing.
 *
 * Returns null only when even H.264 is unavailable at this configuration, which
 * is the one case worth refusing an export over.
 */
async function pickCodec(
  wanted: ExportVideoCodec,
  width: number,
  height: number,
  bitrate: number,
): Promise<ExportVideoCodec | null> {
  if (await canEncodeVideo(wanted, { width, height, bitrate })) return wanted;
  if (wanted !== 'avc' && (await canEncodeVideo('avc', { width, height, bitrate }))) return 'avc';
  return null;
}

function postProgress(value: number): void {
  worker.postMessage({ type: 'progress', value: Math.min(1, Math.max(0, value)) });
}

async function exportMp4(req: ExportRequest, preset: Mp4Preset): Promise<void> {
  const { project, files, startMs, durationMs, audio } = req;
  setPerfEnabled(!!req.measure);
  const width = preset.width;
  const height = preset.height;

  // The codec the preset asks for, if this browser can actually encode it at
  // this geometry and bitrate; H.264 otherwise.
  //
  // The probe takes the whole configuration, not just the codec name: a
  // configuration can be rejected on bitrate alone (the 4K preset asks for
  // 60 Mbps) and a geometry-only check would wave it through, so the failure
  // would surface mid-render as a raw native crash string. Falling back rather
  // than failing is deliberate - a preset is a preference about file size, and
  // no preference is worth refusing to export over.
  const codec = await pickCodec(preset.codec ?? 'avc', width, height, preset.videoBitrate);
  if (!codec) throw new ExportError('videoEncoderUnsupported');
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
      numberOfChannels: audio.channelCount,
      sampleRate: audio.sampleRate,
      bitrate: preset.audioBitrate,
    }))
  ) {
    registerAacEncoder();
  }

  const totalFrames = Math.max(1, Math.ceil((durationMs / 1000) * preset.fps));

  const plan = req.noParallel
    ? { segments: [{ firstFrame: 0, frameCount: totalFrames }], workers: 1 }
    : planSegments({
        totalFrames,
        fps: preset.fps,
        videoBitrate: preset.videoBitrate,
        cores: navigator.hardwareConcurrency,
      });
  const parallel = plan.workers > 1;

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
  const audioPackets = audio ? Math.ceil(audio.totalFrames / 512) + 64 : 0;

  // Serial and parallel differ only in where the encoded packets come from:
  // this worker's own encoder, or the segment workers'.
  const renderer = parallel
    ? null
    : new FrameRenderer({
        project,
        files,
        stills: req.stills,
        width,
        height,
        fps: preset.fps,
        startMs,
      });
  const canvasSource = renderer
    ? new CanvasSource(renderer.canvas, {
        codec,
        bitrate: preset.videoBitrate,
        // Offline export: never trade quality for latency, and never drop frames.
        // (This is mediabunny's default, pinned here so an export stays lossless-of-
        // intent even if the library default changes.)
        latencyMode: 'quality',
        // A key frame every 2 s matches YouTube's closed-GOP recommendation and keeps
        // seeking/scrubbing responsive on the platforms without bloating the file.
        keyFrameInterval: 2,
        ...ENCODER_PREFERENCES,
        onEncoderConfig: reportEncoderConfig,
      })
    : null;
  const packetSource = parallel ? new EncodedVideoPacketSource(codec) : null;
  output.addVideoTrack(
    (canvasSource ?? packetSource)!,
    writable ? { maximumPacketCount: videoPackets } : undefined,
  );

  let audioSource: AudioSampleSource | null = null;
  if (audio) {
    audioSource = new AudioSampleSource({ codec: 'aac', bitrate: preset.audioBitrate });
    output.addAudioTrack(audioSource, writable ? { maximumPacketCount: audioPackets } : undefined);
  }

  await output.start();

  const videoWeight = audio ? 0.92 : 0.98;
  let finished = false;
  /** Measurements from the slice workers, when this render fanned out. */
  let segmentPerf: PerfSnapshot[] = [];
  try {
    if (packetSource) {
      segmentPerf = await renderParallel(req, preset, codec, plan, packetSource, totalFrames, (done) =>
        postProgress((done / totalFrames) * videoWeight),
      );
    } else {
      await renderSerial(renderer!, canvasSource!, preset, totalFrames, (done) =>
        postProgress((done / totalFrames) * videoWeight),
      );
    }
    (canvasSource ?? packetSource)!.close();

    if (audioSource && audio) {
      await pushAudioMix(audioSource, audio, (v) => postProgress(videoWeight + v * 0.06));
      audioSource.close();
    }

    postProgress(0.99);
    await output.finalize();
    finished = true;

    if (req.measure) {
      // A fanned-out render has no frame loop of its own: the numbers live in
      // the slice workers, merged here into the per-frame cost of the render.
      const merged = segmentPerf.length > 0 ? mergeSnapshots(segmentPerf) : snapshot();
      worker.postMessage({ type: 'perf', snapshot: { ...merged, workers: plan.workers } });
    }
    postDone(target, 'video/mp4');
  } finally {
    await renderer?.dispose();
    if (!finished) {
      // Release the destination file: without this the writable stays open and
      // the user is left with a locked, half-written file.
      try {
        await output.cancel();
      } catch {
        /* already torn down */
      }
    }
  }
}

/** The single-worker render: decode, composite and encode, one frame at a time. */
async function renderSerial(
  renderer: FrameRenderer,
  videoSource: CanvasSource,
  preset: Mp4Preset,
  totalFrames: number,
  onProgress: (done: number) => void,
): Promise<void> {
  await renderer.ready();
  const frameDur = 1 / preset.fps;
  const inFlight: Promise<void>[] = [];
  const drainTo = async (depth: number): Promise<void> => {
    while (inFlight.length > depth) await inFlight.shift()!;
  };

  try {
    for (let i = 0; i < totalFrames; i++) {
      const frameStarted = span();
      await renderer.renderFrame(i);

      const encodeStarted = span();
      await drainTo(ENCODE_QUEUE_DEPTH - 1);
      endSpan('encodeWait', encodeStarted);

      inFlight.push(videoSource.add(i * frameDur, frameDur));
      // After the capture, never before: the layers hold frames these readers
      // own, and `add` is what copies them out of the canvas.
      await renderer.releaseFinishedReaders();
      // Post every 5th frame, but always on the last one, so a very short
      // (<5-frame) region still advances the bar past the video phase instead
      // of jumping straight from 0 to finalize.
      if (i % 5 === 0 || i === totalFrames - 1) onProgress(i);
      endSpan('frame', frameStarted);
      endFrame();
    }
    await drainTo(0);
  } catch (err) {
    // Deferred encodes still in flight would otherwise reject unhandled once
    // the render has already failed for another reason.
    for (const p of inFlight) p.catch(() => {});
    throw err;
  }
}

/**
 * The fanned-out render.
 *
 * Each slice is encoded by its own worker into a standalone MP4; this function
 * demuxes those and appends their packets, in output order, with their
 * timestamps shifted onto the timeline. The packets are never touched, so the
 * result is bit-identical to what one encoder would have produced for each
 * slice - what differs is only that four of them ran at once.
 *
 * Slices complete out of order and are held until their turn, which bounds the
 * memory at roughly (workers x slice size) - the same bound the slice planner
 * sizes slices against.
 */
async function renderParallel(
  req: ExportRequest,
  preset: Mp4Preset,
  codec: ExportVideoCodec,
  plan: SegmentPlan,
  packetSource: EncodedVideoPacketSource,
  totalFrames: number,
  onProgress: (done: number) => void,
): Promise<PerfSnapshot[]> {
  const frameDur = 1 / preset.fps;
  const done = new Map<number, ArrayBuffer>();
  const progress = new Map<number, number>();
  /** Segments finished and already muxed. */
  let appended = 0;
  let next = 0;
  let dispatched = 0;
  let failure: Error | null = null;
  /** The decoder config of the first slice: every other slice must match it. */
  let firstConfig: string | null = null;
  /** Per-slice measurements, merged into one breakdown for the whole render. */
  const segmentPerf: PerfSnapshot[] = [];

  const workers: Worker[] = [];
  /** Resolves when every slice has been muxed, or the first failure. */
  let settle: () => void = () => {};
  let fail: (e: Error) => void = () => {};
  const allDone = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const reportProgress = (): void => {
    let frames = 0;
    for (let i = 0; i < appended; i++) frames += plan.segments[i]!.frameCount;
    for (const [, f] of progress) frames += f;
    onProgress(Math.min(totalFrames, frames));
  };

  /** Mux every slice that is now next in line. */
  const drainReady = async (): Promise<void> => {
    while (done.has(next)) {
      const buffer = done.get(next)!;
      done.delete(next);
      const offset = plan.segments[next]!.firstFrame * frameDur;
      const config = await appendSegment(packetSource, buffer, offset, firstConfig === null);
      if (firstConfig === null) firstConfig = config;
      else if (config !== firstConfig) {
        // Two encoder instances configured identically produced different
        // parameter sets. Concatenating them would give a file that decodes
        // garbage from here on, so the render restarts serially instead - the
        // main thread retries with `noParallel`.
        throw new ExportError('segmentMismatch');
      }
      next++;
      appended++;
      reportProgress();
    }
  };

  const dispatch = (w: Worker): void => {
    if (dispatched >= plan.segments.length || failure) return;
    const index = dispatched++;
    const segment = plan.segments[index]!;
    progress.set(index, 0);
    const request: SegmentRequest = {
      type: 'segment',
      index,
      project: req.project,
      files: req.files,
      // Cloned, not transferred: every worker needs its own copy of every still,
      // and a transfer would move the bitmap out of this worker's reach.
      stills: req.stills,
      width: preset.width,
      height: preset.height,
      fps: preset.fps,
      videoBitrate: preset.videoBitrate,
      codec,
      startMs: req.startMs,
      firstFrame: segment.firstFrame,
      frameCount: segment.frameCount,
      ...(req.measure ? { measure: true } : {}),
    };
    w.postMessage(request);
  };

  try {
    for (let i = 0; i < plan.workers; i++) {
      const w = new Worker(new URL('./segmentWorker.ts', import.meta.url), { type: 'module' });
      workers.push(w);
      w.onmessage = (e: MessageEvent<SegmentReply>) => {
        const msg = e.data;
        if (msg.type === 'segmentProgress') {
          progress.set(msg.index, msg.frames);
          reportProgress();
          return;
        }
        if (msg.type === 'segmentFailed') {
          failure = new Error(`segment ${msg.index}: ${msg.detail}`);
          fail(failure);
          return;
        }
        progress.delete(msg.index);
        if (msg.perf) segmentPerf.push(msg.perf);
        done.set(msg.index, msg.buffer);
        void drainReady()
          .then(() => {
            if (appended === plan.segments.length) settle();
            else dispatch(w);
          })
          .catch((err: Error) => {
            failure = err;
            fail(err);
          });
      };
      w.onerror = (event) => {
        event.preventDefault?.();
        const err = new Error(event instanceof ErrorEvent ? event.message : 'segment worker failed');
        failure = err;
        fail(err);
      };
    }
    for (const w of workers) dispatch(w);
    await allDone;
    return segmentPerf;
  } finally {
    for (const w of workers) w.terminate();
  }
}

/**
 * Demux one finished slice and append its packets to the output, shifted onto
 * the timeline. Returns a fingerprint of the slice's decoder configuration, so
 * the caller can prove every slice agrees on one.
 */
async function appendSegment(
  packetSource: EncodedVideoPacketSource,
  buffer: ArrayBuffer,
  offsetSec: number,
  withMeta: boolean,
): Promise<string> {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(buffer) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('segment has no video track');
    const config = await track.getDecoderConfig();
    if (!config) throw new Error('segment has no decoder config');
    const sink = new EncodedPacketSink(track);
    let first = true;
    for await (const packet of sink.packets()) {
      await packetSource.add(
        packet.clone({ timestamp: packet.timestamp + offsetSec }),
        // The muxer wants the decoder config once, on the first packet of the
        // track; later slices carry the same one and repeating it is noise.
        withMeta && first ? { decoderConfig: config } : undefined,
      );
      first = false;
    }
    return fingerprint(config);
  } finally {
    input.dispose();
  }
}

/** Stable string form of a decoder config, for comparing slices. */
function fingerprint(config: VideoDecoderConfig): string {
  const description = config.description;
  let bytes = '';
  if (description) {
    const view = ArrayBuffer.isView(description)
      ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
      : new Uint8Array(description as ArrayBuffer);
    for (const b of view) bytes += b.toString(16).padStart(2, '0');
  }
  return `${config.codec}|${config.codedWidth}x${config.codedHeight}|${bytes}`;
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
      numberOfChannels: audio.channelCount,
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

/**
 * Pull the mix from the main thread and feed it to the encoder, slice by slice.
 *
 * The mix used to arrive whole, in the export request: one contiguous Float32
 * allocation for the entire timeline (690 MB for an hour of stereo 48 kHz),
 * built before the first video frame was encoded and held until the last. Now
 * the peak is one slice, and it is the same peak whether the cut is thirty
 * seconds or three hours.
 */
async function pushAudioMix(
  source: AudioSampleSource,
  audio: AudioMixInfo,
  onProgress: (v: number) => void,
): Promise<void> {
  const { sampleRate, channelCount, totalFrames } = audio;

  for (let offset = 0; offset < totalFrames; offset += AUDIO_CHUNK_FRAMES) {
    const frames = Math.min(AUDIO_CHUNK_FRAMES, totalFrames - offset);
    const channels = await pullAudio(offset, frames);
    // The main thread could not render this slice: stop rather than write
    // silence, so the file's audio ends where the mix did.
    if (!channels) return;
    const data = new Float32Array(frames * channelCount);
    for (let ch = 0; ch < channelCount; ch++) {
      data.set(channels[ch]!.subarray(0, frames), ch * frames);
    }
    const sample = new AudioSample({
      data,
      format: 'f32-planar',
      numberOfChannels: channelCount,
      sampleRate,
      timestamp: offset / sampleRate,
    });
    await source.add(sample);
    sample.close();
    onProgress(offset / totalFrames);
  }
}
