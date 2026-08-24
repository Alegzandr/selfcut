/**
 * Elapsed / remaining readout for an in-flight export.
 *
 * The exporter reports a single 0..1 ratio whose speed is far from uniform:
 * the offline audio mix owns the first 10 %, video frames the rest, and the
 * two run at wildly different rates. A naive `elapsed * (1 - p) / p` therefore
 * lies badly for the whole first half of the render. Instead the speed is
 * measured over a trailing window of samples, which forgets the mix as soon as
 * the video phase has filled the window.
 */

/** A progress reading: `progress` (0..1) observed at `atMs` on a monotonic clock. */
export interface ProgressSample {
  atMs: number;
  progress: number;
}

/** Speed is measured over at most this much recent history. */
const WINDOW_MS = 8_000;
/** Below this span the sample pair is too tight to divide by - the UI says "estimating". */
const MIN_SPAN_MS = 1_200;

/**
 * Append a reading and drop the samples that fell out of the trailing window.
 * A render that reports less often than the window is wide falls back to its
 * last two points, so there is always something to measure between.
 *
 * Repeated readings are ignored: the worker throttles its callbacks, and a
 * value that has not moved would shrink the window for nothing.
 *
 * A reading that moves BACKWARD is something else entirely - the render gave up
 * and started over on a slower encoder - and it clears the history rather than
 * being ignored. Kept, the abandoned attempt's samples would go on being
 * measured against the new attempt's progress, which reads as an estimate the
 * render has already outlived: the readout sits on "estimating" for as long as
 * it takes the new attempt to climb past where the old one died, which is
 * exactly the stretch where the user most needs to be told it is working.
 */
export function pushSample(
  samples: readonly ProgressSample[],
  sample: ProgressSample,
): ProgressSample[] {
  const last = samples[samples.length - 1];
  if (last && sample.progress < last.progress) return [sample];
  if (last && sample.progress === last.progress) return [...samples];
  const next = [...samples, sample];
  const cutoff = sample.atMs - WINDOW_MS;
  const inWindow = next.filter((s) => s.atMs >= cutoff);
  return inWindow.length >= 2 ? inWindow : next.slice(-2);
}

/**
 * Milliseconds left at `nowMs`, or null when there is nothing honest to show:
 * too little history yet, or an estimate the render has already outlived (a
 * stall, or the finalize step that sits at 0.99). "Estimating" beats a frozen
 * "0:00".
 */
export function estimateRemainingMs(
  samples: readonly ProgressSample[],
  nowMs: number,
): number | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return null;

  const span = last.atMs - first.atMs;
  const gained = last.progress - first.progress;
  if (span < MIN_SPAN_MS || gained <= 0) return null;
  if (last.progress >= 1) return 0;

  const remainingAtLast = ((1 - last.progress) / gained) * span;
  const sinceLast = Math.max(0, nowMs - last.atMs);
  if (sinceLast >= remainingAtLast) return null;
  return remainingAtLast - sinceLast;
}

/** Format a duration in ms → "m:ss", or "h:mm:ss" past the hour. Seconds are floored, clock-style. */
export function formatDuration(ms: number): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  const mm = m.toString().padStart(2, '0');
  const ss = s.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * Format a remaining duration. Rounded up, so a render with work left never
 * reads "0:00" - it counts down to "0:01" and then finishes.
 */
export function formatRemaining(ms: number): string {
  return formatDuration(Math.ceil(Math.max(0, ms) / 1000) * 1000);
}
