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
 * Every segment pays for its own worker boot, its own encoder configuration and
 * its own seek into each clip it touches. It also gets its own rate-control
 * window, and that is the binding constraint: measured on a one-minute render,
 * splitting into eight slices produced a file HALF the size of the serial one,
 * because no encoder ever ran long enough to settle at the target bitrate.
 * Fifteen seconds is long enough for that to be a rounding error and still
 * short enough to keep several workers busy on any render worth splitting.
 */
export const MIN_SEGMENT_SECONDS = 15;

/**
 * Ceiling on the encoded bytes one segment holds before it is handed back.
 *
 * A segment is buffered whole, in memory, in its worker. At the 60 Mbps of the
 * 4K preset a thirty-second slice would be 225 MB - per worker. Capping the
 * BYTES rather than the seconds keeps a 4K render's slices short and a 720p
 * render's slices long, which is what each of them wants.
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
