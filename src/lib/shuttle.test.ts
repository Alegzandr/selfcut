import { describe, expect, it } from 'vitest';
import { shuttleStep } from './shuttle';

/** L. */
const l = (rate: number, playing = true) => shuttleStep(rate, playing, 1);
/** J. */
const j = (rate: number, playing = true) => shuttleStep(rate, playing, -1);

describe('shuttleStep', () => {
  it('starts playback in the direction of the pressed key', () => {
    expect(l(1, false)).toEqual({ rate: 1, playing: true });
    // The whole point: J from a stopped transport plays backwards.
    expect(j(1, false)).toEqual({ rate: -1, playing: true });
  });

  it('doubles the speed while it goes the same way, up to 8x', () => {
    expect(l(1).rate).toBe(2);
    expect(l(4).rate).toBe(8);
    expect(l(8).rate).toBe(8);
    expect(j(-1).rate).toBe(-2);
    expect(j(-4).rate).toBe(-8);
    expect(j(-8).rate).toBe(-8);
  });

  it('comes back to 1x from a slow rung rather than doubling into another', () => {
    expect(l(0.25).rate).toBe(1);
    expect(j(-0.5).rate).toBe(-1);
  });

  it('halves the speed when pressed against the direction of travel', () => {
    expect(l(-2).rate).toBe(-1);
    expect(j(2).rate).toBe(1);
    expect(j(1).rate).toBe(0.5);
    expect(j(0.5).rate).toBe(0.25);
  });

  it('turns around at 1x once the slow end is reached', () => {
    expect(j(0.25).rate).toBe(-1);
    expect(l(-0.25).rate).toBe(1);
  });
});
