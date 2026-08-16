import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny';
import { FrameRenderer } from './frameRenderer';
import { endFrame, endSpan, perfReset, setPerfEnabled, snapshot, span } from '../perf/probe';
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
    // Offline export: never trade quality for latency, and never drop frames.
    latencyMode: 'quality',
    // A key frame every 2 s, as in the serial path. The segment's own first
    // frame is a key frame regardless, which is what makes it splice cleanly.
    keyFrameInterval: 2,
    // Nothing else: the slices have to be encoded the way one encoder would
    // have encoded the whole thing, and the serial path sets nothing else
    // either. `canDeclareFrameRate` in exportWorker carries the measurements
    // for why neither `prefer-hardware` nor `contentHint` appears in either.
  });
  // The cadence, when the lead's probe found the browser will take it. Same
  // reasoning as the serial path, and the lead's answer rather than this
  // worker's so that every slice agrees.
  output.addVideoTrack(source, req.declareFrameRate ? { frameRate: req.fps } : undefined);
  await output.start();

  const frameDur = 1 / req.fps;
  const inFlight: Promise<void>[] = [];
  const drainTo = async (depth: number): Promise<void> => {
    while (inFlight.length > depth) await inFlight.shift()!;
  };

  try {
    for (let i = 0; i < req.frameCount; i++) {
      const frameStarted = span();
      await renderer.renderFrame(req.firstFrame + i);
      const encodeStarted = span();
      await drainTo(ENCODE_QUEUE_DEPTH - 1);
      endSpan('encodeWait', encodeStarted);
      // Local timestamps: the segment is a self-contained file starting at 0.
      // The lead shifts them onto the timeline when it re-muxes.
      inFlight.push(source.add(i * frameDur, frameDur));
      await renderer.releaseFinishedReaders();
      if (i % PROGRESS_EVERY === 0) {
        worker.postMessage({ type: 'segmentProgress', index: req.index, frames: i });
      }
      endSpan('frame', frameStarted);
      endFrame();
    }
    await drainTo(0);
    source.close();
    await output.finalize();
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
    try {
      await output.cancel();
    } catch {
      /* already torn down */
    }
    throw err;
  } finally {
    await renderer.dispose();
  }
}
