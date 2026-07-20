/**
 * Magnetism for direct manipulation in the preview: which scales and angles a
 * gesture snaps to, and which guide lines to draw while it holds.
 *
 * Kept apart from `PreviewCanvas` because the interesting part is geometry, not
 * pointer plumbing: the targets are derived from the clip's own size at scale 1
 * rather than hardcoded, so they stay correct for any source ratio in any
 * output ratio - a 16:9 clip in a 9:16 project being the case that motivated
 * this (its "fills the frame" scale is ~3.16, which no fixed list would hold).
 */

import { ROTATION_SNAP_STEP_DEG, ROTATION_SNAP_THRESHOLD_DEG } from '../app/config';
import { clamp } from '../lib/time';
import type { DestRect } from './compositor';

/** Guide lines to paint while a snap is active, in normalized stage coords. */
export interface SnapGuides {
  v: number[];
  h: number[];
}

/** A scale worth snapping to, and the axis it makes flush with the frame. */
interface ScaleTarget {
  scale: number;
  /** Which pair of frame edges the clip lands on: 'x' = left+right. */
  axis: 'x' | 'y' | null;
}

/**
 * Geometry a resize gesture needs, all in output pixels. `unitW`/`unitH` are
 * the clip's size at scale 1 - every clip kind scales linearly from there, so
 * one formula covers media, shapes and text.
 */
export interface ScaleSnapContext {
  unitW: number;
  unitH: number;
  outW: number;
  outH: number;
  /** Cropped source width in its own pixels, when known (media clips only). */
  sourceW?: number;
}

/** Two scales are "the same detent" when this close - avoids double guides. */
const SAME_SCALE = 1e-3;

/**
 * The scales a resize snaps to, nearest-first filtering left to the caller:
 *
 * - **fit**: the clip sits entirely inside the frame, one axis flush.
 * - **cover**: the clip fills the frame with no empty band, the other axis flush.
 * - **native**: the source drawn at 1:1 pixels (media only), which is where it
 *   stops resampling and stays sharpest.
 * - **1.0**: the clip's authored size. Equals `fit` for media, but is a
 *   meaningful detent of its own for shapes and text.
 *
 * `cover` is the one that matters for vertical editing: it is the scale where a
 * landscape clip stops showing black bars in a portrait frame.
 */
export function scaleSnapTargets(ctx: ScaleSnapContext): ScaleTarget[] {
  const { unitW, unitH, outW, outH, sourceW } = ctx;
  if (!(unitW > 0) || !(unitH > 0)) return [];

  // Scale that makes each axis exactly span the frame.
  const fillW = outW / unitW;
  const fillH = outH / unitH;
  const widthLimits = fillW < fillH;

  const targets: ScaleTarget[] = [
    { scale: Math.min(fillW, fillH), axis: widthLimits ? 'x' : 'y' },
    { scale: Math.max(fillW, fillH), axis: widthLimits ? 'y' : 'x' },
    { scale: 1, axis: null },
  ];
  if (sourceW && sourceW > 0) targets.push({ scale: sourceW / unitW, axis: null });

  // Drop duplicates: for media, scale 1 IS the fit, and a source shot at the
  // output resolution puts `native` on top of it too.
  const seen: ScaleTarget[] = [];
  for (const target of targets) {
    if (!(target.scale > 0) || !Number.isFinite(target.scale)) continue;
    if (seen.some((s) => Math.abs(s.scale - target.scale) < SAME_SCALE)) continue;
    seen.push(target);
  }
  return seen;
}

/**
 * Snap a scale to the nearest target within `threshold`, and report the guides.
 *
 * Nearest rather than first-match: the targets are not ordered by distance and
 * `cover` can sit close to `native`, so first-match would make the gesture jump
 * to whichever happens to be listed earlier.
 *
 * Guides are drawn at the clip's ACTUAL edges, not at the frame's: an off-center
 * clip that snaps to `cover` really is flush on neither side, and drawing a line
 * on the frame border would claim an alignment that is not there.
 */
export function snapScale(
  raw: number,
  targets: ScaleTarget[],
  threshold: number,
  clip: { centerX: number; centerY: number; unitW: number; unitH: number; outW: number; outH: number },
): { scale: number; guides: SnapGuides } {
  let best: ScaleTarget | null = null;
  let bestDist = threshold;
  for (const target of targets) {
    const dist = Math.abs(raw - target.scale);
    if (dist <= bestDist) {
      best = target;
      bestDist = dist;
    }
  }
  if (!best) return { scale: raw, guides: { v: [], h: [] } };

  const guides: SnapGuides = { v: [], h: [] };
  if (best.axis === 'x') {
    const half = (clip.unitW * best.scale) / clip.outW / 2;
    guides.v.push(clip.centerX - half, clip.centerX + half);
  } else if (best.axis === 'y') {
    const half = (clip.unitH * best.scale) / clip.outH / 2;
    guides.h.push(clip.centerY - half, clip.centerY + half);
  }
  return { scale: best.scale, guides };
}

/** Wrap an angle into [-180, 180) so 359° and -1° compare as neighbours. */
export function normalizeAngle(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/**
 * Snap a rotation to the nearest multiple of `ROTATION_SNAP_STEP_DEG`. Returns
 * the angle unchanged when no detent is close enough, so a deliberate 7° tilt
 * stays reachable.
 */
export function snapRotation(deg: number): number {
  const nearest = Math.round(deg / ROTATION_SNAP_STEP_DEG) * ROTATION_SNAP_STEP_DEG;
  if (Math.abs(normalizeAngle(deg - nearest)) > ROTATION_SNAP_THRESHOLD_DEG) return deg;
  return normalizeAngle(nearest);
}

/** A corner handle's placement, already rotated and pulled back into the frame. */
export interface HandlePlacement {
  corner: 'nw' | 'ne' | 'sw' | 'se';
  /** Where to paint it, in normalized stage coords. */
  x: number;
  y: number;
  /** Unit vector pointing away from the clip's center, in screen direction. */
  dirX: number;
  dirY: number;
  /** True when the real corner sits outside the frame and was pulled back in. */
  clamped: boolean;
}

/**
 * Where the four corner handles go.
 *
 * They cannot simply ride along inside the selection outline: scale a landscape
 * clip up to "cover" in a portrait project - the whole point of the magnetism
 * above - and all four corners land outside the frame, where the preview panel
 * clips them away. The handles were then unreachable at exactly the scale the
 * edit is meant to end up at, so the clip could no longer be resized at all.
 *
 * So each corner is rotated around the clip's centre, then clamped into the
 * frame. A clip that fits is untouched; one that overflows keeps its handles on
 * the frame border, still grabbable. The gesture math is unaffected: it works
 * from the clip's true rect and the pointer, never from these positions.
 */
export function handlePlacements(
  rect: DestRect,
  rotationDeg: number,
  outW: number,
  outH: number,
): HandlePlacement[] {
  const cx = rect.dx + rect.dw / 2;
  const cy = rect.dy + rect.dh / 2;
  const a = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);

  return (['nw', 'ne', 'sw', 'se'] as const).map((corner) => {
    const ox = (corner[1] === 'w' ? rect.dx : rect.dx + rect.dw) - cx;
    const oy = (corner[0] === 'n' ? rect.dy : rect.dy + rect.dh) - cy;
    // Output-pixel space, which maps to the screen by a uniform scale - so a
    // direction computed here is already the direction seen on screen.
    const rx = ox * cos - oy * sin;
    const ry = ox * sin + oy * cos;
    const len = Math.hypot(rx, ry) || 1;

    const nx = (cx + rx) / outW;
    const ny = (cy + ry) / outH;
    const x = clamp(nx, 0, 1);
    const y = clamp(ny, 0, 1);
    return { corner, x, y, dirX: rx / len, dirY: ry / len, clamped: x !== nx || y !== ny };
  });
}

/**
 * Resize cursor matching a handle's real direction. Once a clip is rotated the
 * fixed per-corner classes lie: the NW handle of a clip turned 90° pulls along
 * the NE diagonal, and a cursor pointing the other way misreads the gesture.
 */
export function resizeCursor(dirX: number, dirY: number): string {
  const deg = ((((Math.atan2(dirY, dirX) * 180) / Math.PI) % 180) + 180) % 180;
  if (deg < 22.5 || deg >= 157.5) return 'ew-resize';
  if (deg < 67.5) return 'nwse-resize';
  if (deg < 112.5) return 'ns-resize';
  return 'nesw-resize';
}
