/**
 * A brick-wall peak limiter for the export master, streaming.
 *
 * Normalizing a mix to a loudness target lifts a quiet mix by whatever it
 * takes, and what it takes routinely pushes a transient - a plosive, a snare -
 * past full scale. Clipping it is the one outcome worse than a mix that is a
 * little quiet, and holding the whole mix back for one plosive is what the
 * clip balance does (and reports). The master gets a limiter instead: the
 * loudness lands on the target, and the handful of samples that would have
 * clipped are turned down, briefly and inaudibly.
 *
 * Feed-forward with look-ahead. The gain a sample needs is known the moment it
 * is read; the gain APPLIED to it is the smallest needed by any sample in the
 * next `lookahead` frames, smoothed by a moving average of that same length.
 * The average is what turns the reduction into a linear ramp that lands
 * exactly when the peak does rather than a step - and since every value it
 * averages already accounts for the peak, the ramp never overshoots: the
 * output is under the ceiling at every sample, by construction. Release is a
 * first-order return to unity between peaks.
 *
 * The price of the look-ahead is that the output lags the input by `lookahead`
 * frames: `process` writes the limited signal in place, so its first call
 * yields `lookahead` frames of silence and the last `lookahead` frames of the
 * input are still inside the limiter when it returns. The caller feeds that
 * many extra frames (see `MasterChain`).
 *
 * Sample peaks, not true peaks: no oversampling. A -1 dBFS ceiling leaves the
 * inter-sample overs the encoder can add well under full scale.
 *
 * Pure module: `Float32Array` in, `Float32Array` out, no DOM and no Web Audio.
 */

/** How far the limiter sees ahead - and the attack of its ramp. */
export const LIMITER_LOOKAHEAD_MS = 5;
/** Time constant of the return to unity gain after a peak. */
export const LIMITER_RELEASE_MS = 100;

export class PeakLimiter {
  /** Frames of look-ahead: the delay between input and output. */
  readonly lookahead: number;
  private readonly ceiling: number;
  private readonly releaseCoef: number;
  /** The input, delayed: one ring per channel. */
  private delay: Float32Array[] = [];
  /** Gain each input frame needs on its own, by frame index modulo the ring. */
  private readonly need: Float32Array;
  /** Monotonic queue of frame indices for the sliding minimum of `need`. */
  private readonly queue: Float64Array;
  private queueHead = 0;
  private queueCount = 0;
  /** The last `lookahead` released gains, and their running sum. */
  private readonly window: Float32Array;
  private windowSum = 0;
  private released = 1;
  /** Frames read so far. */
  private read = 0;
  private reductionMin = 1;

  constructor(
    readonly sampleRate: number,
    /** Highest absolute sample the output may hold, linear (0.891 for -1 dBFS). */
    ceilingLinear: number,
    lookaheadMs = LIMITER_LOOKAHEAD_MS,
    releaseMs = LIMITER_RELEASE_MS,
  ) {
    if (!(sampleRate > 0) || !(ceilingLinear > 0)) {
      throw new RangeError(`PeakLimiter: invalid ceiling ${ceilingLinear} @ ${sampleRate} Hz`);
    }
    this.ceiling = ceilingLinear;
    this.lookahead = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000));
    this.releaseCoef = 1 - Math.exp(-1000 / (Math.max(1e-3, releaseMs) * sampleRate));
    this.need = new Float32Array(this.lookahead + 1);
    this.queue = new Float64Array(this.lookahead + 2);
    this.window = new Float32Array(this.lookahead);
  }

  /** Forget everything: the next call starts a new stream. */
  reset(): void {
    this.delay = [];
    this.queueHead = 0;
    this.queueCount = 0;
    this.windowSum = 0;
    this.released = 1;
    this.read = 0;
    this.reductionMin = 1;
  }

  /** The deepest gain reduction applied so far, in dB (0 when nothing was limited). */
  get maxReductionDb(): number {
    return this.reductionMin >= 1 ? 0 : -20 * Math.log10(this.reductionMin);
  }

  /**
   * Limit one piece, in place: `channels[c][i]` becomes the limited value of
   * the frame read `lookahead` frames earlier. Every channel shares one gain,
   * so the stereo image never shifts on a peak.
   */
  process(channels: Float32Array[]): void {
    const frames = channels[0]?.length ?? 0;
    const count = channels.length;
    if (frames === 0 || count === 0) return;
    const L = this.lookahead;
    if (this.delay.length !== count) {
      this.delay = Array.from({ length: count }, () => new Float32Array(L));
    }
    const { ceiling, need, queue, window, delay } = this;
    const ring = need.length;
    let { queueHead, queueCount, windowSum, released, read, reductionMin } = this;
    const releaseCoef = this.releaseCoef;

    for (let i = 0; i < frames; i++) {
      const k = read;
      // What this frame needs on its own.
      let peak = 0;
      for (let c = 0; c < count; c++) {
        const x = channels[c]![i]!;
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
      }
      const req = peak > ceiling ? ceiling / peak : 1;
      need[k % ring] = req;
      // Sliding minimum: drop every queued frame this one undercuts.
      while (queueCount > 0) {
        const last = queue[(queueHead + queueCount - 1) % queue.length]!;
        if (need[last % ring]! < req) break;
        queueCount--;
      }
      queue[(queueHead + queueCount) % queue.length] = k;
      queueCount++;

      // Swap the frame into the delay line for the one read L frames ago.
      const slot = k % L;
      const j = k - L;
      if (j < 0) {
        for (let c = 0; c < count; c++) {
          const line = delay[c]!;
          line[slot] = channels[c]![i]!;
          channels[c]![i] = 0;
        }
        read++;
        continue;
      }
      // The gain frame j gets: the least any frame in [j, j + L] needs...
      while (queue[queueHead % queue.length]! < j) {
        queueHead++;
        queueCount--;
      }
      const ahead = need[queue[queueHead % queue.length]! % ring]!;
      // ...held there by the release, which only ever lets it climb...
      released = Math.min(ahead, released + (1 - released) * releaseCoef);
      // ...and averaged over the last L frames into a ramp. The window is
      // seeded with the first value so the average never exceeds it.
      if (j === 0) {
        window.fill(released);
        windowSum = released * L;
      } else {
        const wslot = j % L;
        windowSum += released - window[wslot]!;
        window[wslot] = released;
      }
      const gain = windowSum / L;
      if (gain < reductionMin) reductionMin = gain;
      for (let c = 0; c < count; c++) {
        const line = delay[c]!;
        const out = line[slot]! * gain;
        line[slot] = channels[c]![i]!;
        channels[c]![i] = out;
      }
      read++;
    }

    this.queueHead = queueHead;
    this.queueCount = queueCount;
    this.windowSum = windowSum;
    this.released = released;
    this.read = read;
    this.reductionMin = reductionMin;
  }
}
