/**
 * How a render is split across workers.
 *
 * The export loop is encoder-bound: measured on a 1080p render, 84% of every
 * frame is spent waiting for the encoder even with four encodes in flight. One
 * encoder is one encoder however deep the queue is, so the only way past it is
 * more of them - which means more workers, each rendering a contiguous slice.
 *
 * The planning is pure arithmetic and lives here so it can be reasoned about
 * without a worker, a canvas or an encoder in the way.
 */

export interface SegmentPlan {
  /** Frame ranges, in output order. `[firstFrame, frameCount]` pairs. */
  segments: { firstFrame: number; frameCount: number }[];
  /** How many workers to run concurrently. Never more than there are segments. */
  workers: number;
}

/**
 * Shortest slice worth splitting off.
 *
 * This was fifteen seconds, and the reason given was rate control: measured on
 * a one-minute render, splitting into eight slices produced a file HALF the
 * size of the serial one, because no encoder ever ran long enough to settle at
 * the target bitrate.
 *
 * That diagnosis was wrong, and the re-measurement is in `e2e/probeSliceRate.spec.ts`.
 * What the encoder was missing was not running time, it was the cadence: the
 * export did not declare `frameRate` on its video track, so rate control had no
 * idea how many frames a second it was budgeting for. With the cadence declared
 * (see `videoTrackMetadata` in exportWorker), thirty seconds of 1080p60 asking
 * for 24 Mbps comes back at
 *
 *   one 30 s slice  23.9 Mbps   four  8 s slices  24.5 Mbps
 *   two 15 s slices 24.1 Mbps   eight 4 s slices  24.2 Mbps
 *                               fifteen 2 s slices 24.3 Mbps
 *
 * - flat to within measurement noise, at every slice length. Slice length is
 * simply not what decides bitrate accuracy.
 *
 * So the floor now answers the cost it really has to answer: every segment pays
 * for its own encoder configuration and its own seek into each clip it touches,
 * and a seek into 120 fps footage with a two-second GOP can be a couple of
 * hundred frames of decode. Four seconds keeps that amortized while letting
 * MAX_SEGMENT_BYTES below actually bind, which at 4K it never could at fifteen.
 *
 * Shortening it is not a memory trade paid for in time - it is faster outright.
 * Ninety seconds of 4K 120 cut from a real 1440p120 capture, same machine, same
 * warm cache, nothing else changed:
 *
 *   15 s slices   587 s wall   decode 30.51 ms/frame   longest stall 38.4 s
 *    4 s slices    82 s wall   decode  0.61 ms/frame   longest stall  3.4 s
 *
 * 7x, and it is the DECODE that moves, which is the tell: the render was not
 * short of encoder, it was short of memory. Two workers holding a ~100 MB slice
 * each while the lead holds more is enough pressure that every VideoFrame the
 * decoder allocates starts costing, and 4K 120 allocates one per frame.
 */
export const MIN_SEGMENT_SECONDS = 4;

/**
 * Ceiling on the encoded bytes one segment holds before it is handed back.
 *
 * A segment is buffered whole, in memory, in its worker, and again in the lead
 * until its turn to be muxed comes round. Capping the BYTES rather than the
 * seconds keeps a 4K render's slices short and a 720p render's slices long,
 * which is what each of them wants.
 *
 * It only started doing that once MIN_SEGMENT_SECONDS came down. The floor
 * above is applied to this ceiling with `Math.max`, so while it stood at
 * fifteen seconds the cap could never shorten a slice below fifteen seconds'
 * worth - and at 4K 120 that is 252 MB against a 64 MB ceiling, four times
 * over, before the encoder has overshot anything. The cap read as the binding
 * constraint at 4K and was in fact dead there, which is how a fourteen-slice
 * render came to be able to hold gigabytes of encoded video at once.
 *
 * The figure above is what the preset ASKS for, which is all the planner knows.
 * What comes out is content-dependent and can be well either side of it: the
 * same 4K 120 preset measured 57 Mbps on real 1440p120 gameplay and 355 Mbps on
 * synthetic worst-case noise. So this cap sizes slices against the request and
 * cannot promise a byte count - `MAX_HELD_SEGMENTS` in exportWorker is what
 * bounds the count of them, which is the half that does not depend on guessing
 * how compressible the footage is.
 */
export const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

/**
 * Most workers to run at once.
 *
 * Emphatically not `hardwareConcurrency`. The encoder is a shared resource, not
 * a per-thread one: on a 16-core machine, the same one-minute render measured
 * 1.26x faster with two workers, 1.23x with four, 1.17x with six and 1.07x with
 * eight. Past two, the workers are queueing for the same encoder and paying the
 * coordination for nothing.
 *
 * The number is a floor on the benefit, not a ceiling: where H.264 encoding
 * falls back to software - which is CPU-bound and genuinely parallel - the same
 * split scales with cores instead. Two is what is safe to claim everywhere.
 */
export const MAX_SEGMENT_WORKERS = 2;

/**
 * Pixel rate above which a render encodes on ONE worker, however many cores
 * the machine has.
 *
 * Fanning out does not just spend more CPU: each slice worker holds its own
 * hardware encoder session AND its own decoders, and those are not per-thread
 * resources - they are sessions on one fixed-function block with a throughput
 * budget of its own. Ask for more than it can carry and it does not slow down,
 * it dies, taking the sandboxed media process with it. Every decoder and
 * encoder in the tab goes with it, and because that process is not the GPU
 * process, nothing in `chrome://gpu` even counts the crash.
 *
 * That is the 4K 120 export a tester lost at 22 %: `chrome://crashes` held two
 * crashes 22 s apart - one per slice worker - while the GPU crash count stayed
 * at zero. Two 4K 120 sessions is 2.0 Gpx/s of encode plus the decode of the
 * source underneath it, against a block sized for a small multiple of 4K 60.
 *
 * The figure below is a guard, not a measurement: it is one crash report's
 * worth of evidence, chosen to sit above 4K 60 (497 Mpx/s) and 1440p 120
 * (442 Mpx/s), which are attested, and below 4K 120 (995 Mpx/s), which is not.
 * It should be moved by measuring, not by argument.
 *
 * The probe in `chooseEncoderSetup` cannot stand in for this. It encodes ONE
 * frame before the render starts, on one encoder, and a block that dies after
 * twenty seconds of sustained load answers that probe perfectly.
 */
export const MAX_PARALLEL_PIXELS_PER_SECOND = 500_000_000;

/**
 * Whether this geometry may be encoded by more than one worker at a time.
 *
 * Deliberately not folded into `planSegments`: that function is slice
 * arithmetic - how long a slice may be, how many of them cover the render - and
 * this is a question about the machine, answered before any of that arithmetic
 * is worth doing. Keeping them apart is what lets each be read, and tested, on
 * its own terms.
 */
export function canFanOut(geometry: { width: number; height: number; fps: number }): boolean {
  return geometry.width * geometry.height * geometry.fps <= MAX_PARALLEL_PIXELS_PER_SECOND;
}

export function planSegments(options: {
  totalFrames: number;
  fps: number;
  videoBitrate: number;
  /** navigator.hardwareConcurrency, or undefined where the browser hides it. */
  cores?: number;
}): SegmentPlan {
  const { totalFrames, fps, videoBitrate } = options;
  const serial: SegmentPlan = { segments: [{ firstFrame: 0, frameCount: totalFrames }], workers: 1 };
  if (totalFrames <= 0) return { segments: [], workers: 1 };

  // Leave a core for the lead worker, which is muxing and writing to disk while
  // the segments render. An unknown core count assumes a modest machine.
  const cores = Math.max(1, Math.floor(options.cores ?? 4));
  const byCores = Math.min(MAX_SEGMENT_WORKERS, cores - 1);
  if (byCores < 2) return serial;

  const minFrames = Math.max(1, Math.ceil(MIN_SEGMENT_SECONDS * fps));
  // A render too short to hold two worthwhile slices is not worth splitting.
  if (totalFrames < minFrames * 2) return serial;

  const maxFramesByBytes = Math.max(
    minFrames,
    Math.floor((MAX_SEGMENT_BYTES / Math.max(1, videoBitrate / 8)) * fps),
  );

  // Two slices per worker, so a slice that turns out to be expensive (a dense
  // cut, a 4K source) does not leave the other workers idle at the end - but
  // never so few slices that one of them would blow the byte ceiling.
  const byMinLength = Math.floor(totalFrames / minFrames);
  const countByBytes = Math.ceil(totalFrames / maxFramesByBytes);
  const count = Math.max(2, Math.min(byMinLength, byCores * 2), countByBytes);

  const base = Math.floor(totalFrames / count);
  const remainder = totalFrames - base * count;
  const segments: SegmentPlan['segments'] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    // Spread the remainder over the first slices, so no slice is a single frame.
    const frameCount = base + (i < remainder ? 1 : 0);
    if (frameCount <= 0) continue;
    segments.push({ firstFrame: cursor, frameCount });
    cursor += frameCount;
  }
  return { segments, workers: Math.min(byCores, segments.length) };
}
