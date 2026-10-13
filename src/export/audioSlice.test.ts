import { describe, expect, it } from 'vitest';
import { preRolledSlice } from './audioSlice';

describe('preRolledSlice', () => {
  const SLICE = 5 * 48000;
  const PRE = 4 * 48000;

  it('renders the first slice from the start of the span, with nothing to drop', () => {
    expect(preRolledSlice(0, SLICE, PRE)).toEqual({
      renderOffset: 0,
      renderFrames: SLICE,
      discard: 0,
    });
  });

  it('starts a later slice a full pre-roll early and drops exactly that much', () => {
    expect(preRolledSlice(SLICE, SLICE, PRE)).toEqual({
      renderOffset: SLICE - PRE,
      renderFrames: SLICE + PRE,
      discard: PRE,
    });
  });

  it('never reaches before the span when the slice starts inside the pre-roll', () => {
    expect(preRolledSlice(1000, 500, PRE)).toEqual({
      renderOffset: 0,
      renderFrames: 1500,
      discard: 1000,
    });
  });

  it('keeps whole frames when the pre-roll is fractional', () => {
    const s = preRolledSlice(SLICE, SLICE, 4.6 * 44100.5);
    expect(Number.isInteger(s.renderOffset)).toBe(true);
    expect(s.renderOffset + s.discard).toBe(SLICE);
  });

  it('tiles the span sample-exactly: what each slice keeps abuts the next', () => {
    const total = 3 * SLICE + 12345;
    let next = 0;
    for (let offset = 0; offset < total; offset += SLICE) {
      const frames = Math.min(SLICE, total - offset);
      const s = preRolledSlice(offset, frames, PRE);
      // The kept part starts where the previous slice's ended, and ends where
      // the slice asked for does.
      expect(s.renderOffset + s.discard).toBe(next);
      expect(s.renderFrames - s.discard).toBe(frames);
      next = s.renderOffset + s.renderFrames;
    }
    expect(next).toBe(total);
  });
});
