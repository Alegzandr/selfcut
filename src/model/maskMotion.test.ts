import { describe, expect, it } from 'vitest';
import { resolveMaskMotion } from './clip';
import type { ClipMask } from '../types';

const base: ClipMask = { shape: 'ellipse', x: 0.5, y: 0.5, w: 0.5, h: 0.5, feather: 0 };

describe('resolveMaskMotion', () => {
  it('is the identity when the mask has no motion', () => {
    expect(resolveMaskMotion(base, 0)).toEqual({ tx: 0, ty: 0, scale: 1, rotation: 0 });
  });

  it('reads constant motion channels', () => {
    const m: ClipMask = { ...base, motion: { tx: 0.2, scale: 1.5, rotation: 30 } };
    expect(resolveMaskMotion(m, 999)).toEqual({ tx: 0.2, ty: 0, scale: 1.5, rotation: 30 });
  });

  it('interpolates keyframed motion over clip-local time', () => {
    const m: ClipMask = {
      ...base,
      motion: {
        tx: [
          { t: 0, value: 0 },
          { t: 1000, value: 0.4 },
        ],
      },
    };
    expect(resolveMaskMotion(m, 0).tx).toBeCloseTo(0, 5);
    expect(resolveMaskMotion(m, 500).tx).toBeCloseTo(0.2, 5);
    expect(resolveMaskMotion(m, 1000).tx).toBeCloseTo(0.4, 5);
  });
});
