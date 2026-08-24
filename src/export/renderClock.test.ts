import { describe, it, expect } from 'vitest';
import { pushSample, estimateRemainingMs, formatDuration, formatRemaining } from './renderClock';
import type { ProgressSample } from './renderClock';

/** Feed a whole series through pushSample, the way the sheet does. */
function series(samples: ProgressSample[]): ProgressSample[] {
  return samples.reduce<ProgressSample[]>((acc, s) => pushSample(acc, s), []);
}

describe('pushSample', () => {
  it('drops a repeated reading', () => {
    const got = series([
      { atMs: 0, progress: 0 },
      { atMs: 500, progress: 0.1 },
      { atMs: 900, progress: 0.1 },
    ]);
    expect(got.map((s) => s.atMs)).toEqual([0, 500]);
  });

  /**
   * This case used to be folded in with the one above, on the reading that both
   * are "progress that did not move forward". They are not the same event: a
   * repeated value is the worker throttling its callbacks, and a value that
   * DROPS is the exporter putting the bar back to the start of a new attempt
   * after the encoder stalled. Treating the second as the first left the
   * abandoned attempt in the window - see the restart tests below.
   */
  it('restarts the history when progress drops', () => {
    const got = series([
      { atMs: 0, progress: 0 },
      { atMs: 500, progress: 0.1 },
      { atMs: 1200, progress: 0.05 },
    ]);
    expect(got).toEqual([{ atMs: 1200, progress: 0.05 }]);
  });

  it('forgets samples older than the window', () => {
    const got = series([
      { atMs: 0, progress: 0 },
      { atMs: 1_000, progress: 0.1 },
      { atMs: 5_000, progress: 0.3 },
      { atMs: 12_000, progress: 0.6 },
    ]);
    // The 8 s window at t=12 000 starts at 4 000: only 5 000 and 12 000 survive.
    expect(got.map((s) => s.atMs)).toEqual([5_000, 12_000]);
  });

  it('never shrinks below two samples, however far apart they are', () => {
    const got = series([
      { atMs: 0, progress: 0 },
      { atMs: 60_000, progress: 0.5 },
    ]);
    expect(got).toHaveLength(2);
  });
});

describe('estimateRemainingMs', () => {
  it('extrapolates from the measured speed', () => {
    // 25 % in 5 s → 20 s of work left at the same rate.
    const samples = series([
      { atMs: 0, progress: 0 },
      { atMs: 5_000, progress: 0.25 },
    ]);
    expect(estimateRemainingMs(samples, 5_000)).toBe(15_000);
  });

  it('counts down between samples', () => {
    const samples = series([
      { atMs: 0, progress: 0 },
      { atMs: 5_000, progress: 0.25 },
    ]);
    expect(estimateRemainingMs(samples, 7_000)).toBe(13_000);
  });

  it('ignores the audio-mix phase once the window has moved past it', () => {
    // The mix burns 10 s for 10 % of the bar, then video runs 10× faster.
    const samples = series([
      { atMs: 0, progress: 0 },
      { atMs: 10_000, progress: 0.1 },
      { atMs: 14_000, progress: 0.5 },
      { atMs: 18_000, progress: 0.9 },
    ]);
    // Measured over 10 000 → 18 000: 0.8 in 8 s, so 0.1 left is 1 s - not the
    // ~2 s a whole-render average would claim.
    expect(estimateRemainingMs(samples, 18_000)).toBeCloseTo(1_000, 6);
  });

  it('returns null before there is enough history', () => {
    expect(estimateRemainingMs([], 0)).toBeNull();
    expect(estimateRemainingMs([{ atMs: 0, progress: 0 }], 500)).toBeNull();
    const tight = series([
      { atMs: 0, progress: 0 },
      { atMs: 400, progress: 0.01 },
    ]);
    expect(estimateRemainingMs(tight, 400)).toBeNull();
  });

  it('returns null when no progress was gained over the window', () => {
    const flat: ProgressSample[] = [
      { atMs: 0, progress: 0.4 },
      { atMs: 9_000, progress: 0.4 },
    ];
    expect(estimateRemainingMs(flat, 9_000)).toBeNull();
  });

  it('gives up rather than freeze at zero once the estimate is outlived', () => {
    const samples = series([
      { atMs: 0, progress: 0 },
      { atMs: 5_000, progress: 0.9 },
    ]);
    // ~556 ms were left at t=5 000; a stall past that is no longer an estimate.
    expect(estimateRemainingMs(samples, 5_400)).toBeCloseTo(156, 0);
    expect(estimateRemainingMs(samples, 6_000)).toBeNull();
  });

  it('is zero once the bar is full', () => {
    const samples = series([
      { atMs: 0, progress: 0 },
      { atMs: 5_000, progress: 1 },
    ]);
    expect(estimateRemainingMs(samples, 5_000)).toBe(0);
  });
});

describe('formatDuration', () => {
  it('floors to whole seconds, clock-style', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(999)).toBe('0:00');
    expect(formatDuration(7_400)).toBe('0:07');
    expect(formatDuration(83_000)).toBe('1:23');
  });

  it('grows an hour field only when needed', () => {
    expect(formatDuration(3_599_000)).toBe('59:59');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
  });

  it('treats a negative duration as zero', () => {
    expect(formatDuration(-5_000)).toBe('0:00');
  });
});

describe('formatRemaining', () => {
  it('rounds up so work left never reads as none', () => {
    expect(formatRemaining(1)).toBe('0:01');
    expect(formatRemaining(7_400)).toBe('0:08');
    expect(formatRemaining(0)).toBe('0:00');
  });
});

describe('pushSample across a restart', () => {
  /**
   * The encoder stalled, the render started over on the software one, and the
   * exporter put the bar back to where that attempt begins. Everything measured
   * before that describes a render that no longer exists.
   */
  it('forgets the abandoned attempt when progress goes backwards', () => {
    let samples = pushSample([], { atMs: 0, progress: 0 });
    samples = pushSample(samples, { atMs: 2_000, progress: 0.4 });
    samples = pushSample(samples, { atMs: 4_000, progress: 0.6 });
    samples = pushSample(samples, { atMs: 130_000, progress: 0.1 });
    expect(samples).toEqual([{ atMs: 130_000, progress: 0.1 }]);
  });

  it('recovers a real estimate from the new attempt alone', () => {
    let samples = pushSample([], { atMs: 0, progress: 0.6 });
    samples = pushSample(samples, { atMs: 1_000, progress: 0.1 });
    samples = pushSample(samples, { atMs: 3_000, progress: 0.2 });
    // 10% in 2 s, 80% to go: 16 s. Without the reset the window still held the
    // 0.6 reading and no honest estimate was possible at all.
    expect(estimateRemainingMs(samples, 3_000)).toBeCloseTo(16_000, -2);
  });

  it('still ignores a repeated reading', () => {
    let samples = pushSample([], { atMs: 0, progress: 0.2 });
    samples = pushSample(samples, { atMs: 500, progress: 0.2 });
    expect(samples).toHaveLength(1);
  });
});
