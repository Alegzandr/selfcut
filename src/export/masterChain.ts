import {
  LoudnessMeter,
  PEAK_CEILING_DB,
  masterNormalization,
  type MasterNormalization,
} from '../lib/loudness';
import { PeakLimiter } from '../lib/limiter';

/**
 * The master stage of an export's audio: measure the whole mix, then serve it
 * a slice at a time with one gain and a limiter on it.
 *
 * The mix is rendered on demand (see `AudioMixRenderer`), and normalizing it
 * needs its integrated loudness, which only exists once every slice has been
 * heard. So the mix is rendered twice: once through the meter, for the
 * number, then once more into the encoder with that number applied. The first
 * pass runs while the video encodes, and the second is what the encoder was
 * going to pull anyway; the cost is one extra audio render, which is a small
 * fraction of any video export and roughly doubles an mp3 one.
 *
 * Slices are served in order, and the limiter's look-ahead reaches into the
 * slice after the one being served: every request renders that much further
 * than it returns, and holds the overrun for the next one. A request that does
 * not continue the previous one (the encoder started over on gentler terms,
 * see `retryPlan`) primes the stream afresh at its own offset.
 */

/** Renders `frames` of the raw mix from `offset`, one array per channel. */
export type RawMixRenderer = (offset: number, frames: number) => Promise<Float32Array[]>;

export class MasterChain {
  private decision: Promise<MasterNormalization | null> | null = null;
  private limiter: PeakLimiter | null = null;
  /** Frame the next request has to start at to continue the stream. */
  private streamPos = -1;
  /** First raw frame not yet rendered into the limiter. */
  private rawPos = 0;

  constructor(
    private readonly raw: RawMixRenderer,
    private readonly sampleRate: number,
    private readonly channelCount: number,
    private readonly totalFrames: number,
    private readonly sliceFrames: number,
  ) {}

  /**
   * Measure the mix, once. Started explicitly so it can overlap the video
   * render; `render` waits on it. Resolves null - and the mix is then served
   * as it is - when the measurement was cut short or found only silence.
   */
  measure(
    isCanceled: () => boolean = () => false,
    onProgress?: (fraction: number) => void,
  ): Promise<MasterNormalization | null> {
    if (this.decision) return this.decision;
    this.decision = (async () => {
      const meter = new LoudnessMeter(this.sampleRate, this.channelCount);
      for (let offset = 0; offset < this.totalFrames; offset += this.sliceFrames) {
        if (isCanceled()) return null;
        const frames = Math.min(this.sliceFrames, this.totalFrames - offset);
        meter.process(await this.raw(offset, frames));
        onProgress?.((offset + frames) / this.totalFrames);
      }
      return masterNormalization(meter.result());
    })().catch((err: unknown) => {
      // A slice that failed to render fails the same way on the encoder's
      // pass, where the export truncates the mix and says so; here it only
      // means the level stays as it was.
      console.warn('[export] loudness measurement failed, exporting the mix as is:', err);
      return null;
    });
    return this.decision;
  }

  /** The `frames` of finished master starting at `offset`. */
  async render(offset: number, frames: number): Promise<Float32Array[]> {
    const decision = await this.measure();
    if (!decision) return this.raw(offset, frames);
    const gain = 10 ** (decision.gainDb / 20);
    const limiter = (this.limiter ??= new PeakLimiter(this.sampleRate, 10 ** (PEAK_CEILING_DB / 20)));
    const L = limiter.lookahead;

    const priming = offset !== this.streamPos;
    if (priming) {
      limiter.reset();
      this.rawPos = offset;
    }
    const rawTo = offset + frames + L;
    const raw = await this.raw(this.rawPos, rawTo - this.rawPos);
    // Nothing past the end of the export may steer the limiter: the raw render
    // reaches a look-ahead beyond it, into whatever follows a region's out
    // point on the timeline.
    const tail = this.totalFrames - this.rawPos;
    for (const ch of raw) {
      for (let i = Math.max(0, tail); i < ch.length; i++) ch[i] = 0;
      for (let i = 0; i < ch.length; i++) ch[i] = ch[i]! * gain;
    }
    limiter.process(raw);
    this.rawPos = rawTo;
    this.streamPos = offset + frames;
    // Primed, the first L frames out are the limiter's own delay, and the L
    // frames after `frames` are the look-ahead - held inside the limiter for
    // the next request. Continuing, the render is exactly the frames asked.
    // Copied out either way: the buffers are transferred to the worker whole.
    return raw.map((ch) => (priming ? ch.slice(L, L + frames) : ch.slice(0, frames)));
  }
}
