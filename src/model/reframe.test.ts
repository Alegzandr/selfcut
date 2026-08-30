import { describe, expect, it } from 'vitest';
import { MediaAsset, MediaClip } from '../types';
import { coverScale, isAutoFramed, reframedTransform } from './reframe';

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };
const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };

function clip(over: Partial<MediaClip> = {}): MediaClip {
  return {
    kind: 'media',
    id: 'c1',
    assetId: 'a1',
    trackId: 't1',
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: 2000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...over,
  };
}

const asset = (w: number, h: number) =>
  ({ id: 'a1', width: w, height: h }) as unknown as MediaAsset;

describe('coverScale', () => {
  it('is 1 when source and output already share a ratio', () => {
    expect(coverScale(LANDSCAPE, FULL_CROP, 1280, 720)).toBeCloseTo(1, 5);
  });

  it('is the ratio mismatch for 16:9 footage in a 9:16 frame', () => {
    // (16/9) / (9/16) = 3.16: the value the resize magnetism snaps to, and the
    // one that makes the black bands disappear.
    expect(coverScale(LANDSCAPE, FULL_CROP, 1080, 1920)).toBeCloseTo(3.1605, 3);
  });

  it('reads the CROPPED region, not the whole source', () => {
    // A 16:9 source cropped to a 9:16 window already matches a vertical frame.
    const crop = { x: 0.3, y: 0, w: 0.31640625, h: 1 };
    expect(coverScale(LANDSCAPE, crop, 1080, 1920)).toBeCloseTo(1, 3);
  });

  it('is symmetric: portrait footage in a landscape frame needs the same zoom', () => {
    expect(coverScale(PORTRAIT, FULL_CROP, 1920, 1080)).toBeCloseTo(
      coverScale(LANDSCAPE, FULL_CROP, 1080, 1920),
      5,
    );
  });
});

describe('isAutoFramed', () => {
  const cover = 3.1605;

  it('accepts a clip with no transform at all', () => {
    expect(isAutoFramed(clip(), cover)).toBe(true);
  });

  it('accepts a clip sitting at the cover scale this feature wrote', () => {
    const c = clip({ transform: { crop: FULL_CROP, x: 0.5, y: 0.5, scale: cover } });
    expect(isAutoFramed(c, cover)).toBe(true);
  });

  it('rejects a hand-set scale', () => {
    const c = clip({ transform: { crop: FULL_CROP, x: 0.5, y: 0.5, scale: 1.4 } });
    expect(isAutoFramed(c, cover)).toBe(false);
  });

  it('rejects a clip the user moved, stretched or rotated', () => {
    const base = { crop: FULL_CROP, x: 0.5, y: 0.5, scale: 1 };
    expect(isAutoFramed(clip({ transform: { ...base, x: 0.2 } }), cover)).toBe(false);
    expect(isAutoFramed(clip({ transform: { ...base, scaleX: 1.3 } }), cover)).toBe(false);
    expect(isAutoFramed(clip({ transform: { ...base, rotation: 5 } }), cover)).toBe(false);
  });

  it('rejects a clip whose framing is keyframed', () => {
    const c = clip({ animation: { scale: [{ t: 0, value: 1 }, { t: 500, value: 2 }] } });
    expect(isAutoFramed(c, cover)).toBe(false);
  });

  it('ignores animation on properties that are not the framing', () => {
    const c = clip({ animation: { opacity: [{ t: 0, value: 0 }, { t: 200, value: 1 }] } });
    expect(isAutoFramed(c, cover)).toBe(true);
  });
});

describe('reframedTransform', () => {
  const from = { width: 1920, height: 1080 };
  const to = { width: 1080, height: 1920 };

  it('fills: zooms an untouched landscape clip to cover a vertical frame', () => {
    const next = reframedTransform(clip(), asset(1920, 1080), from, to, 'fill');
    expect(next?.scale).toBeCloseTo(3.1605, 3);
    expect(next).toMatchObject({ x: 0.5, y: 0.5 });
  });

  it('fits: puts a filled clip back to the contain scale, bars and all', () => {
    const filled = clip({ transform: { crop: FULL_CROP, x: 0.5, y: 0.5, scale: 3.1605 } });
    // Already vertical here: `from` is the ratio the clip was filled for.
    const next = reframedTransform(filled, asset(1920, 1080), to, to, 'fit');
    expect(next?.scale).toBe(1);
  });

  it('is idempotent across successive ratio changes', () => {
    const a = asset(1920, 1080);
    const first = reframedTransform(clip(), a, from, to, 'fill')!;
    const second = reframedTransform(clip({ transform: first }), a, to, { width: 1080, height: 1080 }, 'fill');
    // Recognised as still automatic despite carrying the previous cover scale.
    expect(second?.scale).toBeCloseTo(16 / 9, 3);
  });

  it('leaves a hand-framed clip alone in both modes', () => {
    const hand = clip({ transform: { crop: FULL_CROP, x: 0.2, y: 0.5, scale: 1.4 } });
    expect(reframedTransform(hand, asset(1920, 1080), from, to, 'fill')).toBeNull();
    expect(reframedTransform(hand, asset(1920, 1080), from, to, 'fit')).toBeNull();
  });

  it('reports nothing to do when the scale would not change', () => {
    // Square source, square-ish move: cover is already 1 and the clip is at 1.
    expect(
      reframedTransform(clip({ transform: { crop: FULL_CROP, x: 0.5, y: 0.5, scale: 1 } }), asset(1000, 1000), from, { width: 1080, height: 1080 }, 'fill'),
    ).toBeNull();
  });

  it('keeps the crop the user set and reframes around it', () => {
    const crop = { x: 0.25, y: 0, w: 0.5, h: 1 };
    const cropped = clip({ transform: { crop, x: 0.5, y: 0.5, scale: 1 } });
    const next = reframedTransform(cropped, asset(1920, 1080), from, to, 'fill');
    expect(next?.crop).toEqual(crop);
    expect(next?.scale).toBeCloseTo(coverScale({ width: 1920, height: 1080 }, crop, 1080, 1920), 5);
  });

  it('skips a clip whose asset has no known dimensions', () => {
    expect(reframedTransform(clip(), undefined, from, to, 'fill')).toBeNull();
  });
});
