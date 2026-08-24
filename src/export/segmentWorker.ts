import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny';
import { FrameRenderer } from './frameRenderer';
import { RenderPreviewTap } from './renderPreview';
import { endFrame, endSpan, perfReset, setPerfEnabled, snapshot, span } from '../perf/probe';
import {
  ENCODE_STALL_MS,
  FIRST_ENCODE_STALL_MS,
  FRAME_STALL_MS,
  StalledError,
  TEARDOWN_STALL_MS,
  withDeadline,
} from './stallGuard';
import type { SegmentReply, SegmentRequest } from './segmentProtocol';

/**
 * One slice of a parallel export.
 *
 * Renders output frames `[firstFrame, firstFrame + frameCount)` and encodes
 * them into a small, standalone MP4 in memory. The lead worker then demuxes
 * that MP4 and re-muxes its packets - already encoded - into the real output,
 * shifted onto the timeline. Nothing is re-encoded, so the only cost of the
 * split is a few megabytes of intermediate container per segment.
 *
 * Encoding through mediabunny's `CanvasSource`, exactly as the serial path
 * does, rather than driving a `VideoEncoder` by hand: the codec string, the
 * profile and the level are then decided by the same code in every segment,
 * which is what makes the segments concatenable in the first place.
 *
 * The first frame a fresh encoder produces is always a key frame, so every
 * segment starts with an IDR by construction - there is no need to ask for one.
 */

const worker = self as unknown as {
  postMessage(message: SegmentReply, options?: StructuredSerializeOptions): void;
  onmessage: ((e: MessageEvent<SegmentRequest>) => void) | null;
};

/** How many encodes may be outstanding at once. See ENCODE_QUEUE_DEPTH in exportWorker. */
const ENCODE_QUEUE_DEPTH = 4;
/** Frames between progress reports: often enough to be smooth, rare enough to be free. */
const PROGRESS_EVERY = 15;

worker.onmessage = (e) => {
  const req = e.data;
  if (req.type !== 'segment') return;
  void render(req).catch((err) => {
    worker.postMessage({
      type: 'segmentFailed',
      index: req.index,
      detail: err instanceof Error ? err.message : String(err),
      // The lead reads this rather than the message: a stalled encoder is the
      // one failure worth re-running the whole render for, on the software
      // encoder, and it must not be mistaken for a slice that went wrong.
      ...(err instanceof StalledError ? { stalled: true } : {}),
    });
  });
};

async function render(req: SegmentRequest): Promise<void> {
  // A worker renders several slices over a render; each snapshot must describe
  // its own slice, not everything the worker has done so far.
  perfReset();
  setPerfEnabled(!!req.measure);
  const renderer = new FrameRenderer({
    project: req.project,
    files: req.files,
    stills: req.stills,
    width: req.width,
    height: req.height,
    fps: req.fps,
    startMs: req.startMs,
  });
  await renderer.ready();

  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  const source = new CanvasSource(renderer.canvas, {
    codec: req.codec,
    bitrate: req.videoBitrate,
    // The lead's answer, like the cadence: the slices splice packet for packet,
    // so they all encode through the same kind of encoder or not at all.
    hardwareAcceleration: req.hardwareAcceleration,
    // Offline export: never trade quality for latency, and never drop frames.
    latencyMode: 'quality',
    // A key frame every 2 s, as in the serial path. The segment's own first
    // frame is a key frame regardless, which is what makes it splice cleanly.
    keyFrameInterval: 2,
    // Nothing else: the slices have to be encoded the way one encoder would
    // have encoded the whole thing, and the serial path sets nothing else
    // either. The note above `probeEncode` in exportWorker carries the
    // measurements for why `prefer-hardware` and `contentHint` are never asked
    // for in either.
  });
  // The cadence, when the lead's probe found the browser will take it. Same
  // reasoning as the serial path, and the lead's answer rather than this
  // worker's so that every slice agrees.
  output.addVideoTrack(source, req.declareFrameRate ? { frameRate: req.fps } : undefined);
  await output.start();

  const frameDur = 1 / req.fps;
  const inFlight: Promise<void>[] = [];
  // Deadlines, not budgets: an encoder that takes a configuration it cannot
  // sustain emits nothing and never rejects, so without one this await is where
  // a render stops for ever. See `stallGuard`.
  // Shorter until this encoder has produced its first packet: one that has
  // emitted nothing has not started, and every other slice is queued behind it.
  let encoded = 0;
  const drainTo = async (depth: number): Promise<void> => {
    while (inFlight.length > depth) {
      await withDeadline(
        inFlight.shift()!,
        encoded === 0 ? FIRST_ENCODE_STALL_MS : ENCODE_STALL_MS,
        `segment ${req.index} video encoder`,
      );
      encoded++;
    }
  };

  // Every slice offers snapshots even though the lead only forwards one of
  // them: a slice does not know which one that is (the lead switches as it muxes
  // its way down the timeline), and a downscale to 480px eight times a second is
  // far below the noise of encoding, so asking would cost more than sampling.
  const preview = new RenderPreviewTap(renderer.canvas, req.startMs, req.fps, (bitmap, timeMs) => {
    worker.postMessage(
      { type: 'segmentPreview', index: req.index, bitmap, timeMs },
      { transfer: [bitmap] },
    );
  });

  try {
    for (let i = 0; i < req.frameCount; i++) {
      const frameStarted = span();
      await withDeadline(
        renderer.renderFrame(req.firstFrame + i),
        FRAME_STALL_MS,
        `frame ${req.firstFrame + i} decode`,
      );
      const encodeStarted = span();
      await drainTo(ENCODE_QUEUE_DEPTH - 1);
      endSpan('encodeWait', encodeStarted);
      // Local timestamps: the segment is a self-contained file starting at 0.
      // The lead shifts them onto the timeline when it re-muxes.
      inFlight.push(source.add(i * frameDur, frameDur));
      // After the capture, so the encoder never waits on the monitor.
      preview.capture(req.firstFrame + i);
      await renderer.releaseFinishedReaders();
      if (i % PROGRESS_EVERY === 0) {
        worker.postMessage({ type: 'segmentProgress', index: req.index, frames: i });
      }
      endSpan('frame', frameStarted);
      endFrame();
    }
    await drainTo(0);
    source.close();
    // The flush runs through the encoder too, and a slice that hangs here hangs
    // the whole render: every other slice is waiting its turn to be muxed.
    await withDeadline(output.finalize(), ENCODE_STALL_MS, `segment ${req.index} finalize`);
    const buffer = target.buffer!;
    worker.postMessage(
      {
        type: 'segmentDone',
        index: req.index,
        buffer,
        frames: req.frameCount,
        ...(req.measure ? { perf: snapshot() } : {}),
      },
      { transfer: [buffer] },
    );
  } catch (err) {
    for (const p of inFlight) p.catch(() => {});
    // NOT awaited. Tearing an output down goes through the encoder that is
    // being torn down, so when the encoder is what stopped responding, awaiting
    // this hangs exactly where the watchdog just escaped from - and the failure
    // would never reach the lead. Fire and forget: the worker is finished with
    // either way, and the lead terminates it.
    void output.cancel().catch(() => {});
    throw err;
  } finally {
    // Deadlined, for exactly the reason `output.cancel()` above is not awaited
    // at all: closing a reader runs through the very decoder that may be what
    // stopped responding. Without a deadline this hangs on the way out of a
    // failure and takes the `throw` above with it - `segmentFailed` never
    // reaches the lead, and the render the watchdog had just escaped from
    // stalls anyway, for ever. That is the shape of the 4K 120 hang reported
    // with two slice workers and a media process that died under them.
    //
    // Swallowed rather than rethrown: on the failure path the real failure is
    // already in flight and must be the one that arrives, and on the success
    // path the slice has been posted and this worker is finished with either
    // way - the lead terminates it.
    await withDeadline(
      renderer.dispose(),
      TEARDOWN_STALL_MS,
      `segment ${req.index} teardown`,
    ).catch(() => {
      /* abandoned: this worker is about to be terminated regardless */
    });
  }
}
