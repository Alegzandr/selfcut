import { describe, expect, it } from 'vitest';
import { MediaClip } from '../types';
import { clipRotationAt, resolveBlur, resolveColor, resolveOpacity, resolveTransform } from './clip';

function clip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    kind: 'media',
    id: 'c1',
    assetId: 'a1',
    trackId: 't1',
    timelineStartMs: 1000,
    sourceInMs: 0,
    sourceOutMs: 2000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...over,
  };
}

describe('resolveTransform', () => {
  it('passes static transform values through when nothing is animated', () => {
    const c = clip({ transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.3, y: 0.7, scale: 2, rotation: 45 } });
    const rt = resolveTransform(c, 1500);
    expect(rt).toMatchObject({ x: 0.3, y: 0.7, scale: 2, rotation: 45 });
  });

  it('defaults to the identity transform when the clip has none', () => {
    const rt = resolveTransform(clip(), 1000);
    expect(rt).toMatchObject({ x: 0.5, y: 0.5, scale: 1, rotation: 0 });
  });

  it('samples an animated channel at the clip-local time (offset by timelineStartMs)', () => {
    // Keyframes are clip-local: t=0 is the clip's start at timelineStartMs=1000.
    const c = clip({
      animation: {
        x: [
          { t: 0, value: 0, ease: 'linear' },
          { t: 1000, value: 1, ease: 'linear' },
        ],
      },
    });
    expect(resolveTransform(c, 1000).x).toBeCloseTo(0, 6); // clip start
    expect(resolveTransform(c, 1500).x).toBeCloseTo(0.5, 6); // halfway
    expect(resolveTransform(c, 2000).x).toBeCloseTo(1, 6); // clip-local 1000ms
  });

  it('lets an animated property override its static counterpart', () => {
    const c = clip({
      transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.9, y: 0.5, scale: 1, rotation: 0 },
      animation: { x: [{ t: 0, value: 0.1 }] },
    });
    expect(resolveTransform(c, 1500).x).toBe(0.1);
    // A non-animated field on the same clip keeps its static value.
    expect(resolveTransform(c, 1500).y).toBe(0.5);
  });
});

describe('resolveOpacity', () => {
  it('is 1 when opacity is not animated', () => {
    expect(resolveOpacity(clip(), 1500)).toBe(1);
  });

  it('samples and clamps the opacity channel', () => {
    const c = clip({
      animation: {
        opacity: [
          { t: 0, value: 0, ease: 'linear' },
          { t: 1000, value: 1, ease: 'linear' },
        ],
      },
    });
    expect(resolveOpacity(c, 1000)).toBeCloseTo(0, 6);
    expect(resolveOpacity(c, 1500)).toBeCloseTo(0.5, 6);
    expect(resolveOpacity(c, 2000)).toBeCloseTo(1, 6);
  });

  it('clamps out-of-range keyframe values into 0..1', () => {
    const c = clip({ animation: { opacity: [{ t: 0, value: 5 }] } });
    expect(resolveOpacity(c, 1500)).toBe(1);
  });
});

describe('resolveColor', () => {
  it('is null when the clip has no grade', () => {
    expect(resolveColor(clip(), 1000)).toBeNull();
  });

  it('is null when every field is the identity', () => {
    expect(resolveColor(clip({ color: { brightness: 0, contrast: 0 } }), 1000)).toBeNull();
  });

  it('returns the resolved grade when any field is set', () => {
    const rc = resolveColor(clip({ color: { contrast: 0.4, saturation: -0.2 } }), 1000);
    expect(rc).toMatchObject({ contrast: 0.4, saturation: -0.2, brightness: 0, vignette: 0 });
  });

  it('samples a keyframed colour channel at the clip-local time', () => {
    const c = clip({
      color: {
        brightness: [
          { t: 0, value: 0, ease: 'linear' },
          { t: 1000, value: 1, ease: 'linear' },
        ],
      },
    });
    // Clip starts at timelineStartMs=1000, so 1500 is halfway through the ramp.
    expect(resolveColor(c, 1500)!.brightness).toBeCloseTo(0.5, 6);
  });
});

describe('resolveBlur', () => {
  it('is 0 with no colour or no blur', () => {
    expect(resolveBlur(clip(), 1000)).toBe(0);
    expect(resolveBlur(clip({ color: { saturation: 0.5 } }), 1000)).toBe(0);
  });

  it('reads a static blur and does not trigger the colour pass', () => {
    const c = clip({ color: { blur: 0.5 } });
    expect(resolveBlur(c, 1000)).toBe(0.5);
    // blur alone is not a colour grade, so the WebGL pass stays off.
    expect(resolveColor(c, 1000)).toBeNull();
  });

  it('samples a keyframed blur channel', () => {
    const c = clip({
      color: { blur: [{ t: 0, value: 0, ease: 'linear' }, { t: 1000, value: 1, ease: 'linear' }] },
    });
    expect(resolveBlur(c, 1500)).toBeCloseTo(0.5, 6);
  });
});

describe('clipRotationAt', () => {
  it('returns the static rotation when not animated', () => {
    const c = clip({ transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.5, y: 0.5, scale: 1, rotation: 30 } });
    expect(clipRotationAt(c, 1500)).toBe(30);
  });

  it('samples the animated rotation channel', () => {
    const c = clip({
      animation: {
        rotation: [
          { t: 0, value: 0, ease: 'linear' },
          { t: 1000, value: 90, ease: 'linear' },
        ],
      },
    });
    expect(clipRotationAt(c, 1500)).toBeCloseTo(45, 6);
  });
});
