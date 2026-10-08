import type { AspectRatio, Clip, ClipTransform, LoopRegion, MediaAsset, Project } from '../types';
import {
  clipEndMs,
  DEFAULT_TRANSFORM,
  forEachProjectClip,
  isTextClip,
  isTrackVisible,
  outputDimensions,
  projectDurationMs,
  reframedTransform,
} from '../model';
import { socialChrome } from '../preview/guides';
import { CAPTION_Y } from '../model/captions';
import { flattenAudibleClips } from '../preview/audioMix';

/**
 * The check before a cut is published: what a seasoned editor would catch in
 * a last look, caught for someone who is not one.
 *
 * Each finding names what is wrong in the viewer's terms (black frames, a title
 * under the app's buttons), and where a safe automatic fix exists it carries
 * what that fix needs. Nothing here blocks the export except a missing source,
 * which the export would refuse anyway: a review that stands in the way of a
 * deliberate choice is a review people learn to click through.
 *
 * Pure: the sheet runs it on every change and applies a fix through the store,
 * in one undo step.
 */

export type ReviewIssue =
  /** Media files the project can no longer read. Blocks: the export would fail. */
  | { id: 'disconnected'; names: string[] }
  /** Stretches where no picture is drawn: the viewer sees black. */
  | { id: 'blackGaps'; gaps: { startMs: number; endMs: number }[] }
  /** Text whose centre sits under the platform's own interface. */
  | { id: 'uiZone'; clipIds: string[]; fixes: { clipId: string; transform: ClipTransform }[] }
  /** Footage letterboxed with nothing behind it: black bands. */
  | { id: 'letterbox'; clipIds: string[]; fixes: { clipId: string; transform: ClipTransform }[] }
  /** Spoken footage without a single caption: most feeds play muted. */
  | { id: 'noCaptions' }
  /** The platform loudness is switched off. */
  | { id: 'loudness' };

export type ReviewIssueId = ReviewIssue['id'];

export interface ReviewInput {
  project: Project;
  assets: Record<string, MediaAsset>;
  region: LoopRegion | null;
  /** What is being made: a platform video, another video file, or sound only. */
  target: 'social' | 'video' | 'audio';
  normalize: boolean;
}

/** Shorter than this, a gap is a rounding sliver no one can see. */
const MIN_GAP_MS = 1000 / 30;

/** How far inside a zone a text centre has to be before it counts as under it. */
const ZONE_MARGIN = 0.01;

/** Clear room left between a moved title's centre and the zone it left. */
const ZONE_CLEARANCE = 0.06;

/** The timeline span the export covers. */
function span(project: Project, region: LoopRegion | null): { startMs: number; endMs: number } {
  const total = projectDurationMs(project);
  if (!region) return { startMs: 0, endMs: total };
  return { startMs: Math.max(0, Math.min(region.startMs, total)), endMs: Math.min(region.endMs, total) };
}

const overlaps = (clip: Clip, startMs: number, endMs: number) =>
  clipEndMs(clip) > startMs && clip.timelineStartMs < endMs;

/** Every stretch of [startMs, endMs) no visible video clip covers. */
export function blackGaps(project: Project, startMs: number, endMs: number): { startMs: number; endMs: number }[] {
  const covered: [number, number][] = [];
  for (const track of project.tracks) {
    if (track.kind !== 'video' || !isTrackVisible(track, project.tracks)) continue;
    for (const clip of track.clips) {
      if (!overlaps(clip, startMs, endMs)) continue;
      covered.push([Math.max(startMs, clip.timelineStartMs), Math.min(endMs, clipEndMs(clip))]);
    }
  }
  // A cut with no picture at all is a sound-only piece, not one full of holes.
  if (covered.length === 0) return [];
  covered.sort((a, b) => a[0] - b[0]);
  const gaps: { startMs: number; endMs: number }[] = [];
  let cursor = startMs;
  for (const [from, to] of covered) {
    if (from - cursor >= MIN_GAP_MS) gaps.push({ startMs: cursor, endMs: from });
    cursor = Math.max(cursor, to);
  }
  if (endMs - cursor >= MIN_GAP_MS) gaps.push({ startMs: cursor, endMs });
  return gaps;
}

/** The platform interface zone a point sits under, if any. */
function zoneAt(aspect: AspectRatio, x: number, y: number) {
  return socialChrome(aspect).find(
    (r) => x > r.x + ZONE_MARGIN && x < r.x + r.w - ZONE_MARGIN && y > r.y + ZONE_MARGIN && y < r.y + r.h - ZONE_MARGIN,
  );
}

/**
 * Where a text centred at (x, y) has to go to clear the zones, or null when
 * there is no safe move. Along y only, out through the edge that faces the
 * frame's centre, so a title keeps its column and its reading order.
 */
export function clearOfZones(aspect: AspectRatio, x: number, y: number): number | null {
  const hit = zoneAt(aspect, x, y);
  if (!hit) return null;
  const target = hit.y + hit.h / 2 > 0.5 ? hit.y - ZONE_CLEARANCE : hit.y + hit.h + ZONE_CLEARANCE;
  const clamped = Math.min(0.9, Math.max(0.1, target));
  // A move that lands in another zone is no fix: leave it to the user.
  return zoneAt(aspect, x, clamped) ? null : clamped;
}

const animatesPosition = (clip: Clip) => !!(clip.animation?.x || clip.animation?.y);

export function reviewProject(input: ReviewInput): ReviewIssue[] {
  const { project, assets, region, target, normalize } = input;
  const issues: ReviewIssue[] = [];
  const { startMs, endMs } = span(project, region);

  const disconnected = new Set<string>();
  forEachProjectClip(project, (clip) => {
    const asset = assets[clip.assetId];
    if (asset?.disconnected) disconnected.add(asset.file.name);
  });
  if (disconnected.size) issues.push({ id: 'disconnected', names: [...disconnected] });

  if (target !== 'audio') {
    const gaps = blackGaps(project, startMs, endMs);
    if (gaps.length) issues.push({ id: 'blackGaps', gaps });

    const visibleTracks = project.tracks.filter(
      (track) => track.kind === 'video' && isTrackVisible(track, project.tracks),
    );

    if (target === 'social') {
      const clipIds: string[] = [];
      const fixes: { clipId: string; transform: ClipTransform }[] = [];
      for (const track of visibleTracks) {
        for (const clip of track.clips) {
          if (!isTextClip(clip) || !overlaps(clip, startMs, endMs) || !clip.text.content.trim()) continue;
          const t = clip.transform;
          const x = t?.x ?? 0.5;
          const y = t?.y ?? CAPTION_Y[project.aspectRatio].bottom;
          if (!zoneAt(project.aspectRatio, x, y)) continue;
          clipIds.push(clip.id);
          const to = animatesPosition(clip) ? null : clearOfZones(project.aspectRatio, x, y);
          if (to !== null) fixes.push({ clipId: clip.id, transform: { ...(t ?? DEFAULT_TRANSFORM), y: to } });
        }
      }
      if (clipIds.length) issues.push({ id: 'uiZone', clipIds, fixes });
    }

    // Black bands: footage smaller than the frame with nothing below it.
    const out = outputDimensions(project.aspectRatio);
    const letterboxed: string[] = [];
    const fills: { clipId: string; transform: ClipTransform }[] = [];
    visibleTracks.forEach((track, index) => {
      const below = visibleTracks.slice(index + 1);
      for (const clip of track.clips) {
        if (clip.kind !== 'media' || !overlaps(clip, startMs, endMs)) continue;
        const asset = assets[clip.assetId];
        if (!asset || asset.kind === 'audio' || !asset.width || !asset.height) continue;
        const filled = reframedTransform(clip, asset, out, out, 'fill');
        // Null: framed by hand (a picture in picture, a deliberate frame),
        // which is no mistake to flag. Not larger: it already fills.
        if (!filled || filled.scale <= (clip.transform?.scale ?? 1) + 1e-3) continue;
        const backed = below.some((tr) => tr.clips.some((c) => overlaps(c, clip.timelineStartMs, clipEndMs(clip))));
        if (backed) continue;
        letterboxed.push(clip.id);
        fills.push({ clipId: clip.id, transform: filled });
      }
    });
    if (letterboxed.length) issues.push({ id: 'letterbox', clipIds: letterboxed, fixes: fills });

    if (target === 'social') {
      let captions = false;
      forEachProjectClip(project, (clip) => {
        if (isTextClip(clip)) captions = true;
      });
      const speech = flattenAudibleClips(project, startMs, endMs).some((clip) => {
        const asset = assets[clip.assetId];
        return asset?.kind === 'video' && asset.hasAudio;
      });
      if (speech && !captions) issues.push({ id: 'noCaptions' });
    }
  }

  if (target === 'social' && !normalize) {
    const audible = flattenAudibleClips(project, startMs, endMs).some((clip) => assets[clip.assetId]?.hasAudio);
    if (audible) issues.push({ id: 'loudness' });
  }

  return issues;
}
