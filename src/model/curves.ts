import type { ClipCurves, CurvePoint } from '../types';

/**
 * Tone-curve maths — pure, shared by the preview and the export, so a curve
 * grades a clip identically wherever it is drawn.
 *
 * A curve is a list of control points in 0..1 (x = input, y = output). The
 * colour pass reads it as a 256-entry 1D lookup, so this module's job is to
 * evaluate the piecewise-linear curve and bake the four channels (R, G, B and
 * the master) into the single RGBA texture the shader samples.
 */

export const CURVE_CHANNELS = ['master', 'r', 'g', 'b'] as const;
export type CurveChannel = (typeof CURVE_CHANNELS)[number];

/** The neutral ramp: input maps to itself. A fresh channel starts here. */
export const IDENTITY_POINTS: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Whether a point list is the identity ramp (or too short to grade). */
export function pointsAreIdentity(points: CurvePoint[] | undefined): boolean {
  if (!points || points.length < 2) return true;
  if (points.length !== 2) return false;
  const p0 = points[0]!;
  const p1 = points[1]!;
  const a = p0.x <= p1.x ? p0 : p1;
  const b = p0.x <= p1.x ? p1 : p0;
  return a.x === 0 && a.y === 0 && b.x === 1 && b.y === 1;
}

/** Whether every channel of a curve set is the identity — the skip-the-pass case. */
export function curvesAreIdentity(curves: ClipCurves | undefined): boolean {
  if (!curves) return true;
  return CURVE_CHANNELS.every((ch) => pointsAreIdentity(curves[ch]));
}

/**
 * Output (0..1) of a piecewise-linear curve at input `x` (0..1). The curve is
 * flat beyond its first and last control points, and points are sorted here so
 * a caller may pass them in any order.
 */
export function evalCurve(points: CurvePoint[] | undefined, x: number): number {
  const pts =
    points && points.length >= 2 ? [...points].sort((a, b) => a.x - b.x) : [...IDENTITY_POINTS];
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (x <= first.x) return clamp01(first.y);
  if (x >= last.x) return clamp01(last.y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const q = pts[i + 1]!;
    if (x >= p.x && x <= q.x) {
      const t = q.x === p.x ? 0 : (x - p.x) / (q.x - p.x);
      return clamp01(p.y + (q.y - p.y) * t);
    }
  }
  return clamp01(last.y);
}

/**
 * Memoized RGBA byte texture for a curve set: 256 texels wide, where texel `i`
 * holds (R, G, B) = the per-channel curves evaluated at code `i` and A = the
 * master curve at `i`. Keyed on the `ClipCurves` object so a static grade bakes
 * once and re-renders reuse it; a fresh object (any edit) bakes anew.
 */
const cache = new WeakMap<ClipCurves, Uint8Array>();

export function buildCurveTexture(curves: ClipCurves): Uint8Array {
  const cached = cache.get(curves);
  if (cached) return cached;
  const tex = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    tex[i * 4] = Math.round(evalCurve(curves.r, x) * 255);
    tex[i * 4 + 1] = Math.round(evalCurve(curves.g, x) * 255);
    tex[i * 4 + 2] = Math.round(evalCurve(curves.b, x) * 255);
    tex[i * 4 + 3] = Math.round(evalCurve(curves.master, x) * 255);
  }
  cache.set(curves, tex);
  return tex;
}
