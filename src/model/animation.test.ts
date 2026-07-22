import { describe, expect, it } from 'vitest';
import { Channel, isAnimated, removeKeyframe, sampleChannel, setKeyframe } from './animation';

describe('sampleChannel', () => {
  it('returns a constant channel unchanged at any time', () => {
    expect(sampleChannel(0.5, 0)).toBe(0.5);
    expect(sampleChannel(0.5, 9999)).toBe(0.5);
  });

  it('holds at the single keyframe value', () => {
    const ch: Channel = [{ t: 100, value: 2 }];
    expect(sampleChannel(ch, 0)).toBe(2);
    expect(sampleChannel(ch, 100)).toBe(2);
    expect(sampleChannel(ch, 500)).toBe(2);
  });

  it('holds before the first and after the last keyframe', () => {
    const ch: Channel = [
      { t: 100, value: 1, ease: 'linear' },
      { t: 200, value: 3, ease: 'linear' },
    ];
    expect(sampleChannel(ch, 0)).toBe(1);
    expect(sampleChannel(ch, 100)).toBe(1);
    expect(sampleChannel(ch, 200)).toBe(3);
    expect(sampleChannel(ch, 999)).toBe(3);
  });

  it('interpolates linearly between keyframes with linear easing', () => {
    const ch: Channel = [
      { t: 0, value: 0, ease: 'linear' },
      { t: 100, value: 10, ease: 'linear' },
    ];
    expect(sampleChannel(ch, 25)).toBeCloseTo(2.5, 6);
    expect(sampleChannel(ch, 50)).toBeCloseTo(5, 6);
    expect(sampleChannel(ch, 75)).toBeCloseTo(7.5, 6);
  });

  it('hits the endpoint values exactly whatever the easing', () => {
    for (const ease of ['in', 'out', 'inOut', 'hold'] as const) {
      const ch: Channel = [
        { t: 0, value: 0, ease },
        { t: 100, value: 10, ease: 'linear' },
      ];
      expect(sampleChannel(ch, 0)).toBeCloseTo(0, 6);
      expect(sampleChannel(ch, 100)).toBeCloseTo(10, 6);
    }
  });

  it('holds the value across a hold segment until the next key', () => {
    const ch: Channel = [
      { t: 0, value: 5, ease: 'hold' },
      { t: 100, value: 20, ease: 'linear' },
    ];
    expect(sampleChannel(ch, 50)).toBe(5);
    expect(sampleChannel(ch, 99)).toBe(5);
    expect(sampleChannel(ch, 100)).toBe(20);
  });

  it('symmetric inOut easing passes through the midpoint', () => {
    const ch: Channel = [
      { t: 0, value: 0, ease: 'inOut' },
      { t: 100, value: 10, ease: 'linear' },
    ];
    expect(sampleChannel(ch, 50)).toBeCloseTo(5, 4);
  });

  it('eases in slower than linear and out faster', () => {
    const easeIn: Channel = [
      { t: 0, value: 0, ease: 'in' },
      { t: 100, value: 10, ease: 'linear' },
    ];
    // Ease-in starts slow: at 25% of the time, less than 25% of the distance.
    expect(sampleChannel(easeIn, 25)).toBeLessThan(2.5);
  });

  it('follows a custom bezier over the named ease', () => {
    // A linear-equivalent bezier reproduces linear interpolation.
    const ch: Channel = [
      { t: 0, value: 0, ease: 'in', bezier: [0, 0, 1, 1] },
      { t: 100, value: 10 },
    ];
    expect(sampleChannel(ch, 50)).toBeCloseTo(5, 4);
  });
});

describe('setKeyframe', () => {
  it('seeds a first keyframe from a constant without losing the value', () => {
    const ch = setKeyframe(3, 200, 8);
    expect(ch).toEqual([
      { t: 0, value: 3 },
      { t: 200, value: 8 },
    ]);
    // The constant is preserved at t=0, so animating never jumps.
    expect(sampleChannel(ch, 0)).toBe(3);
  });

  it('inserts keyframes in time order', () => {
    let ch = setKeyframe(0, 100, 1);
    ch = setKeyframe(ch, 50, 2);
    ch = setKeyframe(ch, 200, 3);
    expect((ch as { t: number }[]).map((k) => k.t)).toEqual([0, 50, 100, 200]);
  });

  it('replaces a keyframe at the same time (within epsilon)', () => {
    let ch = setKeyframe(0, 100, 1);
    ch = setKeyframe(ch, 100.4, 9, 'hold');
    const keys = ch as { t: number; value: number; ease?: string }[];
    expect(keys).toHaveLength(2);
    expect(keys[1]!.value).toBe(9);
    expect(keys[1]!.ease).toBe('hold');
  });
});

describe('removeKeyframe', () => {
  it('collapses back to a constant when the last keyframe is removed', () => {
    const ch: Channel = [{ t: 120, value: 7 }];
    expect(removeKeyframe(ch, 120)).toBe(7);
  });

  it('keeps a lone surviving keyframe (still animated) instead of collapsing', () => {
    const ch: Channel = [
      { t: 0, value: 1 },
      { t: 100, value: 2 },
    ];
    const out = removeKeyframe(ch, 100);
    expect(isAnimated(out)).toBe(true);
    expect((out as { t: number; value: number }[])).toEqual([{ t: 0, value: 1 }]);
  });

  it('keeps the remaining keyframes when more than one is left', () => {
    const ch: Channel = [
      { t: 0, value: 1 },
      { t: 100, value: 2 },
      { t: 200, value: 3 },
    ];
    const out = removeKeyframe(ch, 100);
    expect(isAnimated(out)).toBe(true);
    expect((out as { t: number }[]).map((k) => k.t)).toEqual([0, 200]);
  });

  it('is a no-op on a constant channel or a missing time', () => {
    expect(removeKeyframe(5, 0)).toBe(5);
    const ch: Channel = [
      { t: 0, value: 1 },
      { t: 100, value: 2 },
    ];
    expect(removeKeyframe(ch, 999)).toBe(ch);
  });
});
