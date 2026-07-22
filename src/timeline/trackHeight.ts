/**
 * Per-track row height: the collapsed base plus a stack of thin lanes when the
 * track is expanded, one per keyframable property of its clips - Adobe's
 * "expand track" reflex. Every consumer that lays out the timeline vertically
 * (the header pane, the row, the playhead bar, the marker overlay, the marquee
 * and drop math) reads its own row's height off `trackRowHeightPx` so the two
 * columns stay glued to each other even when only one track is opened up.
 *
 * The lane set is deliberately half fixed, half earned.
 *
 * The five transform props are always there, empty or not: an empty lane invites
 * a keyframe, and it is the only affordance saying the property can be animated
 * at all. Growing that set as the first key appears would make the row jump
 * under the pointer mid-edit, which is why it does not.
 *
 * The colour params are the opposite: there are seven of them, they are graded
 * far more often than they are animated, and seven permanently empty strips
 * would add 98px to every expanded row to advertise something the inspector
 * already offers. So a colour lane appears once that param actually carries a
 * key somewhere on the track. The row-jump objection does not transfer: a colour
 * lane can only appear from an inspector click, and can only vanish from a
 * Delete keypress or the same inspector diamond. Neither is a pointer gesture on
 * the timeline, so nothing moves under a drag in flight.
 */
import type { AnimatableProp, KeyframeProp, Track } from '../types';
import { COLOR_PROPS } from '../model';

/** Height of a single per-property keyframe lane, in px. */
export const KEYFRAME_LANE_HEIGHT_PX = 14;
/** Cap between the clip lane and the first keyframe lane. */
export const KEYFRAME_LANES_GAP_PX = 2;

/**
 * The always-present lanes, in the order of the inspector's Transform section
 * (scale → position → rotation → opacity). Opacity is exposed here even when no
 * clip has a key on it yet - one click on the lane lays the first one down.
 */
export const TRANSFORM_LANE_PROPS: AnimatableProp[] = [
  'scale',
  'x',
  'y',
  'rotation',
  'opacity',
];

/**
 * The lanes a track shows when expanded: the fixed transform set, then every
 * colour param that any clip on the track actually keyframes, in inspector
 * order.
 */
export function trackLanes(track: Track): KeyframeProp[] {
  const colored: KeyframeProp[] = [];
  for (const prop of COLOR_PROPS) {
    if (track.clips.some((c) => Array.isArray(c.color?.[prop]) && c.color[prop].length)) {
      colored.push(prop);
    }
  }
  return colored.length ? [...TRANSFORM_LANE_PROPS, ...colored] : TRANSFORM_LANE_PROPS;
}

/** Px the lane stack takes for a given number of lanes. */
export function lanesHeightPx(laneCount: number): number {
  return laneCount * KEYFRAME_LANE_HEIGHT_PX + KEYFRAME_LANES_GAP_PX;
}

/** Height of one track row, given the base track height and whether it is expanded. */
export function trackRowHeightPx(track: Track, baseHeightPx: number, expanded: boolean): number {
  return baseHeightPx + (expanded ? lanesHeightPx(trackLanes(track).length) : 0);
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
    y += trackRowHeightPx(tracks[i]!, baseHeightPx, expanded.has(tracks[i]!.id));
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
