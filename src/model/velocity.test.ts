import { describe, expect, it } from 'vitest';
import {
  frozenTailMs,
  hasVelocity,
  rampPresetKeys,
  rampRange,
  rateAt,
  shiftVelocity,
  sliceVelocity,
  sourceOffsetAtTimeline,
  timelineAtSourceOffset,
  unreachedSourceMs,
  velocityMap,
} from './velocity';
import { clipDurationMs, clipRateAt, timelineToSourceMs } from './clip';
import type { Clip, Keyframe } from '../types';

/** A media clip spanning `spanMs` of source, starting at t = 0 on the timeline. */
function clip(spanMs: number, velocity?: Keyframe[], over: Partial<Clip> = {}): Clip {
  return {
    id: 'c1',
    assetId: 'a1',
    trackId: 't1',
    kind: 'media',
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: spanMs,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    velocity,
    ...over,
  } as Clip;
}

describe('hasVelocity', () => {
  it('is false without a ramp and false for an empty one', () => {
    expect(hasVelocity(clip(1000))).toBe(false);
    expect(hasVelocity(clip(1000, []))).toBe(false);
    expect(hasVelocity(clip(1000, [{ t: 0, value: 1 }]))).toBe(true);
  });
});

describe('rateAt', () => {
  it('multiplies the ramp by the clip speed', () => {
    const c = clip(1000, [{ t: 0, value: 0.5 }], { speed: 2 }) as never;
    expect(rateAt(c, 0)).toBeCloseTo(1);
  });

  it('clamps to the speed bounds the scalar control obeys', () => {
    const slow = clip(1000, [{ t: 0, value: 0.001 }]) as never;
    expect(rateAt(slow, 0)).toBeCloseTo(0.1);
    const fast = clip(1000, [{ t: 0, value: 100 }]) as never;
    expect(rateAt(fast, 0)).toBeCloseTo(8);
  });
});

describe('the integral', () => {
  it('matches the flat division when the ramp is constant', () => {
    for (const v of [0.25, 0.5, 1, 2, 4]) {
      const c = clip(4000, [{ t: 0, value: v }]);
      expect(clipDurationMs(c)).toBeCloseTo(4000 / v, 3);
    }
  });

  it('is exact on a linear ramp, where the integral is closed-form', () => {
    // 1x to 2x linearly over 1000 ms of source. Timeline time is
    // integral of ds/(1 + s/1000) = 1000 * ln(2).
    const c = clip(1000, [
      { t: 0, value: 1, ease: 'linear' },
      { t: 1000, value: 2 },
    ]);
    expect(clipDurationMs(c)).toBeCloseTo(1000 * Math.LN2, 1);
  });

  it('stretches the clip when slowed and shrinks it when sped up', () => {
    const slowed = clip(2000, [
      { t: 0, value: 1, ease: 'linear' },
      { t: 2000, value: 0.25 },
    ]);
    expect(clipDurationMs(slowed)).toBeGreaterThan(2000);
    const sped = clip(2000, [
      { t: 0, value: 1, ease: 'linear' },
      { t: 2000, value: 4 },
    ]);
    expect(clipDurationMs(sped)).toBeLessThan(2000);
  });
});

describe('inversion', () => {
  const ramped = clip(3000, [
    { t: 0, value: 1, ease: 'inOut' },
    { t: 1500, value: 0.25, ease: 'inOut' },
    { t: 3000, value: 2 },
  ]);

  it('round-trips source to timeline and back', () => {
    for (let s = 0; s <= 3000; s += 137) {
      const t = timelineAtSourceOffset(ramped as never, s);
      expect(sourceOffsetAtTimeline(ramped as never, t)).toBeCloseTo(s, 0);
    }
  });

  it('is monotonic in timeline time', () => {
    let prev = -1;
    const dur = clipDurationMs(ramped);
    for (let t = 0; t <= dur; t += dur / 200) {
      const s = sourceOffsetAtTimeline(ramped as never, t);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });

  it('clamps outside the window instead of reading past the source', () => {
    expect(sourceOffsetAtTimeline(ramped as never, -500)).toBe(0);
    expect(sourceOffsetAtTimeline(ramped as never, 1e9)).toBeCloseTo(3000, 3);
  });

  it('agrees with timelineToSourceMs, offset by the clip start', () => {
    const shifted = clip(3000, ramped.velocity, { timelineStartMs: 5000, sourceInMs: 250, sourceOutMs: 3250 });
    const local = 400;
    expect(timelineToSourceMs(shifted, 5000 + local)).toBeCloseTo(
      250 + sourceOffsetAtTimeline(shifted as never, local),
      6,
    );
  });
});

describe('lock', () => {
  const keys: Keyframe[] = [
    { t: 0, value: 1, ease: 'linear' },
    { t: 2000, value: 0.25 },
  ];

  it('freezes the duration at the un-ramped length', () => {
    const locked = clip(2000, keys, { velocityLocked: true, speed: 2 });
    expect(clipDurationMs(locked)).toBeCloseTo(1000);
    expect(clipDurationMs(clip(2000, keys, { speed: 2 }))).toBeGreaterThan(1000);
  });
});

describe('what the lock costs', () => {
  const slowing: Keyframe[] = [
    { t: 0, value: 1, ease: 'linear' },
    { t: 2000, value: 0.25 },
  ];
  const speeding: Keyframe[] = [
    { t: 0, value: 1, ease: 'linear' },
    { t: 2000, value: 4 },
  ];

  it('costs nothing while the clip is elastic', () => {
    const c = clip(2000, slowing);
    expect(unreachedSourceMs(c as never)).toBe(0);
    expect(frozenTailMs(c as never)).toBe(0);
  });

  it('leaves source unreached when the ramp slows the footage down', () => {
    const c = clip(2000, slowing, { velocityLocked: true });
    expect(unreachedSourceMs(c as never)).toBeGreaterThan(0);
    // Nothing freezes: the clip is still playing picture at its last frame.
    expect(frozenTailMs(c as never)).toBe(0);
  });

  it('freezes a tail when the ramp speeds the footage up', () => {
    const c = clip(2000, speeding, { velocityLocked: true });
    expect(frozenTailMs(c as never)).toBeGreaterThan(0);
    expect(unreachedSourceMs(c as never)).toBe(0);
    // The frozen stretch plus what the ramp takes is the whole locked duration.
    const map = velocityMap(c as never);
    expect(map.spanMs + frozenTailMs(c as never)).toBeCloseTo(clipDurationMs(c), 3);
  });

  it('never reports both losses at once', () => {
    for (const keys of [slowing, speeding]) {
      const c = clip(2000, keys, { velocityLocked: true });
      expect(unreachedSourceMs(c as never) * frozenTailMs(c as never)).toBe(0);
    }
  });
});

describe('rampRange', () => {
  it('reports the slowest and fastest rate reached', () => {
    const c = clip(2000, [
      { t: 0, value: 1 },
      { t: 1000, value: 0.25 },
      { t: 2000, value: 3 },
    ]);
    const { min, max } = rampRange(c as never);
    expect(min).toBeCloseTo(0.25);
    expect(max).toBeCloseTo(3);
  });
});

describe('clipRateAt', () => {
  it('returns the flat speed without a ramp', () => {
    expect(clipRateAt(clip(1000, undefined, { speed: 0.5 }), 400)).toBe(0.5);
  });

  it('follows the curve with one', () => {
    const c = clip(2000, [
      { t: 0, value: 1, ease: 'linear' },
      { t: 2000, value: 0.5 },
    ]);
    expect(clipRateAt(c, 0)).toBeCloseTo(1, 2);
    expect(clipRateAt(c, clipDurationMs(c))).toBeCloseTo(0.5, 2);
  });
});

describe('slicing and shifting', () => {
  const keys: Keyframe[] = [
    { t: 0, value: 1, ease: 'linear' },
    { t: 1000, value: 0.5, ease: 'linear' },
    { t: 2000, value: 1 },
  ];

  it('keeps the speed at the seam when a ramp is razored', () => {
    const left = sliceVelocity(keys, 0, 1400)!;
    const right = sliceVelocity(keys, 1400, 2000)!;
    const at = (v: Keyframe[], t: number) => rateAt(clip(2000, v) as never, t);
    expect(at(left, 1400)).toBeCloseTo(at(right, 0), 6);
  });

  it('moves keys the opposite way to a left trim', () => {
    const trimmed = shiftVelocity(keys, 300);
    expect(trimmed[0]!.t).toBeCloseTo(-300);
    expect(trimmed[1]!.t).toBeCloseTo(700);
  });
});

describe('presets', () => {
  it('lay onto any window length and stay inside it', () => {
    for (const id of ['slowDown', 'speedUp', 'highlight', 'whip'] as const) {
      const keys = rampPresetKeys(id, 4000);
      expect(keys.length).toBeGreaterThan(1);
      for (const k of keys) {
        expect(k.t).toBeGreaterThanOrEqual(0);
        expect(k.t).toBeLessThanOrEqual(4000);
      }
      expect(clipDurationMs(clip(4000, keys))).toBeGreaterThan(0);
    }
  });
});

describe('the cumulative table', () => {
  it('is rebuilt when the source window moves under the same curve', () => {
    const keys: Keyframe[] = [{ t: 0, value: 0.5 }];
    const a = clip(1000, keys);
    const b = clip(1000, keys, { sourceOutMs: 2000 });
    expect(velocityMap(a as never).spanMs).toBeCloseTo(2000);
    expect(velocityMap(b as never).spanMs).toBeCloseTo(4000);
  });

  it('is reused for an untouched curve', () => {
    const c = clip(1000, [{ t: 0, value: 0.5 }]);
    expect(velocityMap(c as never)).toBe(velocityMap(c as never));
  });
});
