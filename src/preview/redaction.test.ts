import { describe, expect, it } from 'vitest';
import { mosaicGrid, redactionBlurRadiusPx, redactionCellPx } from './compositor';

describe('redactionBlurRadiusPx', () => {
  it('scales with the region, not with the frame', () => {
    // The same strength on a region twice as large blurs twice as hard, so the
    // setting reads the same on a face as on a wall.
    expect(redactionBlurRadiusPx(0.5, 400)).toBeCloseTo(redactionBlurRadiusPx(0.5, 200) * 2);
  });

  it('still blurs at strength 0, and harder as it rises', () => {
    expect(redactionBlurRadiusPx(0, 300)).toBeGreaterThan(1);
    expect(redactionBlurRadiusPx(1, 300)).toBeGreaterThan(redactionBlurRadiusPx(0.5, 300));
  });

  it('never returns a sub-pixel radius on a tiny region', () => {
    expect(redactionBlurRadiusPx(0, 2)).toBe(1);
  });

  it('clamps a strength outside 0..1', () => {
    expect(redactionBlurRadiusPx(5, 300)).toBe(redactionBlurRadiusPx(1, 300));
    expect(redactionBlurRadiusPx(-2, 300)).toBe(redactionBlurRadiusPx(0, 300));
  });
});

describe('redactionCellPx', () => {
  it('goes from many cells across the region to few', () => {
    const short = 400;
    expect(short / redactionCellPx(0, short)).toBeGreaterThan(20);
    expect(short / redactionCellPx(1, short)).toBeLessThan(5);
  });

  it('keeps a cell big enough to actually hide something', () => {
    expect(redactionCellPx(0, 10)).toBeGreaterThanOrEqual(3);
  });
});

describe('mosaicGrid', () => {
  it('anchors the grid to the frame, not to the region', () => {
    // A region nudged by less than one cell - a tracked face drifting - must
    // keep the same cell origin, or the whole mosaic crawls frame to frame.
    const a = mosaicGrid({ x: 100, y: 100, w: 200, h: 200 }, 16, 1920, 1080);
    const b = mosaicGrid({ x: 103, y: 101, w: 200, h: 200 }, 16, 1920, 1080);
    expect(a.x0).toBe(96);
    expect(b.x0).toBe(96);
    expect(b.y0).toBe(a.y0);
  });

  it('covers the whole region, including the partial cells at both ends', () => {
    const g = mosaicGrid({ x: 100, y: 50, w: 200, h: 100 }, 16, 1920, 1080);
    expect(g.x0).toBeLessThanOrEqual(100);
    expect(g.x0 + g.cols * 16).toBeGreaterThanOrEqual(300);
    expect(g.y0 + g.rows * 16).toBeGreaterThanOrEqual(150);
  });

  it('clamps the sampled rect to the frame at the far edge', () => {
    // The grid's last column overhangs the frame; sampling past it would make
    // the browser rescale the destination and shift every cell.
    const g = mosaicGrid({ x: 1900, y: 1000, w: 20, h: 80 }, 32, 1920, 1080);
    expect(g.x0 + g.gw).toBeLessThanOrEqual(1920);
    expect(g.y0 + g.gh).toBeLessThanOrEqual(1080);
    expect(g.gw).toBeGreaterThan(0);
    expect(g.gh).toBeGreaterThan(0);
  });
});
