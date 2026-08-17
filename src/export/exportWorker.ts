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
import { RenderPreviewTap } from './renderPreview';
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
 * How many finished-but-not-yet-muxed slices the lead will hold before it stops
 * handing out new work. See `pump`, which is where the reasoning lives.
 */
const MAX_HELD_SEGMENTS = 2;

/*
 * Two encoder options this file deliberately does NOT set. Neither has a
 * declaration to hang off - that is the point of the note.
 *
 * `hardwareAcceleration: 'prefer-hardware'`. Asking for it looks free - it is
 * documented as a hint, and a browser with no hardware encoder is supposed to
 * fall back to software silently. It is not free: with `prefer-hardware` set,
 * the "120 fps · 4K" preset stops producing a file at all. The hardware encoder
 * accepts the configuration, cannot sustain 4K at 120 fps, and stalls rather
 * than failing, so the render hangs instead of degrading. Measured, reproduced.
 * The browser's own default already picks hardware where hardware is the right
 * answer; what was missing was not the preference but the OBSERVATION, which is
 * what `reportEncoderConfig` below provides.
 *
 * `contentHint: 'detail'`. It reads like the obviously correct hint for an edit
 * rather than a video call, and it was set here for exactly that reason. Every
 * geometry was then measured with it and without it, and it never once produced
 * a smaller or a better file:
 *
 *   1080p 60 and 1080p 120   same bitrate to the decimal, same time
 *   1440p 60                 +37% bitrate, 4.5x the encode time
 *   4K 120                   +41% bitrate, 6x the encode time
 *
 * At 4K 120 that last row is 18x realtime, which is the difference between an
 * export that finishes and one the user gives up on. The hint is dropped.
 */

/**
 * Whether this browser will encode `codec` at this geometry with the cadence
 * declared on the track.
 *
 * Declaring the frame rate is worth a great deal (see `videoTrackMetadata`),
 * but it is also the one thing that can make an otherwise supported
 * configuration be refused outright: HEVC at 4K 120 is accepted with no cadence
 * and rejected with one, because the cadence is what pushes the required level
 * past what the encoder implements.
 *
 * `canEncodeVideo` cannot answer this - it hardcodes `framerate: undefined`
 * when it builds the configuration to probe, so it is blind to the very field
 * in question. So the probe is a real one: build the real output, encode a
 * single frame, throw it away. One frame costs milliseconds against an export
 * measured in minutes, and unlike a guess at the codec string it tests the
 * exact configuration the render is about to use.
 */
async function canDeclareFrameRate(
  codec: ExportVideoCodec,
  width: number,
  height: number,
  bitrate: number,
  fps: number,
): Promise<boolean> {
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
  const canvas = new OffscreenCanvas(width, height);
  // A canvas that has never been given a context is not a usable image source,
  // and the frame constructor rejects it - which would fail the probe for a
  // reason that has nothing to do with the cadence, and silently give up the
  // gain everywhere. Asking for the context is what makes the canvas real.
  if (!canvas.getContext('2d')) return false;
  const source = new CanvasSource(canvas, {
    codec,
    bitrate,
    latencyMode: 'quality',
    keyFrameInterval: 2,
  });
  output.addVideoTrack(source, { frameRate: fps });
  try {
    await output.start();
    await source.add(0, 1 / fps);
    source.close();
    await output.finalize();
    return true;
  } catch {
    try {
      await output.cancel();
    } catch {
      /* already torn down */
    }
    return false;
  }
}

/**
 * The track metadata for the video track, carrying the cadence when the browser
 * will take it.
 *
 * The frame rate is not decoration. It is the only route by which `framerate`
 * reaches the `VideoEncoderConfig` - mediabunny reads it off the track metadata
 * and nowhere else - and without it the encoder rate-controls as if it were
 * being fed some default cadence, so it spends a full frame's bit budget on
 * every frame of a 120 fps render. The export sheet's size estimate is not
 * approximately wrong in that state, it is wrong by a multiple:
 *
 *   1080p 120   asked 30.7 Mbps, produced 128 Mbps   -> 34.3 Mbps declared
 *   1080p 60    asked 19.2 Mbps, produced 53.4 Mbps  -> 24.7 Mbps declared
 *   1440p 120   asked 61.4 Mbps, produced 254 Mbps   -> 162 Mbps declared
 *   4K 120      asked 134 Mbps,  produced 559 Mbps   -> 355 Mbps declared
 *
 * At 1080p, where most exports live, declaring it costs no measurable time and
 * brings the file back onto the promised figure. Above 1080p it costs encode
 * time - roughly double at 4K - because the encoder starts doing the rate
 * control it was skipping. That is the right trade: the alternative is a file
 * several times the size the user was shown.
 *
 * The 4K 120 row is still 2.6x its target, and no bitrate makes it otherwise:
 * asking for 20 Mbps there produces the same 355 Mbps as asking for 134. The
 * browser's encoder simply has a floor at that macroblock rate, in every codec
 * offered. That is a limit to be reported, not a bug to be fixed here.
 */
function videoTrackMetadata(
  fps: number,
  declareFrameRate: boolean,
  maximumPacketCount: number | null,
): { frameRate?: number; maximumPacketCount?: number } | undefined {
  const metadata = {
    ...(declareFrameRate ? { frameRate: fps } : {}),
    ...(maximumPacketCount !== null ? { maximumPacketCount } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

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
  // Settled once, here, because every segment worker has to encode the same way
  // the lead does for their packets to splice into one stream.
  const declareFrameRate = await canDeclareFrameRate(
    codec,
    width,
    height,
    preset.videoBitrate,
    preset.fps,
  );
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
        onEncoderConfig: reportEncoderConfig,
      })
    : null;
  const packetSource = parallel ? new EncodedVideoPacketSource(codec) : null;
  output.addVideoTrack(
    (canvasSource ?? packetSource)!,
    videoTrackMetadata(preset.fps, declareFrameRate, writable ? videoPackets : null),
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
      segmentPerf = await renderParallel(
        req,
        preset,
        codec,
        declareFrameRate,
        plan,
        packetSource,
        totalFrames,
        (done) => postProgress((done / totalFrames) * videoWeight),
      );
    } else {
      await renderSerial(renderer!, canvasSource!, preset, startMs, totalFrames, (done) =>
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
  startMs: number,
  totalFrames: number,
  onProgress: (done: number) => void,
): Promise<void> {
  await renderer.ready();
  const frameDur = 1 / preset.fps;
  const inFlight: Promise<void>[] = [];
  const drainTo = async (depth: number): Promise<void> => {
    while (inFlight.length > depth) await inFlight.shift()!;
  };
  const preview = new RenderPreviewTap(renderer.canvas, startMs, preset.fps, (bitmap, timeMs) => {
    worker.postMessage({ type: 'previewFrame', bitmap, timeMs }, { transfer: [bitmap] });
  });

  try {
    for (let i = 0; i < totalFrames; i++) {
      const frameStarted = span();
      await renderer.renderFrame(i);

      const encodeStarted = span();
      await drainTo(ENCODE_QUEUE_DEPTH - 1);
      endSpan('encodeWait', encodeStarted);

      inFlight.push(videoSource.add(i * frameDur, frameDur));
      // Once the encoder has its copy, so the monitor never makes it wait.
      preview.capture(i);
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
  declareFrameRate: boolean,
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
  /** Workers with nothing to do, waiting for `pump` to find them a slice. */
  const idle: Worker[] = [];
  /** Resolves when every slice has been muxed, or the first failure. */
  let settle: () => void = () => {};
  let fail: (e: Error) => void = () => {};
  const allDone = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  /**
   * Frames rendered so far, counting a finished slice in full.
   *
   * Slices are muxed strictly in order but they FINISH out of order, so at any
   * moment some of them are rendered, encoded and waiting on an earlier
   * neighbour. Those frames are work that is genuinely done, and the progress
   * this reports is the only thing standing between the user and a bar that
   * appears frozen: with `progress` cleared on completion instead of held, the
   * report was the muxed slices plus the two slices in flight, and nothing
   * else. On a fourteen-slice render that pins the bar under
   *
   *     2 slices in flight / 14 slices = 14.3 %
   *
   * until the very first slice lands, however much has actually been encoded -
   * which is exactly the "stuck at 14 % for an hour, GPU still busy" a tester
   * reported. The bar was telling the truth about muxing and saying nothing
   * about rendering.
   */
  const reportProgress = (): void => {
    let frames = 0;
    for (let i = 0; i < appended; i++) frames += plan.segments[i]!.frameCount;
    for (const [, f] of progress) frames += f;
    onProgress(Math.min(totalFrames, frames));
  };

  /** Mux every slice that is now next in line. */
  const drainReady = async (): Promise<void> => {
    while (done.has(next)) {
      const index = next;
      const buffer = done.get(index)!;
      done.delete(index);
      const offset = plan.segments[index]!.firstFrame * frameDur;
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
      // `appended` now covers this slice's frames, so the entry that was
      // holding them would double-count from here on.
      progress.delete(index);
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
      declareFrameRate,
      startMs: req.startMs,
      firstFrame: segment.firstFrame,
      frameCount: segment.frameCount,
      ...(req.measure ? { measure: true } : {}),
    };
    w.postMessage(request);
  };

  /**
   * Hand work to every idle worker the memory budget still allows.
   *
   * Without the `done.size` test a worker that finishes ahead of its neighbour
   * simply takes the next slice, and the next, for as long as the neighbour is
   * slow - while every finished slice it hands back is held here, whole, until
   * the neighbour arrives. Nothing bounded that but the slice count, and a
   * fourteen-slice 4K render could reach thirteen buffered slices at once.
   * How many bytes that is depends on the footage - the same 4K 120 preset
   * measured 107 MB per fifteen-second slice on real gameplay and 592 MB on
   * synthetic noise - but at either figure it is gigabytes of encoded video
   * held to no purpose. "Array buffer allocation failed" was the shape that
   * took; long before that, it is simply memory pressure, which the render pays
   * for in decode time (see MIN_SEGMENT_SECONDS in segmentPlan).
   *
   * Two is slack enough that a worker only ever waits on a neighbour that is
   * genuinely behind, and never on the muxer.
   *
   * This cannot deadlock. Slices are dispatched in index order, so if the slice
   * the muxer is waiting for has not been dispatched yet, no later one has
   * either and `done` is empty - the cap is not binding. Otherwise that slice
   * is either already in `done`, and `drainReady` has just consumed it, or it
   * is in flight on a worker that is by definition not idle.
   */
  const pump = (): void => {
    // Checked once, not per iteration: `failure` is only ever set from a worker
    // message, so it cannot change while this loop runs.
    if (failure) return;
    while (
      idle.length > 0 &&
      done.size < MAX_HELD_SEGMENTS &&
      dispatched < plan.segments.length
    ) {
      dispatch(idle.shift()!);
    }
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
        if (msg.type === 'segmentPreview') {
          // Only the slice the muxer is waiting on drives the monitor. The
          // other workers are rendering further down the timeline, and cutting
          // between them would show the picture jumping about instead of
          // advancing - while this one slice tracks the same front the progress
          // bar reports. The rest are closed here: an ImageBitmap left to the
          // collector is GPU memory held for no reason.
          if (msg.index === next) {
            worker.postMessage(
              { type: 'previewFrame', bitmap: msg.bitmap, timeMs: msg.timeMs },
              { transfer: [msg.bitmap] },
            );
          } else {
            msg.bitmap.close();
          }
          return;
        }
        if (msg.type === 'segmentFailed') {
          failure = new Error(`segment ${msg.index}: ${msg.detail}`);
          fail(failure);
          return;
        }
        // Held at its full frame count rather than dropped: the slice is
        // rendered and encoded, and only its turn to be muxed is outstanding.
        // `drainReady` removes the entry once `appended` accounts for it.
        progress.set(msg.index, plan.segments[msg.index]!.frameCount);
        if (msg.perf) segmentPerf.push(msg.perf);
        done.set(msg.index, msg.buffer);
        void drainReady()
          .then(() => {
            if (appended === plan.segments.length) settle();
            else {
              idle.push(w);
              pump();
            }
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
    idle.push(...workers);
    pump();
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
