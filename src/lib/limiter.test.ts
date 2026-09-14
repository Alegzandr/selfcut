import { describe, expect, it } from 'vitest';
import { PeakLimiter } from './limiter';

const SR = 48_000;
const CEILING = 10 ** (-1 / 20);

function sine(db: number, seconds: number, freq = 1000): Float32Array[] {
  const amp = 10 ** (db / 20);
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return [l, l.slice()];
}

function peakOf(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) for (const x of ch) peak = Math.max(peak, Math.abs(x));
  return peak;
}

/** Run `input` through a fresh limiter, in pieces of `chunk` frames. */
function limit(input: Float32Array[], chunk = input[0]!.length): Float32Array[] {
  const limiter = new PeakLimiter(SR, CEILING);
  const out = input.map((ch) => ch.slice());
  for (let at = 0; at < out[0]!.length; at += chunk) {
    limiter.process(out.map((ch) => ch.subarray(at, Math.min(at + chunk, ch.length))));
  }
  return out;
}

describe('PeakLimiter', () => {
  it('delays a signal under the ceiling by exactly its look-ahead, untouched', () => {
    const limiter = new PeakLimiter(SR, CEILING);
    const input = sine(-20, 0.5);
    const out = limit(input);
    const L = limiter.lookahead;
    expect(L).toBe(240);
    for (let i = 0; i < L; i++) expect(out[0]![i]).toBe(0);
    for (let i = L; i < out[0]!.length; i++) {
      expect(out[0]![i]).toBeCloseTo(input[0]![i - L]!, 6);
    }
    expect(limiter.maxReductionDb).toBe(0);
  });

  it('holds every sample under the ceiling, however hot the input', () => {
    const out = limit(sine(6, 1));
    expect(peakOf(out)).toBeLessThanOrEqual(CEILING * (1 + 1e-6));
    // And still loud: a limiter that answered with silence would pass the line above.
    expect(peakOf(out)).toBeGreaterThan(CEILING * 0.99);
  });

  it('catches a lone transient without a step: the ramp lands with the peak', () => {
    const n = SR;
    const l = new Float32Array(n);
    // A -20 dBFS bed with one full-scale spike at half a second.
    for (let i = 0; i < n; i++) l[i] = 0.1 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    l[n / 2] = 1;
    const limiter = new PeakLimiter(SR, CEILING);
    const out = [l.slice(), l.slice()];
    limiter.process(out);
    const L = limiter.lookahead;
    const at = n / 2 + L;
    expect(Math.abs(out[0]![at]!)).toBeLessThanOrEqual(CEILING * (1 + 1e-6));
    expect(Math.abs(out[0]![at]!)).toBeGreaterThan(CEILING * 0.99);
    // The gain ramps down over the look-ahead that precedes the spike:
    // untouched before that, halfway down in the middle of the ramp, and all
    // the way down as the spike arrives.
    const gainAt = (i: number) => Math.abs(out[0]![i]! / l[i - L]!);
    expect(gainAt(at - L - 1)).toBeCloseTo(1, 6);
    const mid = gainAt(at - L / 2);
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(CEILING);
    expect(gainAt(at - 1)).toBeCloseTo(CEILING, 4);
    // And recovers: by the end of the second (five release constants later)
    // the bed is back to unity.
    const later = n - 1;
    expect(Math.abs(out[0]![later]! / l[later - L]!)).toBeCloseTo(1, 2);
    expect(limiter.maxReductionDb).toBeCloseTo(1, 1);
  });

  it('is the same signal whatever the piece size it is fed in', () => {
    const input = sine(3, 0.7);
    input[0]![1000] = 1.5;
    input[1]![1000] = -1.5;
    const whole = limit(input);
    const pieces = limit(input, 1234);
    expect(pieces[0]).toEqual(whole[0]);
    expect(pieces[1]).toEqual(whole[1]);
  });

  it('applies one gain to every channel', () => {
    const input = sine(-20, 0.2);
    input[0]![5000] = 2;
    const out = limit(input);
    const L = new PeakLimiter(SR, CEILING).lookahead;
    // The right channel had no spike, and is turned down all the same.
    expect(Math.abs(out[1]![5000 + L]!)).toBeLessThan(Math.abs(input[1]![5000]!) * 0.6);
  });
});
