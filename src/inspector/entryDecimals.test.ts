import { describe, expect, it } from 'vitest';
import { MAX_ENTRY_DECIMALS, decimalsForStep, seedDecimals, snapToStep } from './entryDecimals';

const percent = (v: number) => v * 100;
const toSeconds = (ms: number) => ms / 1000;
const identity = (v: number) => v;

describe('decimalsForStep', () => {
  it('reads a 0.01 fraction as whole percentage points', () => {
    expect(decimalsForStep(percent, 1.24, 0.01)).toBe(0);
  });

  it('keeps a tenth for a 100 ms step read as seconds', () => {
    expect(decimalsForStep(toSeconds, 1200, 100)).toBe(1);
  });

  it('keeps two decimals for a step finer than a tenth', () => {
    expect(decimalsForStep(toSeconds, 1200, 10)).toBe(2);
  });
});

describe('seedDecimals', () => {
  it('leaves a value the step already covers alone', () => {
    expect(seedDecimals(percent(1.24), 0)).toBe(0);
    expect(seedDecimals(percent(0.5), 0)).toBe(0);
  });

  // The whole point: a stretch dragged on the preview is no round percentage,
  // and seeding it as "124" would commit 124 % over a 123,7 % clip.
  it('widens past the step for a value a drag produced', () => {
    expect(seedDecimals(percent(1.2437), 0)).toBe(2);
    expect(seedDecimals(percent(1.237), 0)).toBe(1);
  });

  it('round-trips the value it seeds', () => {
    for (const stored of [1.2437, 1.237, 0.9912, 1 / 3, 0.5]) {
      const input = percent(stored);
      const seeded = Number(input.toFixed(seedDecimals(input, 0)));
      expect(Math.abs(seeded / 100 - stored)).toBeLessThan(1e-4);
    }
  });

  it('stops at the ceiling for an endless decimal', () => {
    expect(seedDecimals(percent(1 / 3), 0)).toBe(MAX_ENTRY_DECIMALS);
  });

  it('never drops below the floor the step asks for', () => {
    expect(seedDecimals(toSeconds(1200), 1)).toBe(1);
    expect(seedDecimals(identity(12), 2)).toBe(2);
  });
});

describe('snapToStep', () => {
  it('strips the float noise of min + n × step', () => {
    // What the range input hands over for a 57 % stretch from a 10 % floor.
    expect(snapToStep(0.1 + 47 * 0.01, 0.1, 0.01)).toBe(0.57);
    expect(snapToStep(0.02 + 13 * 0.01, 0.02, 0.01)).toBe(0.15);
  });

  it('keeps a whole-dB fader position exact enough to round-trip', () => {
    const step = 1 / 60;
    const pos = snapToStep(48 * step, 0, step);
    expect(Math.round(pos / step)).toBe(48);
    expect(pos).toBeCloseTo(0.8, 12);
  });

  it('leaves a value alone without a usable step', () => {
    expect(snapToStep(0.123, 0, 0)).toBe(0.123);
    expect(snapToStep(Infinity, 0, 1)).toBe(Infinity);
  });
});
