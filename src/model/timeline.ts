import { AspectRatio, Clip, Marker, MarkerColor, MediaAsset, Project, Track } from '../types';

/** Every marker colour, in the order the colour menu lists them. */
export const MARKER_COLORS: readonly MarkerColor[] = ['cyan', 'red', 'amber', 'green', 'violet', 'pink'];
import { clipDurationMs, clipEndMs, isTextClip } from './clip';

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

/**
 * Text clips a new caption pass would supersede: those on lanes carrying
 * nothing but text, overlapping [`fromMs`, `toMs`).
 *
 * Regenerating captions used to stack a second lane of cues on top of the first
 * one, twice over on a third run, with nothing said about it. Finding what the
 * new pass makes redundant is what lets the editor offer to replace it.
 *
 * The whole-lane test is what keeps a title card out of the set in practice: a
 * title generally shares a lane with the footage it titles, while a caption pass
 * gets a lane of its own. It stays a heuristic, so callers state the count and
 * ask - replacing is offered, never done silently.
 */
export function supersededCueIds(project: Project, fromMs: number, toMs: number): string[] {
  return project.tracks
    .filter((track) => track.clips.length > 0 && track.clips.every(isTextClip))
    .flatMap((track) => track.clips)
    .filter((clip) => clip.timelineStartMs < toMs && clipEndMs(clip) > fromMs)
    .map((clip) => clip.id);
}

/**
 * Frame rates the timeline counts in. The measured source rate is snapped to
 * the nearest rung, so 29.97 footage steps and reads as 30 and 23.976 as 24:
 * the drift over a frame is far below what a preview can show, and a timecode
 * that counts "23.976 frames" a second is one nobody can type back in.
 */
const TIMELINE_FPS_LADDER = [24, 25, 30, 50, 60, 100, 120] as const;

interface TimelineFpsEntry {
  assets: Record<string, MediaAsset>;
  fps: number;
}
const timelineFpsCache = new WeakMap<Project, TimelineFpsEntry>();

/**
 * The frame rate the timeline is edited at: the fastest measured source rate
 * among the video clips on it, snapped to the ladder above, or the project's
 * own (60) when nothing on the timeline states one.
 *
 * Every frame-sized gesture reads this - arrow-key stepping, the nudge keys,
 * the transport's frame counter, the ruler's fine ticks, the scrub's frame
 * quantization. The project rate is a rendering ceiling, not a frame: stepping
 * 30 fps footage by 1/60 s shows every frame twice and counts to 59 on a clock
 * whose picture only ever changes 30 times, which is the one thing a monteur
 * cannot work with.
 *
 * Memoized per project identity (the assets map is compared by reference too,
 * since a probe landing a frame rate replaces the map): the readout asks 60
 * times a second during playback.
 */
export function timelineFps(project: Project, assets: Record<string, MediaAsset>): number {
  const cached = timelineFpsCache.get(project);
  if (cached && cached.assets === assets) return cached.fps;
  let fastest = 0;
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue;
    for (const clip of track.clips) {
      if (clip.kind !== 'media') continue;
      const fps = assets[clip.assetId]?.fps;
      if (fps && fps > fastest) fastest = fps;
    }
  }
  const fps =
    fastest > 0
      ? TIMELINE_FPS_LADDER.reduce((best, rate) =>
          Math.abs(rate - fastest) < Math.abs(best - fastest) ? rate : best,
        )
      : project.fps;
  timelineFpsCache.set(project, { assets, fps });
  return fps;
}

interface SoloState {
  audio: boolean;
  video: boolean;
}
const soloCache = new WeakMap<Project, SoloState>();

/** Whether any track of each kind is soloed - the switch that arms solo at all. */
function soloState(project: Project): SoloState {
  const cached = soloCache.get(project);
  if (cached) return cached;
  const state: SoloState = { audio: false, video: false };
  for (const track of project.tracks) {
    if (track.solo) state[track.kind] = true;
  }
  soloCache.set(project, state);
  return state;
}

/**
 * Whether a track's sound reaches the mix: not muted, and - while any AUDIO
 * track is soloed - soloed itself. Solo is scoped to the audio lanes: soloing a
 * video track to check its picture must not silence the voice-over under it,
 * and a video track's own sound (an unlinked clip with audio) keeps playing
 * against a soloed audio lane only if it is soloed too.
 */
export function isTrackAudible(track: Track, project: Project): boolean {
  if (track.muted) return false;
  if (!soloState(project).audio) return true;
  return !!track.solo;
}

/**
 * Whether a video track is composited: not hidden, and - while any VIDEO track
 * is soloed - soloed itself. Non-video tracks are never visible.
 */
export function isTrackVisible(track: Track, project: Project): boolean {
  if (track.kind !== 'video' || track.hidden) return false;
  if (!soloState(project).video) return true;
  return !!track.solo;
}

/**
 * Whether a track is currently silenced or hidden BY SOMEONE ELSE'S solo - the
 * state the timeline dims a row for, so a lane that went quiet says why.
 */
export function isTrackSoloedOut(track: Track, project: Project): boolean {
  const solo = soloState(project);
  return !track.solo && (track.kind === 'audio' ? solo.audio : solo.video);
}

/** An empty span on a track, between the clip before it and the clip after it. */
export interface TrackGap {
  startMs: number;
  endMs: number;
}

/**
 * The gap on a track under `timeMs`, or null when a clip covers that instant or
 * when nothing follows it (the empty run after the last clip is not a gap to
 * close, it is the end of the cut).
 */
export function gapAt(track: Track, timeMs: number): TrackGap | null {
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const clip of track.clips) {
    const start = clip.timelineStartMs;
    const end = clipEndMs(clip);
    if (start <= timeMs && end > timeMs) return null;
    if (end <= timeMs) prevEnd = Math.max(prevEnd, end);
    else nextStart = Math.min(nextStart, start);
  }
  if (!isFinite(nextStart) || nextStart - prevEnd <= 0) return null;
  return { startMs: prevEnd, endMs: nextStart };
}

/**
 * The gap under `timeMs` across the WHOLE timeline: the span in which every
 * unlocked track is empty, or null when any of them is playing something there
 * (or when nothing follows on any of them).
 *
 * What "close the gap" means when the ripple runs on every track: the only span
 * that can be taken out of the timeline without shoving one track's content
 * over another's is the one where nothing at all is playing. Locked tracks are
 * left out of the reckoning for the same reason they are left out of the
 * shift - they are pinned, so what they hold is not the timeline's to close.
 */
export function timelineGapAt(project: Project, timeMs: number): TrackGap | null {
  let prevEnd = 0;
  let nextStart = Infinity;
  for (const track of project.tracks) {
    if (track.locked) continue;
    for (const clip of track.clips) {
      const start = clip.timelineStartMs;
      const end = clipEndMs(clip);
      if (start <= timeMs && end > timeMs) return null;
      if (end <= timeMs) prevEnd = Math.max(prevEnd, end);
      else nextStart = Math.min(nextStart, start);
    }
  }
  if (!isFinite(nextStart) || nextStart - prevEnd <= 0) return null;
  return { startMs: prevEnd, endMs: nextStart };
}
