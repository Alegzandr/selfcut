/**
 * Deadlines for the parts of a render that can stop without ever failing.
 *
 * WebCodecs has a failure mode no `try`/`catch` can reach: an encoder accepts a
 * configuration it cannot actually sustain, and then produces nothing at all.
 * Nothing rejects and nothing throws - the promise for the next packet simply
 * never settles, so every layer above it waits for ever. What the user sees is
 * a progress bar that stops, an "estimating..." that never resolves, and an
 * export that has to be killed with the tab.
 *
 * It is not hypothetical: `playwright.config.ts` pins the full Chromium build
 * precisely because the headless shell ships a `VideoEncoder` that stalls
 * forever, and the note on `hardwareAcceleration` in `exportWorker` records the
 * same thing happening to a real preset on real hardware. Two testers have now
 * reported it from two different machines at two different resolutions, which
 * is the shape of a configuration the encoder takes and cannot deliver - not of
 * a bug in any one preset.
 *
 * So every await that can hang behind an encoder, a decoder or the main thread
 * gets a deadline. The numbers are watchdogs, not budgets: they are sized to be
 * unreachable by "slow" and reachable only by "stopped", because the cost of
 * firing early is a failed export that would have finished, while the cost of
 * never firing is the bug this file exists to end.
 */

/**
 * Something that was expected to make progress made none. Distinct from a
 * failure because it is actionable: a stalled ENCODER is retried on a software
 * one, where a rejected configuration is not retried at all.
 */
export class StalledError extends Error {
  constructor(
    /** What was being waited on, for the diagnostic the user can report. */
    readonly what: string,
    readonly afterMs: number,
  ) {
    super(`${what} stopped responding after ${Math.round(afterMs / 1000)}s`);
    this.name = 'StalledError';
  }
}

/**
 * Reject with a `StalledError` if `promise` has not settled within `ms`.
 *
 * The timer is always cleared, so a promise that wins does not leave one
 * pending until the deadline would have run - over thousands of frames that
 * would be thousands of live timers.
 *
 * The losing promise is deliberately left alone rather than cancelled: there is
 * nothing to cancel it with (WebCodecs offers no such handle), and `race` has
 * already attached a handler to it, so a rejection arriving after the deadline
 * cannot surface as an unhandled one.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StalledError(what, ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * How long one encode may take before the encoder counts as stopped.
 *
 * This is the wait for ONE frame's packet with the queue already full, not the
 * time a frame takes end to end: at the four-deep queue the render runs, the
 * encoder has three other frames in hand, so this only elapses when it has
 * stopped emitting entirely. The worst honest figure measured anywhere in the
 * project is a 38 s decode stall under memory pressure at 4K 120 (see
 * `MIN_SEGMENT_SECONDS`), and an encode is nowhere near that; three times over
 * it leaves the watchdog with no realistic way to fire on a working render.
 */
export const ENCODE_STALL_MS = 120_000;

/**
 * The same watchdog, before the encoder has produced anything at all.
 *
 * An encoder that has emitted a packet is working, and from then on the only
 * question is how fast. An encoder that has been handed a full queue and
 * emitted nothing has not started, and the failure this file exists for is
 * exactly that: accepted the configuration, delivering nothing. Waiting the
 * full two minutes to conclude it - and then again for each fallback - is time
 * the user spends watching a bar that will never move, so the un-started case
 * is given a shorter leash.
 *
 * Still generous against the work involved: this covers spinning up the encoder
 * session and returning ONE packet with three more frames already queued behind
 * it. The whole 4K 120 e2e render, a thousand frames of the heaviest preset the
 * app offers, is budgeted at 210 s.
 */
export const FIRST_ENCODE_STALL_MS = 45_000;

/**
 * How long one output frame may take to composite before the DECODERS count as
 * stopped.
 *
 * Larger than the encode figure because this covers a seek into every clip the
 * frame touches - at 120 fps with a two-second GOP that is a couple of hundred
 * frames of decode for a single output frame, and the measured worst case is
 * the 38 s stall above.
 */
export const FRAME_STALL_MS = 180_000;

/**
 * How long the one-frame encoder probe may take.
 *
 * Small on purpose: this runs before a single frame is rendered, it encodes
 * exactly one frame, and the whole point of it is to find a stalled encoder
 * quickly enough to fall back to a working one. A probe that has produced
 * nothing in fifteen seconds has produced nothing.
 */
export const PROBE_STALL_MS = 15_000;

/**
 * How long a render may spend loading the fonts its text clips use.
 *
 * The shortest deadline that ends in a render rather than a failure: a face
 * that has not arrived is cosmetic (`fontStack` already names a system
 * fallback), and an export held at zero frames waiting for one is not.
 */
export const FONT_STALL_MS = 30_000;

/**
 * How long tearing down an output or a renderer may take before it is
 * abandoned.
 *
 * Short, and deliberately shorter than everything above, because of WHEN it
 * runs: a teardown is on the way out of a failure, and it goes through the very
 * encoder or decoder that just stopped responding. Waiting the full encode
 * deadline here would mean every stalled render spent it twice - once noticing,
 * once cleaning up - before the fallback that fixes it could even start.
 *
 * Abandoning one costs nothing that matters: the worker is about to be
 * terminated either way, and the file handle a half-closed writable is holding
 * is waited out by `openWritable` on the next attempt.
 */
export const TEARDOWN_STALL_MS = 15_000;

/**
 * How long a `canEncodeVideo` / `canEncodeAudio` support query may take.
 *
 * These are the first thing an export does, and they answer from a table in
 * every browser that answers at all - so a query still outstanding after this
 * long is one that never intends to answer, and "no" is both the honest reading
 * and the one that keeps the export moving (the codec falls back, or the
 * fallback encoder is registered).
 */
export const SUPPORT_PROBE_MS = 10_000;

/**
 * How long the worker waits for a slice of the audio mix from the main thread.
 *
 * The mix is rendered five seconds at a time in an `OfflineAudioContext`, which
 * is fast even on a dense timeline; this only elapses if the main thread is
 * wedged or the reply was lost. Timing out truncates the soundtrack, exactly as
 * a failed slice does - a video with short audio beats a render that never ends.
 */
export const AUDIO_CHUNK_STALL_MS = 120_000;
