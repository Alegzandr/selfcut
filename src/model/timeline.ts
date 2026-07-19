import { AspectRatio, Clip, Marker, Project } from '../types';
import { clipDurationMs, clipEndMs } from './clip';

/**
 * Timeline/project-level model math: total duration, output geometry, marker
 * ordering and the crossfade windows derived from clip overlap. Pure functions
 * shared by preview, export and the timeline UI.
 */

/** Markers in timeline order - the order that numbers them (1, 2, 3…). */
export function sortedMarkers(project: Project): Marker[] {
  return [...project.markers].sort((a, b) => a.timeMs - b.timeMs);
}

// Memoized by project identity: copy-on-write means an unchanged project keeps
// its reference across frames, so the 60fps playback tick, the timecode readout
// and the seek clamp reuse the result instead of re-scanning every clip every
// frame; an edit yields a new Project and recomputes. WeakMap so entries are
// GC'd with their project.
const durationCache = new WeakMap<Project, number>();

/** Total project duration (end of the last clip), in ms. */
export function projectDurationMs(project: Project): number {
  const cached = durationCache.get(project);
  if (cached !== undefined) return cached;
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clipEndMs(clip));
    }
  }
  durationCache.set(project, max);
  return max;
}

const delegatedLinksCache = new WeakMap<Project, Set<string>>();

/**
 * The link groups whose video side must stay silent in the mix: those holding
 * at least one clip on an audio track, which carries the extracted sound -
 * playing the video side too would double it. A group made of video clips alone
 * is absent from the set, so it keeps its own audio.
 *
 * Built in one pass and cached per project: the mix loops over every clip, and
 * scanning the project once per clip would be quadratic.
 */
export function delegatedLinkIds(project: Project): Set<string> {
  const cached = delegatedLinksCache.get(project);
  if (cached !== undefined) return cached;
  const out = new Set<string>();
  for (const track of project.tracks) {
    if (track.kind !== 'audio') continue;
    for (const clip of track.clips) {
      if (clip.linkId != null) out.add(clip.linkId);
    }
  }
  delegatedLinksCache.set(project, out);
  return out;
}

export interface CrossfadeWindows {
  /** Overlap with the previous clip on the track (ramp-in duration), ms. */
  inMs: number;
  /** Overlap with the next clip on the track (ramp-out duration), ms. */
  outMs: number;
}

// Memoized by the clips-array identity: copy-on-write means an unchanged track
// keeps its array reference across frames, so the 60fps preview and the export
// loop reuse the result instead of re-sorting + reallocating every frame; a
// touched track gets a new array and recomputes. WeakMap so entries are GC'd
// with their track. Callers only read the returned map, never mutate it.
const crossfadeCache = new WeakMap<Clip[], Map<string, CrossfadeWindows>>();

/**
 * Crossfades of a track, derived purely from clip overlap: when two
 * consecutive clips overlap, the incoming clip ramps in and the outgoing
 * clip ramps out over the shared region (Vegas-style transition by sliding).
 */
export function trackCrossfades(clips: Clip[]): Map<string, CrossfadeWindows> {
  const cached = crossfadeCache.get(clips);
  if (cached) return cached;
  const out = new Map<string, CrossfadeWindows>();
  const sorted = [...clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  for (const c of sorted) out.set(c.id, { inMs: 0, outMs: 0 });
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const overlap = clipEndMs(prev) - cur.timelineStartMs;
    if (overlap <= 0) continue;
    const window = Math.min(overlap, clipDurationMs(prev), clipDurationMs(cur));
    out.get(prev.id)!.outMs = Math.max(out.get(prev.id)!.outMs, window);
    out.get(cur.id)!.inMs = Math.max(out.get(cur.id)!.inMs, window);
  }
  crossfadeCache.set(clips, out);
  return out;
}

/** Output dimensions for an aspect ratio (default export resolution). */
export function outputDimensions(aspect: AspectRatio): { width: number; height: number } {
  switch (aspect) {
    case '16:9':
      return { width: 1920, height: 1080 };
    case '9:16':
      return { width: 1080, height: 1920 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '4:5':
      return { width: 1080, height: 1350 };
  }
}
