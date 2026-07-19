import { describe, it, expect } from 'vitest';
import { layoutTextLines } from './compositor';
import type { ClipText } from '../types';

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
