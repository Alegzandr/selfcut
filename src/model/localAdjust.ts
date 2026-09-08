import type { ClipColor, ClipLocalAdjust, ColorProp } from '../types';
import { resolveColorAt, type ResolvedColor } from './clip';

/**
 * Grades confined to a shape: "the effect, or the effect on a mask".
 *
 * A local adjustment is the clip's own Adjust panel pointed at less of the
 * frame. Everything that makes the global grade usable - keyframes on every
 * channel, the shape tools, the feather, the motion tracker - is the same code
 * here, because a region that could only do a subset would send people back to
 * exporting a duplicate clip on a track above and masking that.
 */

/**
 * The parameters a region actually applies, in inspector order.
 *
 * Two of the eight are missing, and both for the same reason: they are not
 * measured in the region.
 *
 *  - `vignette` is a falloff from the FRAME's centre. Inside a shape it would
 *    draw a corner of the frame, not a corner of the region - a control whose
 *    result has nothing to do with where you put it.
 *  - `blur` is what a redaction already is: the same shape, the same feather,
 *    the same tracker, with a strength scaled against the region instead of the
 *    frame. A second control that blurs a tracked region is not a feature, it is
 *    a second place to look for the one you set.
 */
export const LOCAL_ADJUST_PROPS: ColorProp[] = [
  'brightness',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'sharpen',
];

const APPLIED = new Set<string>(LOCAL_ADJUST_PROPS);

/**
 * The region a new local adjustment starts as: a soft-edged ellipse in the
 * middle of the frame, carrying no grade at all.
 *
 * No grade, deliberately. A redaction appears already hiding because a
 * redaction that hides nothing has failed; an adjustment that arrives already
 * changing the picture has instead decided for you which of six parameters you
 * came for. The shape is the thing to place first, and it is visible from the
 * moment it exists thanks to its outline on the monitor.
 */
export function defaultLocalAdjust(center?: { x: number; y: number }): Omit<ClipLocalAdjust, 'id'> {
  return {
    color: {},
    shape: 'ellipse',
    x: center?.x ?? 0.5,
    y: center?.y ?? 0.5,
    w: 0.35,
    h: 0.35,
    // A grade with a hard edge reads as a sticker on the picture. Wider than a
    // redaction's default for that reason: nobody should be able to see where a
    // brightened region stops.
    feather: 0.06,
    invert: false,
  };
}

/**
 * The grade a region applies at a clip-local time, or null when it comes to the
 * identity and the pass can be skipped.
 *
 * Anything outside `LOCAL_ADJUST_PROPS` is dropped before resolving rather than
 * zeroed afterwards, so the identity check upstream sees the same object the
 * renderer will run and a region carrying only a vignette is skipped entirely
 * instead of costing a full pass that changes nothing.
 */
export function resolveLocalAdjustColor(
  adjust: ClipLocalAdjust,
  localMs: number,
): ResolvedColor | null {
  const applied: ClipColor = {};
  for (const [key, value] of Object.entries(adjust.color)) {
    // `lut` and `curves` are neither `ColorProp`s nor frame-relative: they map
    // colour to colour, which means the same thing on a region as on a frame,
    // so they carry through even though no slider writes them yet.
    if (APPLIED.has(key) || key === 'lut' || key === 'curves') {
      (applied as Record<string, unknown>)[key] = value;
    }
  }
  return resolveColorAt(applied, localMs);
}

/** The regions that actually paint, or null when the clip has none enabled. */
export function activeLocalAdjusts(
  list: ClipLocalAdjust[] | undefined,
): ClipLocalAdjust[] | null {
  const on = list?.filter((a) => !a.disabled);
  return on && on.length > 0 ? on : null;
}
