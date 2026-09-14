import { MAX_DB, MIN_DB, dbToGain } from './gain';

/**
 * Integrated loudness, the way broadcast meters measure it (ITU-R BS.1770-4),
 * and the gain that brings a clip to a target.
 *
 * "Balance the volumes" cannot be done on peaks: two clips with the same peak
 * can differ by 15 dB in how loud they SOUND (a voice with one plosive against
 * a bed of music). What matches how loud something sounds is K-weighted,
 * gated, mean-square power - LUFS - which is also what every platform the
 * export is aimed at (YouTube, TikTok, Spotify) normalizes on.
 *
 * The meter is streaming on purpose. A clip's source is decoded in 30 s
 * segments (see `media/audioSegments.ts`) that the cache may evict as soon as
 * the next one arrives, so the measurement has to consume each piece as it
 * comes and keep only what the gate needs: one number per 100 ms. An hour of
 * audio is 36 000 numbers, whatever its sample rate or channel count.
 *
 * Pure module: `Float32Array` in, numbers out, no DOM and no Web Audio.
 */

/** Length of a gating block, and the hop between two overlapping blocks. */
const BLOCK_MS = 400;
const HOP_MS = 100;
/** Sub-blocks per block: 400 ms measured every 100 ms is 75% overlap. */
const SUBS_PER_BLOCK = BLOCK_MS / HOP_MS;

/** Blocks quieter than this are not programme: the absolute gate. */
const ABSOLUTE_GATE_LUFS = -70;
/** Blocks this far under the ungated loudness are pauses: the relative gate. */
const RELATIVE_GATE_LU = -10;

/**
 * The offset that makes a 997 Hz sine read as its own dBFS level: it cancels
 * the K-weighting's gain at 1 kHz. From the standard, not tuned.
 */
const LUFS_OFFSET = -0.691;

/** A second-order IIR section in direct form II transposed. */
interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * The two K-weighting stages, designed for THIS sample rate.
 *
 * The standard tabulates coefficients for 48 kHz only; footage arrives at 44.1
 * and 96 too, and a filter run at the wrong rate shifts its corner by the same
 * ratio - a 4 dB shelf landing at 1.5 kHz instead of 1.7 reads voices a
 * quarter of a dB off. Both stages are re-derived from their analogue
 * prototypes through the bilinear transform at the actual rate, the way
 * libebur128 does it; at 48 kHz that reproduces the standard's own table to
 * every printed decimal.
 */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
  // Stage 1: the head-shape shelf, +4 dB above ~1.7 kHz.
  const shelf = (() => {
    const f0 = 1681.974450955533;
    const gainDb = 3.999843853973347;
    const q = 0.7071752369554196;
    const k = Math.tan((Math.PI * f0) / sampleRate);
    const vh = 10 ** (gainDb / 20);
    const vb = vh ** 0.4996667741545416;
    const a0 = 1 + k / q + k * k;
    return {
      b0: (vh + (vb * k) / q + k * k) / a0,
      b1: (2 * (k * k - vh)) / a0,
      b2: (vh - (vb * k) / q + k * k) / a0,
      a1: (2 * (k * k - 1)) / a0,
      a2: (1 - k / q + k * k) / a0,
    };
  })();
  // Stage 2: the RLB high-pass, rolling off below ~38 Hz.
  const highpass = (() => {
    const f0 = 38.13547087602444;
    const q = 0.5003270373238773;
    const k = Math.tan((Math.PI * f0) / sampleRate);
    const a0 = 1 + k / q + k * k;
    return {
      b0: 1,
      b1: -2,
      b2: 1,
      a1: (2 * (k * k - 1)) / a0,
      a2: (1 - k / q + k * k) / a0,
    };
  })();
  return [shelf, highpass];
}

/** The per-channel filter memory: two delay cells per stage. */
interface ChannelState {
  s1: number;
  s2: number;
  h1: number;
  h2: number;
}

/**
 * How much each channel counts in the sum, by position in the file's layout.
 *
 * Mono and stereo, which is what this editor sees, weigh 1 throughout. A 5.1
 * source (L R C LFE Ls Rs) drops its LFE and lifts the surrounds by 1.5 dB,
 * per the standard; anything else is treated as front channels.
 */
function channelWeights(count: number): number[] {
  const out = new Array<number>(count).fill(1);
  if (count === 6) {
    out[3] = 0;
    out[4] = 1.41;
    out[5] = 1.41;
  }
  return out;
}

/** What one measurement answers. */
export interface LoudnessResult {
  /** Integrated loudness in LUFS; -Infinity for silence (nothing passed the gate). */
  lufs: number;
  /** Highest absolute sample seen, 0..1 (can exceed 1 for float sources). */
  peak: number;
}

/**
 * A streaming BS.1770 meter. Feed it every channel of every piece of a source,
 * in order, then read `result()`.
 */
export class LoudnessMeter {
  private readonly weights: number[];
  private readonly filters: [Biquad, Biquad];
  private readonly state: ChannelState[];
  /** Frames in one 100 ms sub-block. */
  private readonly subFrames: number;
  /** Running sum of weighted squares in the sub-block being filled. */
  private subSum = 0;
  private subCount = 0;
  /** Mean power of every completed sub-block, oldest first. */
  private readonly subs: number[] = [];
  /** Mean power of every completed 400 ms block. */
  private readonly blocks: number[] = [];
  private peakValue = 0;

  constructor(
    readonly sampleRate: number,
    readonly channelCount: number,
  ) {
    if (!(sampleRate > 0) || !(channelCount > 0)) {
      throw new RangeError(`LoudnessMeter: invalid format ${channelCount}ch @ ${sampleRate} Hz`);
    }
    this.weights = channelWeights(channelCount);
    this.filters = kWeighting(sampleRate);
    this.state = Array.from({ length: channelCount }, () => ({ s1: 0, s2: 0, h1: 0, h2: 0 }));
    this.subFrames = Math.max(1, Math.round((sampleRate * HOP_MS) / 1000));
  }

  /**
   * Feed one piece: one array per channel, all the same length. A piece with
   * fewer channels than the meter was built for is read as silence on the
   * missing ones; extra channels are ignored.
   */
  process(channels: Float32Array[]): void {
    const frames = channels[0]?.length ?? 0;
    if (frames === 0) return;
    const [shelf, hp] = this.filters;
    // Weighted squares of every channel, summed frame by frame, so a sub-block
    // boundary falls at the same frame for all of them.
    if (this.row.length < frames) this.row = new Float64Array(frames);
    const row = this.row;
    for (let ch = 0; ch < this.channelCount; ch++) {
      const weight = this.weights[ch]!;
      const data = channels[ch];
      if (!data || weight === 0) continue;
      const st = this.state[ch]!;
      let { s1, s2, h1, h2 } = st;
      let peak = this.peakValue;
      // Two transposed direct-form II sections in series, per sample. Locals
      // throughout: the inner loop must not write object properties.
      for (let i = 0; i < frames; i++) {
        const x = data[i]!;
        const ax = x < 0 ? -x : x;
        if (ax > peak) peak = ax;
        const y1 = shelf.b0 * x + s1;
        s1 = shelf.b1 * x - shelf.a1 * y1 + s2;
        s2 = shelf.b2 * x - shelf.a2 * y1;
        const y2 = hp.b0 * y1 + h1;
        h1 = hp.b1 * y1 - hp.a1 * y2 + h2;
        h2 = hp.b2 * y1 - hp.a2 * y2;
        row[i] = row[i]! + weight * y2 * y2;
      }
      st.s1 = s1;
      st.s2 = s2;
      st.h1 = h1;
      st.h2 = h2;
      this.peakValue = peak;
    }
    for (let i = 0; i < frames; i++) {
      this.subSum += row[i]!;
      row[i] = 0;
      if (++this.subCount === this.subFrames) this.closeSub();
    }
  }

  /** Scratch accumulators, one per frame of the largest piece seen. */
  private row = new Float64Array(0);

  private closeSub(): void {
    this.subs.push(this.subSum / this.subFrames);
    this.subSum = 0;
    this.subCount = 0;
    const n = this.subs.length;
    if (n >= SUBS_PER_BLOCK) {
      let sum = 0;
      for (let k = n - SUBS_PER_BLOCK; k < n; k++) sum += this.subs[k]!;
      this.blocks.push(sum / SUBS_PER_BLOCK);
      // Only the last three sub-blocks can still contribute to a block.
      this.subs.splice(0, n - (SUBS_PER_BLOCK - 1));
    }
  }

  /** Integrated loudness of everything fed so far, and the sample peak. */
  result(): LoudnessResult {
    return { lufs: this.integrated(), peak: this.peakValue };
  }

  private integrated(): number {
    let blocks = this.blocks;
    if (blocks.length === 0) {
      // Shorter than one gating block (a 300 ms stinger, a single word): the
      // standard has no answer, and "unmeasurable" would leave that clip the
      // one thing the balance skips. Its whole length is read as one block.
      const partial = [...this.subs];
      if (this.subCount > 0) partial.push(this.subSum / this.subCount);
      if (partial.length === 0) return -Infinity;
      blocks = [partial.reduce((a, b) => a + b, 0) / partial.length];
    }
    const loud = (power: number) => LUFS_OFFSET + 10 * Math.log10(power);
    const absolute = blocks.filter((p) => loud(p) > ABSOLUTE_GATE_LUFS);
    if (absolute.length === 0) return -Infinity;
    const ungated = loud(absolute.reduce((a, b) => a + b, 0) / absolute.length);
    const threshold = ungated + RELATIVE_GATE_LU;
    const gated = absolute.filter((p) => loud(p) > threshold);
    if (gated.length === 0) return -Infinity;
    return loud(gated.reduce((a, b) => a + b, 0) / gated.length);
  }
}

/**
 * The level every balanced clip is brought to.
 *
 * -16 LUFS is where spoken-word and short-form video sit: loud enough that a
 * phone speaker carries it, under the -14 the big platforms turn content DOWN
 * to (so they leave it alone), and with a couple of dB of headroom for the
 * music bed the track fader ducks under it. Exposed so the read-out and the
 * hint say the same number the maths uses.
 */
export const TARGET_LUFS = -16;

/**
 * Where the loudest sample of a balanced clip may land. Lifting a quiet clip
 * to the target can push a transient past full scale; a clip whose gain has to
 * be held back for this is reported as "limited" rather than silently left
 * quieter than the rest.
 */
export const PEAK_CEILING_DB = -1;

/** What the balance decided for one clip. */
export interface BalanceDecision {
  /** Linear gain to store as the clip's volume. */
  gain: number;
  /**
   * The clip could not be brought all the way to the target: the peak
   * ceiling or the fader's own range (+12 dB) decided the gain instead. It
   * stays off the level of the rest, and the report says so.
   */
  limited: boolean;
}

/**
 * The volume that brings a measurement to the target, quantized to the 0.1 dB
 * every fader stores so the inspector reads back exactly what was set.
 *
 * Null for a clip with nothing to measure (silence): leaving its volume alone
 * beats cranking an empty room up by +12 dB.
 */
export function balanceGain(
  measured: LoudnessResult,
  targetLufs = TARGET_LUFS,
  peakCeilingDb = PEAK_CEILING_DB,
): BalanceDecision | null {
  if (!isFinite(measured.lufs)) return null;
  const wanted = targetLufs - measured.lufs;
  // The most the clip can be lifted before its loudest sample crosses the
  // ceiling. A source with no measurable peak (all-zero, which the LUFS check
  // above already excluded) never limits.
  const peakDb = measured.peak > 0 ? 20 * Math.log10(measured.peak) : -Infinity;
  const room = peakCeilingDb - peakDb;
  const db = Math.min(MAX_DB, Math.max(MIN_DB, Math.min(wanted, room)));
  return { gain: dbToGain(Math.round(db * 10) / 10), limited: db !== wanted };
}

/**
 * The level the exported master is brought to.
 *
 * -14 LUFS is what YouTube, Spotify and TikTok normalize to: a file delivered
 * there is played back untouched, and one delivered at the clip target (-16)
 * is left alone too but sits 2 dB under everything around it. Distinct from
 * `TARGET_LUFS` on purpose - the clips are balanced against each other with
 * headroom for the mix, the mix is delivered at the platforms' level.
 */
export const MASTER_TARGET_LUFS = -14;

/**
 * How much of the lift the master limiter is allowed to absorb, in dB.
 *
 * Bringing a mix to the target can push its peaks over the ceiling; the
 * limiter turns those down, and a few dB of that on a handful of transients
 * is inaudible. Past this it stops being a safety and becomes the sound - a
 * mix that needs 10 dB of limiting to reach -14 is pumping - so the gain is
 * held back instead and the report says by how much.
 */
export const MAX_LIMITING_DB = 6;

/** What the master normalization decided for one export. */
export interface MasterNormalization {
  /** The mix as measured, before the gain. */
  measuredLufs: number;
  /** Gain applied to the whole mix, in dB, to a tenth. */
  gainDb: number;
  /** Where the mix lands: measured plus gain. */
  resultLufs: number;
  /**
   * The mix could not be brought all the way to the target without more
   * limiting than `MAX_LIMITING_DB`, and was held short of it.
   */
  limited: boolean;
}

/**
 * The gain that brings a measured mix to the master target.
 *
 * Null for a silent mix: there is nothing to normalize, and lifting nothing by
 * +60 dB only lifts the noise floor. A hot mix is turned down all the way; a
 * quiet one is lifted until its peaks would need more limiting than the
 * limiter is trusted with.
 */
export function masterNormalization(
  measured: LoudnessResult,
  targetLufs = MASTER_TARGET_LUFS,
  peakCeilingDb = PEAK_CEILING_DB,
  maxLimitingDb = MAX_LIMITING_DB,
): MasterNormalization | null {
  if (!isFinite(measured.lufs)) return null;
  const wanted = targetLufs - measured.lufs;
  const peakDb = measured.peak > 0 ? 20 * Math.log10(measured.peak) : -Infinity;
  const room = peakCeilingDb - peakDb + maxLimitingDb;
  const db = Math.round(Math.min(wanted, room) * 10) / 10;
  return {
    measuredLufs: measured.lufs,
    gainDb: db,
    resultLufs: measured.lufs + db,
    limited: db < Math.round(wanted * 10) / 10,
  };
}
