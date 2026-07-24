import { describe, expect, it } from 'vitest';
import { maskBoundsPx } from './compositor';
import type { ClipMask } from '../types';

const base: ClipMask = { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0 };

describe('maskBoundsPx', () => {
  it('centres a half-size mask in the frame', () => {
    const b = maskBoundsPx(base, 1920, 1080);
    expect(b.cx).toBe(960);
    expect(b.cy).toBe(540);
    expect(b.w).toBe(960);
    expect(b.h).toBe(540);
    // Top-left is the centre minus half the size.
    expect(b.left).toBe(960 - 480);
    expect(b.top).toBe(540 - 270);
  });

  it('tracks an off-centre, differently-sized mask', () => {
    const b = maskBoundsPx({ ...base, x: 0.25, y: 0.75, w: 0.2, h: 0.4 }, 1000, 800);
    expect(b.cx).toBe(250);
    expect(b.cy).toBe(600);
    expect(b.w).toBe(200);
    expect(b.h).toBe(320);
    expect(b.left).toBe(150);
    expect(b.top).toBe(440);
  });
});
