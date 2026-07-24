import { describe, expect, it } from 'vitest';
import {
  buildCurveTexture,
  curvesAreIdentity,
  evalCurve,
  pointsAreIdentity,
} from './curves';
import type { ClipCurves } from '../types';

describe('evalCurve', () => {
  it('is the identity for a missing or ramp curve', () => {
    expect(evalCurve(undefined, 0.3)).toBeCloseTo(0.3, 5);
    expect(evalCurve([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.7)).toBeCloseTo(0.7, 5);
  });

  it('interpolates linearly between control points', () => {
    // A single lift point at the midpoint: (0,0) -> (0.5,0.8) -> (1,1).
    const pts = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.8 },
      { x: 1, y: 1 },
    ];
    expect(evalCurve(pts, 0.25)).toBeCloseTo(0.4, 5);
    expect(evalCurve(pts, 0.5)).toBeCloseTo(0.8, 5);
    expect(evalCurve(pts, 0.75)).toBeCloseTo(0.9, 5);
  });

  it('is flat beyond its first and last points and clamps to 0..1', () => {
    const pts = [
      { x: 0.2, y: 0.1 },
      { x: 0.8, y: 0.9 },
    ];
    expect(evalCurve(pts, 0)).toBeCloseTo(0.1, 5);
    expect(evalCurve(pts, 1)).toBeCloseTo(0.9, 5);
    // A point above 1 is clamped.
    expect(evalCurve([{ x: 0, y: 0 }, { x: 1, y: 2 }], 1)).toBe(1);
  });

  it('sorts unsorted input before evaluating', () => {
    const sorted = evalCurve([{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }], 0.5);
    const shuffled = evalCurve([{ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 0.5, y: 0.8 }], 0.5);
    expect(shuffled).toBeCloseTo(sorted, 5);
  });
});

describe('identity detection', () => {
  it('treats missing, short and ramp point lists as identity', () => {
    expect(pointsAreIdentity(undefined)).toBe(true);
    expect(pointsAreIdentity([{ x: 0, y: 0 }])).toBe(true);
    expect(pointsAreIdentity([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(true);
  });

  it('detects a bent curve as non-identity', () => {
    expect(pointsAreIdentity([{ x: 0, y: 0 }, { x: 0.5, y: 0.7 }, { x: 1, y: 1 }])).toBe(false);
    expect(pointsAreIdentity([{ x: 0, y: 0.2 }, { x: 1, y: 1 }])).toBe(false);
  });

  it('curvesAreIdentity is true only when every channel is neutral', () => {
    expect(curvesAreIdentity(undefined)).toBe(true);
    expect(curvesAreIdentity({})).toBe(true);
    const lifted: ClipCurves = { g: [{ x: 0, y: 0.1 }, { x: 1, y: 1 }] };
    expect(curvesAreIdentity(lifted)).toBe(false);
  });
});

describe('buildCurveTexture', () => {
  it('bakes the identity to a ramp in every channel', () => {
    const tex = buildCurveTexture({});
    for (const i of [0, 64, 128, 200, 255]) {
      expect(tex[i * 4]).toBe(i); // R
      expect(tex[i * 4 + 1]).toBe(i); // G
      expect(tex[i * 4 + 2]).toBe(i); // B
      expect(tex[i * 4 + 3]).toBe(i); // A = master
    }
  });

  it('puts the master curve in alpha and a channel curve in its slot', () => {
    const curves: ClipCurves = {
      master: [{ x: 0, y: 0 }, { x: 1, y: 0.5 }], // halves the master output
      r: [{ x: 0, y: 1 }, { x: 1, y: 1 }], // pins red high
    };
    const tex = buildCurveTexture(curves);
    // Master at full input -> 0.5 -> 127/128.
    expect(tex[255 * 4 + 3]).toBeGreaterThanOrEqual(127);
    expect(tex[255 * 4 + 3]).toBeLessThanOrEqual(128);
    // Red pinned to 1 across the range.
    expect(tex[0]).toBe(255);
    expect(tex[128 * 4]).toBe(255);
    // Green untouched (identity ramp).
    expect(tex[128 * 4 + 1]).toBe(128);
  });

  it('memoizes on the curve object', () => {
    const curves: ClipCurves = { master: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    expect(buildCurveTexture(curves)).toBe(buildCurveTexture(curves));
  });
});
