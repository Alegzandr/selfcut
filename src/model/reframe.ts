import { Clip, ClipTransform, MediaAsset } from '../types';
import { DEFAULT_TRANSFORM } from './clip';

/**
 * Reframing a project when its output ratio changes: the scale that makes a
 * clip fill the new frame, and the test for which clips may be rescaled without
 * throwing away work the user did by hand.
 *
 * Pure geometry, kept out of the store so the rule is testable on its own and
 * so preview, export and the toolbar all read the same definition of "fills the
 * frame" as the resize magnetism does (`preview/transformSnap.ts`).
 */

/** Two scales/positions this close are the same value - float round-trips. */
const EPSILON = 1e-3;

const near = (a: number, b: number) => Math.abs(a - b) < EPSILON;

/**
 * The `scale` at which a clip's cropped source COVERS the output frame - no
 * empty band on either axis, the overflow cropped by the frame itself.
 *
 * Expressed relative to `scale = 1`, which the compositor defines as the
 * "contain" fit (the source shrunk until it sits entirely inside the frame). So
 * this is simply the ratio between the two axes' fill scales, and it is 1
 * whenever source and output already share a ratio.
 */
export function coverScale(
  source: { width: number; height: number },
  crop: ClipTransform['crop'],
  outW: number,
  outH: number,
): number {
  const cropW = Math.max(1, crop.w * source.width);
  const cropH = Math.max(1, crop.h * source.height);
  const fillW = outW / cropW;
  const fillH = outH / cropH;
  if (!(fillW > 0) || !(fillH > 0)) return 1;
  return Math.max(fillW, fillH) / Math.min(fillW, fillH);
}

/**
 * Whether a clip is still framed by the app rather than by the user, and so may
 * be rescaled when the output ratio changes.
 *
 * "Still automatic" means centered, unstretched, unrotated, un-keyframed, and
 * sitting at one of the two scales this feature itself writes: 1 (letterboxed)
 * or `cover` for the CURRENT ratio (filled). That last clause is what keeps the
 * behaviour idempotent across several ratio changes in a row - a clip filled for
 * 9:16 is still recognised as automatic when the user then picks 1:1.
 *
 * A crop is not disqualifying: the cover scale is computed from the cropped
 * region, so a user-cropped clip is reframed around the part they kept. But any
 * hand-set position, stretch, rotation or scale is, and those clips keep the
 * exact framing the user gave them.
 */
export function isAutoFramed(clip: Clip, cover: number): boolean {
  const a = clip.animation;
  // A framing keyframe means the framing is authored over time: writing a
  // static value would silently drop the animation.
  if (a && (a.x || a.y || a.scale || a.scaleX || a.scaleY || a.rotation)) return false;
  const t = clip.transform;
  if (!t) return true;
  return (
    near(t.x, 0.5) &&
    near(t.y, 0.5) &&
    near(t.scaleX ?? 1, 1) &&
    near(t.scaleY ?? 1, 1) &&
    near(t.rotation ?? 0, 0) &&
    (near(t.scale, 1) || near(t.scale, cover))
  );
}

/** How a ratio change reframes the clips it may touch. */
export type Framing = 'fill' | 'fit';

/**
 * The transform a clip should carry after the ratio change, or `null` when it
 * must be left alone: hand-framed, not a media clip with known dimensions, or
 * already at the wanted scale.
 *
 * `from` is the output the project is LEAVING and `to` the one it is entering -
 * both are needed, because "still automatic" is judged against the cover scale
 * of the ratio the clip was framed for, while the new scale comes from the one
 * it is going to.
 *
 * `fit` writes scale 1 - the contain fit, which is what letterboxes the clip -
 * so the two modes are exact opposites and the toast can toggle between them.
 */
export function reframedTransform(
  clip: Clip,
  asset: MediaAsset | undefined,
  from: { width: number; height: number },
  to: { width: number; height: number },
  framing: Framing,
): ClipTransform | null {
  if (!asset?.width || !asset?.height) return null;
  const source = { width: asset.width, height: asset.height };
  const crop = clip.transform?.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  if (!isAutoFramed(clip, coverScale(source, crop, from.width, from.height))) return null;
  const scale = framing === 'fill' ? coverScale(source, crop, to.width, to.height) : 1;
  const current = clip.transform;
  if (current && near(current.scale, scale)) return null;
  return { ...DEFAULT_TRANSFORM, ...current, crop, scale };
}
