import { describe, it, expect } from 'vitest';
import { clipDestRect, layoutTextLines } from './compositor';
import type { ClipText, ClipTransform, MediaClip } from '../types';

/**
 * Stand-in for a 2D context: every glyph is 10 units wide, so a line's width is
 * its length × 10 and the expected breaks can be worked out by hand. Node has no
 * canvas, and the real `measureText` would make the assertions font-dependent
 * anyway.
 */
const ctx = {
  measureText: (s: string) => ({ width: s.length * 10 }),
} as unknown as Parameters<typeof layoutTextLines>[0];

/** `widthFrac` of an outW of 100 gives a box of `widthFrac * 100` units. */
const text = (content: string, widthFrac = 1): ClipText => ({
  content,
  color: '#fff',
  sizeFrac: 0.05,
  widthFrac,
});

describe('layoutTextLines', () => {
  it('leaves a line that fits untouched', () => {
    expect(layoutTextLines(ctx, text('abc'), 100)).toEqual(['abc']);
  });

  it('keeps explicit line breaks, including empty lines', () => {
    expect(layoutTextLines(ctx, text('ab\n\ncd'), 100)).toEqual(['ab', '', 'cd']);
  });

  it('wraps on word boundaries at the box width', () => {
    // Box = 50 units = 5 glyphs. "aaa bbb" is 7, so it has to break.
    expect(layoutTextLines(ctx, text('aaa bbb', 0.5), 100)).toEqual(['aaa', 'bbb']);
  });

  it('fits as many words per line as the box allows', () => {
    // Box = 70 units = 7 glyphs: "aa bb" is 5, adding "cc" would make 8.
    expect(layoutTextLines(ctx, text('aa bb cc dd', 0.7), 100)).toEqual(['aa bb', 'cc dd']);
  });

  it('hard-breaks a single word too long for the box', () => {
    // No space to break on: overflowing the frame would be worse than a split.
    expect(layoutTextLines(ctx, text('abcdefgh', 0.3), 100)).toEqual(['abc', 'def', 'gh']);
  });

  it('wraps each paragraph independently', () => {
    expect(layoutTextLines(ctx, text('aaa bbb\nccc', 0.5), 100)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('collapses the runs of whitespace it wraps on', () => {
    expect(layoutTextLines(ctx, text('aaa   bbb', 0.5), 100)).toEqual(['aaa', 'bbb']);
  });

  it('defaults to a box narrower than the frame', () => {
    // 10 glyphs = 100 units fits the frame exactly, but not the default 90% box.
    expect(layoutTextLines(ctx, { ...text('aaaaa bbbbb'), widthFrac: undefined }, 100)).toEqual([
      'aaaaa',
      'bbbbb',
    ]);
  });
});

/** A media clip carrying `transform`, with the timing fields a resolve needs. */
function mediaClip(transform?: Partial<ClipTransform>): MediaClip {
  return {
    kind: 'media',
    id: 'c1',
    assetId: 'a1',
    trackId: 't1',
    timelineStartMs: 0,
    sourceInMs: 0,
    sourceOutMs: 1000,
    speed: 1,
    volume: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    ...(transform
      ? { transform: { crop: { x: 0, y: 0, w: 1, h: 1 }, x: 0.5, y: 0.5, scale: 1, ...transform } }
      : {}),
  };
}

/**
 * The motivating case for the per-axis stretch: 4:3 footage (1440x1080) in a
 * 16:9 frame. The "contain" fit draws it 1440 wide, leaving a 240px black bar
 * on each side.
 */
describe('clipDestRect', () => {
  const SRC_W = 1440;
  const SRC_H = 1080;
  const OUT_W = 1920;
  const OUT_H = 1080;
  const rect = (clip: MediaClip) => clipDestRect(clip, SRC_W, SRC_H, OUT_W, OUT_H);

  it('letterboxes 4:3 footage in a 16:9 frame when nothing is stretched', () => {
    const r = rect(mediaClip());
    expect(r.dw).toBeCloseTo(1440, 6);
    expect(r.dh).toBeCloseTo(1080, 6);
    expect(r.dx).toBeCloseTo(240, 6);
  });

  it('fills the frame when the width is stretched to the fill ratio', () => {
    const r = rect(mediaClip({ scaleX: OUT_W / SRC_W }));
    expect(r.dw).toBeCloseTo(1920, 6);
    expect(r.dx).toBeCloseTo(0, 6);
    // The axis that was not stretched is untouched: this is a stretch, not a zoom.
    expect(r.dh).toBeCloseTo(1080, 6);
  });

  it('stretches each axis independently', () => {
    const r = rect(mediaClip({ scaleX: 2, scaleY: 0.5 }));
    expect(r.dw).toBeCloseTo(2880, 6);
    expect(r.dh).toBeCloseTo(540, 6);
  });

  it('multiplies the uniform scale rather than replacing it', () => {
    const r = rect(mediaClip({ scale: 2, scaleX: 1.5 }));
    expect(r.dw).toBeCloseTo(1440 * 2 * 1.5, 6);
    expect(r.dh).toBeCloseTo(1080 * 2, 6);
  });

  it('reads a clip saved before stretch existed as undeformed', () => {
    // No `transform` at all, and a transform whose stretch keys are absent: both
    // have to draw exactly what they drew before the feature landed.
    const bare = rect(mediaClip());
    const legacy = rect(mediaClip({ scale: 1, rotation: 30 }));
    expect(legacy.dw).toBeCloseTo(bare.dw, 6);
    expect(legacy.dh).toBeCloseTo(bare.dh, 6);
  });

  it('keeps the clip centred on its transform position while stretching', () => {
    const r = rect(mediaClip({ scaleX: 2, x: 0.25 }));
    expect(r.dx + r.dw / 2).toBeCloseTo(0.25 * OUT_W, 6);
  });
});
