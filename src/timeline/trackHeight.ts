/**
 * Per-track row height: the collapsed base plus a stack of thin lanes when the
 * track is expanded, one per animatable property of its clips - Adobe's
 * "expand track" reflex. Every consumer that lays out the timeline vertically
 * (the header pane, the row, the playhead bar, the marker overlay, the marquee
 * and drop math) reads its own row's height off `trackRowHeightPx` so the two
 * columns stay glued to each other even when only one track is opened up.
 *
 * The set of lanes is fixed to `EXPANDED_TRACK_PROPS` rather than pulled from
 * the clips: an empty lane invites a keyframe, and dropping/growing lanes as
 * the first key of a property is added would make the row jump under the
 * pointer mid-edit.
 */
import type { AnimatableProp, Track } from '../types';

/** Height of a single per-property keyframe lane, in px. */
export const KEYFRAME_LANE_HEIGHT_PX = 14;
/** Cap between the clip lane and the first keyframe lane. */
export const KEYFRAME_LANES_GAP_PX = 2;

/**
 * Props shown when a track is expanded, in the order of the inspector's
 * Transform section (scale → position → rotation → opacity). Opacity is always
 * exposed here even when no clip has a key on it yet - one click on the lane
 * lays the first one down.
 */
export const EXPANDED_TRACK_PROPS: AnimatableProp[] = ['scale', 'x', 'y', 'rotation', 'opacity'];

/** Total px the property lanes stack takes when a track is expanded. */
export const expandedLanesHeightPx =
  EXPANDED_TRACK_PROPS.length * KEYFRAME_LANE_HEIGHT_PX + KEYFRAME_LANES_GAP_PX;

/** Height of one track row, given the base track height and whether it is expanded. */
export function trackRowHeightPx(baseHeightPx: number, expanded: boolean): number {
  return baseHeightPx + (expanded ? expandedLanesHeightPx : 0);
}

/**
 * Cumulative Y offsets (in px) of every track row, plus the total height as
 * the last entry - the shape `sumHeights[i]` = top of row i, and
 * `sumHeights[n]` = total height, which makes both hit-tests (`floor`) and
 * layout (playhead bar, timeline overlay) O(n) with no repeated summations.
 */
export function trackTops(tracks: Track[], baseHeightPx: number, expanded: Set<string>): number[] {
  const tops: number[] = new Array(tracks.length + 1);
  let y = 0;
  for (let i = 0; i < tracks.length; i++) {
    tops[i] = y;
    y += trackRowHeightPx(baseHeightPx, expanded.has(tracks[i]!.id));
  }
  tops[tracks.length] = y;
  return tops;
}

/**
 * Row index (0-based) the pointer sits in, given a Y measured from the top of
 * the tracks area. Returns -1 when above every row, or `tracks.length` when
 * below the last one - callers clamp for their own semantics.
 */
export function trackIndexAtY(tops: number[], y: number): number {
  if (y < 0) return -1;
  // tops has length n+1; the last entry is the total height.
  for (let i = 0; i < tops.length - 1; i++) {
    if (y < tops[i + 1]!) return i;
  }
  return tops.length - 1;
}
