import { describe, expect, it } from 'vitest';
import {
  LINE_INSET_PX,
  RATE_DETENTS,
  linePosToRate,
  rateToLinePos,
  rateToTopPx,
  snapRate,
  topPxToRate,
} from './velocityLine';

describe('the log axis', () => {
  it('puts unity in the middle', () => {
    expect(rateToLinePos(1)).toBeCloseTo(0.5);
  });

  it('places half and double the same distance either side of unity', () => {
    const below = 0.5 - rateToLinePos(0.5);
    const above = rateToLinePos(2) - 0.5;
    expect(below).toBeCloseTo(above);
  });

  it('reaches the edges at two octaves and pins beyond', () => {
    expect(rateToLinePos(0.25)).toBeCloseTo(0);
    expect(rateToLinePos(4)).toBeCloseTo(1);
    expect(rateToLinePos(0.1)).toBe(0);
    expect(rateToLinePos(8)).toBe(1);
  });

  it('round-trips inside the span', () => {
    for (const rate of [0.25, 0.4, 0.5, 1, 1.7, 2, 4]) {
      expect(linePosToRate(rateToLinePos(rate))).toBeCloseTo(rate, 6);
    }
  });

  it('survives a nonsensical rate instead of returning NaN', () => {
    expect(rateToLinePos(0)).toBe(0.5);
    expect(rateToLinePos(-1)).toBe(0.5);
  });
});

describe('detents', () => {
  it('snap a near miss onto the round rate', () => {
    expect(snapRate(1.01)).toBe(1);
    expect(snapRate(0.503)).toBe(0.5);
  });

  it('leave a rate between detents alone', () => {
    expect(snapRate(0.8)).toBe(0.8);
  });

  it('are all reachable, so none is shadowed by its neighbour', () => {
    for (const detent of RATE_DETENTS) expect(snapRate(detent)).toBe(detent);
  });
});

describe('pixel mapping', () => {
  const H = 64;

  it('keeps both extremes inside the clip', () => {
    expect(rateToTopPx(8, H)).toBeGreaterThanOrEqual(LINE_INSET_PX - 0.001);
    expect(rateToTopPx(0.1, H)).toBeLessThanOrEqual(H - LINE_INSET_PX + 0.001);
  });

  it('round-trips', () => {
    for (const rate of [0.25, 0.5, 1, 2, 4]) {
      expect(topPxToRate(rateToTopPx(rate, H), H)).toBeCloseTo(rate, 6);
    }
  });

  it('does not divide by zero on a collapsed track', () => {
    expect(Number.isFinite(rateToTopPx(1, 0))).toBe(true);
    expect(Number.isFinite(topPxToRate(0, 0))).toBe(true);
  });
});
