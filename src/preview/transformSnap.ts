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

/**
 * Geometry a per-axis stretch gesture needs, on ONE axis, in output pixels.
 * `unit` is the size the clip draws at stretch 1 — the uniform scale is already
 * baked into it, so the targets below stay right at any zoom level.
 */
export interface StretchSnapContext {
  unit: number;
  out: number;
}

/**
 * The stretches one axis snaps to:
 *
 * - **1**: the source ratio, undeformed. The detent that matters most, because
 *   an accidental stretch is otherwise impossible to undo by hand.
 * - **fill**: the stretch where this axis exactly spans the frame — the whole
 *   point of the feature (4:3 footage made to fill a 16:9 frame without
 *   cropping), and a value nobody can hit by eye.
 */
export function stretchSnapTargets(ctx: StretchSnapContext): number[] {
  const { unit, out } = ctx;
  const targets = [1];
  const fill = out / unit;
  // Dropped when the axis already fills the frame: it would sit on top of 1 and
  // give the gesture two competing detents at the same place.
  if (unit > 0 && Number.isFinite(fill) && fill > 0 && Math.abs(fill - 1) >= SAME_SCALE) {
    targets.push(fill);
  }
  return targets;
}

/**
 * Snap a stretch to the nearest target within `threshold`, and report where to
 * draw the guides — at the clip's own two edges on that axis, in normalized
 * stage coords, on the same reasoning as `snapScale`.
 */
export function snapStretch(
  raw: number,
  targets: number[],
  threshold: number,
  clip: { center: number; unit: number; out: number },
): { stretch: number; guides: number[] } {
  let best: number | null = null;
  let bestDist = threshold;
  for (const target of targets) {
    const dist = Math.abs(raw - target);
    if (dist <= bestDist) {
      best = target;
      bestDist = dist;
    }
  }
  if (best === null) return { stretch: raw, guides: [] };
  const half = (clip.unit * best) / clip.out / 2;
  return { stretch: best, guides: [clip.center - half, clip.center + half] };
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

/** Where handles may be painted, in normalized stage coords. */
export interface HandleBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** The output frame itself - the fallback when the visible area is unknown. */
export const FULL_FRAME_BOUNDS: HandleBounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 };

/**
 * Where the four corner handles go.
 *
 * They sit on the clip's own corners, which is where a resize handle is
 * expected to be. But they cannot ride along unconditionally: scale a landscape
 * clip up to "cover" in a portrait project - the whole point of the magnetism
 * above - and all four corners land far outside the panel, where they are
 * unreachable at exactly the scale the edit is meant to end up at.
 *
 * So each corner is rotated around the clip's centre, then clamped into
 * `bounds` - the area actually visible in the preview panel, which extends well
 * past the output frame (the letterbox around it shows the overflowing media).
 * Only a corner that has truly left the panel gets pulled back. The gesture math
 * is unaffected: it works from the clip's true rect and the pointer, never from
 * these positions.
 */
export function handlePlacements(
  rect: DestRect,
  rotationDeg: number,
  outW: number,
  outH: number,
  bounds: HandleBounds = FULL_FRAME_BOUNDS,
): HandlePlacement[] {
  return (['nw', 'ne', 'sw', 'se'] as const).map((corner) => ({
    corner,
    ...placeOffset(
      rect,
      (corner[1] === 'w' ? rect.dx : rect.dx + rect.dw) - (rect.dx + rect.dw / 2),
      (corner[0] === 'n' ? rect.dy : rect.dy + rect.dh) - (rect.dy + rect.dh / 2),
      rotationDeg,
      outW,
      outH,
      bounds,
    ),
  }));
}

/** Which pair of edges an edge handle sits on, and so which axis it stretches. */
export type Edge = 'n' | 'e' | 's' | 'w';

/** An edge handle's placement, same shape and same clamping as the corners'. */
export interface EdgePlacement extends Omit<HandlePlacement, 'corner'> {
  edge: Edge;
  /** The axis this handle stretches: 'x' for the left/right pair. */
  axis: 'x' | 'y';
}

/**
 * Where the four edge handles go: the midpoint of each side, rotated and
 * clamped exactly like the corners.
 *
 * They are the non-uniform counterpart of the corner handles - dragging one
 * stretches a single axis, which is what turns 4:3 footage into a 16:9 frame
 * without cropping it. Kept as their own handles rather than as a modifier on
 * the corners because Shift is already spoken for here (it inverts the snap
 * toggle in every preview gesture) and because a side handle is where every
 * editor puts this.
 */
export function edgeHandlePlacements(
  rect: DestRect,
  rotationDeg: number,
  outW: number,
  outH: number,
  bounds: HandleBounds = FULL_FRAME_BOUNDS,
): EdgePlacement[] {
  const halfW = rect.dw / 2;
  const halfH = rect.dh / 2;
  const offsets: Record<Edge, [number, number]> = {
    n: [0, -halfH],
    e: [halfW, 0],
    s: [0, halfH],
    w: [-halfW, 0],
  };
  return (['n', 'e', 's', 'w'] as const).map((edge) => ({
    edge,
    axis: edge === 'e' || edge === 'w' ? ('x' as const) : ('y' as const),
    ...placeOffset(rect, offsets[edge][0], offsets[edge][1], rotationDeg, outW, outH, bounds),
  }));
}

/**
 * Rotate an offset from the clip's centre, convert it to normalized stage
 * coords and pull it back into `bounds`. Shared by both handle families so a
 * corner and the edge next to it are clamped by the same rule.
 */
function placeOffset(
  rect: DestRect,
  ox: number,
  oy: number,
  rotationDeg: number,
  outW: number,
  outH: number,
  bounds: HandleBounds,
): { x: number; y: number; dirX: number; dirY: number; clamped: boolean } {
  const cx = rect.dx + rect.dw / 2;
  const cy = rect.dy + rect.dh / 2;
  const a = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // Output-pixel space, which maps to the screen by a uniform scale - so a
  // direction computed here is already the direction seen on screen.
  const rx = ox * cos - oy * sin;
  const ry = ox * sin + oy * cos;
  const len = Math.hypot(rx, ry) || 1;

  const nx = (cx + rx) / outW;
  const ny = (cy + ry) / outH;
  const x = clamp(nx, bounds.minX, bounds.maxX);
  const y = clamp(ny, bounds.minY, bounds.maxY);
  return { x, y, dirX: rx / len, dirY: ry / len, clamped: x !== nx || y !== ny };
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
