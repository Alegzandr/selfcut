import { describe, expect, it } from 'vitest';
import {
  SCOPE_LEVELS,
  computeHistogram,
  computeVectorscope,
  computeWaveform,
  luma601,
} from './scopes';

/** Build a `w × h` RGBA buffer from a per-pixel colour function. */
function rgba(w: number, h: number, at: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

describe('luma601', () => {
  it('maps pure white and black to the code endpoints', () => {
    expect(luma601(255, 255, 255)).toBe(255);
    expect(luma601(0, 0, 0)).toBe(0);
  });

  it('weights green the most, blue the least (BT.601)', () => {
    expect(luma601(0, 255, 0)).toBeGreaterThan(luma601(255, 0, 0));
    expect(luma601(255, 0, 0)).toBeGreaterThan(luma601(0, 0, 255));
  });
});

describe('computeHistogram', () => {
  it('puts every pixel of a flat frame in one bin per channel', () => {
    const data = rgba(4, 4, () => [10, 20, 30]);
    const h = computeHistogram(data);
    expect(h.r[10]).toBe(16);
    expect(h.g[20]).toBe(16);
    expect(h.b[30]).toBe(16);
    // Every other bin is empty.
    expect(h.r.reduce((a, b) => a + b, 0)).toBe(16);
  });

  it('peak ignores luma so a grey frame still shows its channels', () => {
    const data = rgba(2, 2, () => [128, 128, 128]);
    const h = computeHistogram(data);
    // All four pixels share the same grey: the channel peak is 4, and luma
    // (also 4 here) must not have inflated it beyond the channel counts.
    expect(h.peak).toBe(4);
    // Grey 128 floors to level 127 or 128 depending on float rounding; either
    // way the four pixels land in one bin and the total is 4.
    expect(h.luma[127]! + h.luma[128]!).toBe(4);
    expect(h.luma.reduce((a, b) => a + b, 0)).toBe(4);
  });
});

describe('computeWaveform', () => {
  it('places a column of constant luma on a single level', () => {
    const w = 3;
    const h = 5;
    // Column x is filled with luma value x*50 (constant down the column).
    const data = rgba(w, h, (x) => {
      const v = x * 50;
      return [v, v, v];
    });
    const grid = computeWaveform(data, w, h, 'luma');
    for (let x = 0; x < w; x++) {
      const level = luma601(x * 50, x * 50, x * 50);
      expect(grid[x * SCOPE_LEVELS + level]).toBe(h);
    }
  });

  it('reads the requested channel, not luma', () => {
    const data = rgba(1, 4, () => [200, 0, 0]);
    const red = computeWaveform(data, 1, 4, 'r');
    const blue = computeWaveform(data, 1, 4, 'b');
    expect(red[200]).toBe(4);
    expect(blue[0]).toBe(4);
  });
});

describe('computeVectorscope', () => {
  it('plots a neutral grey frame at the centre', () => {
    const size = 16;
    const data = rgba(4, 4, () => [128, 128, 128]);
    const grid = computeVectorscope(data, size);
    const half = size / 2;
    expect(grid[half * size + half]).toBe(16);
  });

  it('pushes a saturated red away from the centre', () => {
    const size = 16;
    const data = rgba(2, 2, () => [255, 0, 0]);
    const grid = computeVectorscope(data, size);
    const half = size / 2;
    // Nothing sits on the neutral point; the four red pixels land elsewhere.
    expect(grid[half * size + half]).toBe(0);
    expect(grid.reduce((a, b) => a + b, 0)).toBe(4);
  });
});
