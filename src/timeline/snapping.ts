import { LoopRegion } from '../types';
import { clipEndMs, type TimelineView } from '../model';

/**
 * All timeline positions worth snapping to: origin, playhead, other clips'
 * edges, markers and the loop region's corners.
 */
export function collectSnapPoints(
  timeline: TimelineView,
  excludeClipIds: readonly string[],
  playheadMs: number,
  region?: LoopRegion | null,
): number[] {
  const points: number[] = [0, playheadMs];
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      if (excludeClipIds.includes(clip.id)) continue;
      points.push(clip.timelineStartMs, clipEndMs(clip));
    }
  }
  for (const marker of timeline.markers) points.push(marker.timeMs);
  if (region) points.push(region.startMs, region.endMs);
  return points;
}

/** Snap a single time to the nearest point within the threshold (ms). */
export function snapTime(proposedMs: number, points: number[], thresholdMs: number): number {
  let best = proposedMs;
  let bestDist = thresholdMs;
  for (const p of points) {
    const d = Math.abs(p - proposedMs);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

/**
 * Snap a moving clip: try snapping its start and its end,
 * keep whichever candidate is the closest.
 */
export function snapMove(
  proposedStartMs: number,
  durationMs: number,
  points: number[],
  thresholdMs: number,
): number {
  let best = proposedStartMs;
  let bestDist = thresholdMs;
  for (const p of points) {
    const dStart = Math.abs(p - proposedStartMs);
    if (dStart < bestDist) {
      bestDist = dStart;
      best = p;
    }
    const dEnd = Math.abs(p - (proposedStartMs + durationMs));
    if (dEnd < bestDist) {
      bestDist = dEnd;
      best = p - durationMs;
    }
  }
  return best;
}
