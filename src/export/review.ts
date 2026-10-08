import type { AspectRatio, Clip, ClipTransform, LoopRegion, MediaAsset, Project } from '../types';
import {
  clipEndMs,
  DEFAULT_TEXT_WIDTH_FRAC,
  DEFAULT_TRANSFORM,
  forEachProjectClip,
  isTextClip,
  isTrackVisible,
  outputDimensions,
  reframedTransform,
} from '../model';
import { socialChrome } from '../preview/guides';
import { flattenAudibleClips } from '../preview/audioMix';
import { disconnectedSourceNames, exportSpan } from './span';

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

/** A clip's new framing: its transform, and for a text its wrap width. */
export interface FramingFix {
  clipId: string;
  transform: ClipTransform;
  widthFrac?: number;
}

export type ReviewIssue =
  /** Media files the project can no longer read. Blocks: the export would fail. */
  | { id: 'disconnected'; names: string[] }
  /** Stretches where no picture is drawn: the viewer sees black. */
  | { id: 'blackGaps'; gaps: { startMs: number; endMs: number }[] }
  /** Text whose centre sits under the platform's own interface. */
  | { id: 'uiZone'; clipIds: string[]; fixes: FramingFix[] }
  /** Footage letterboxed with nothing behind it: black bands. */
  | { id: 'letterbox'; clipIds: string[]; fixes: FramingFix[] }
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

/** How far into a zone a text box has to reach before it counts as under it. */
const ZONE_MARGIN = 0.01;

/** Clear room left between a moved title's centre and the zone it left. */
const ZONE_CLEARANCE = 0.06;

/** Room kept between a narrowed text box and the zone beside it. */
const SIDE_CLEARANCE = 0.02;

/** Narrower than this a title wraps a word per line: move it instead. */
const MIN_TEXT_WIDTH = 0.4;

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

/** A text's wrap box, as the compositor lays it out: centred on (x, y). */
export interface TextBox {
  x: number;
  y: number;
  /** Full width of the wrap box, as a fraction of the output width. */
  widthFrac: number;
}

/** The platform interface zones a text box reaches into. */
function zonesUnder(aspect: AspectRatio, box: TextBox) {
  const half = box.widthFrac / 2;
  return socialChrome(aspect).filter(
    (r) =>
      box.y > r.y + ZONE_MARGIN &&
      box.y < r.y + r.h - ZONE_MARGIN &&
      box.x + half > r.x + ZONE_MARGIN &&
      box.x - half < r.x + r.w - ZONE_MARGIN,
  );
}

/**
 * How a text box gets clear of the platform's interface: `clear` when it
 * already is, a new centre and width when there is a safe way out, null when
 * there is none.
 *
 * A zone across the text's own column (the caption block, the status bar) is
 * left through its edge that faces the frame's centre, so the title keeps its
 * column. A zone beside it (the button column) narrows the box instead, so the
 * text wraps before it reaches the buttons - unless that would leave it too
 * narrow to read, where the user decides.
 */
export function textClearance(aspect: AspectRatio, box: TextBox): 'clear' | { y: number; widthFrac: number } | null {
  let { y, widthFrac } = box;
  for (let pass = 0; pass < 3; pass++) {
    const hits = zonesUnder(aspect, { x: box.x, y, widthFrac });
    if (hits.length === 0) {
      return y === box.y && widthFrac === box.widthFrac ? 'clear' : { y, widthFrac };
    }
    const across = hits.find((r) => r.x <= box.x && box.x <= r.x + r.w);
    if (across) {
      const target = across.y + across.h / 2 > 0.5 ? across.y - ZONE_CLEARANCE : across.y + across.h + ZONE_CLEARANCE;
      y = Math.min(0.9, Math.max(0.1, target));
      continue;
    }
    let half = widthFrac / 2;
    for (const r of hits) {
      half = Math.min(half, r.x > box.x ? r.x - SIDE_CLEARANCE - box.x : box.x - (r.x + r.w) - SIDE_CLEARANCE);
    }
    if (half * 2 < MIN_TEXT_WIDTH) return null;
    widthFrac = half * 2;
  }
  return null;
}

const animatesPosition = (clip: Clip) => !!(clip.animation?.x || clip.animation?.y);

export function reviewProject(input: ReviewInput): ReviewIssue[] {
  const { project, assets, region, target, normalize } = input;
  const issues: ReviewIssue[] = [];
  const { startMs, durationMs } = exportSpan(project, region);
  const endMs = startMs + durationMs;

  const disconnected = disconnectedSourceNames(project, assets);
  if (disconnected.length) issues.push({ id: 'disconnected', names: disconnected });

  if (target !== 'audio') {
    const gaps = blackGaps(project, startMs, endMs);
    if (gaps.length) issues.push({ id: 'blackGaps', gaps });

    const visibleTracks = project.tracks.filter(
      (track) => track.kind === 'video' && isTrackVisible(track, project.tracks),
    );

    if (target === 'social') {
      const clipIds: string[] = [];
      const fixes: FramingFix[] = [];
      for (const track of visibleTracks) {
        for (const clip of track.clips) {
          if (!isTextClip(clip) || !overlaps(clip, startMs, endMs) || !clip.text.content.trim()) continue;
          // Merged over the defaults like the compositor does: a transform
          // written field by field may lack x or y.
          const t = { ...DEFAULT_TRANSFORM, ...clip.transform };
          const box = {
            x: t.x,
            y: t.y,
            widthFrac: clip.text.widthFrac ?? DEFAULT_TEXT_WIDTH_FRAC,
          };
          const way = textClearance(project.aspectRatio, box);
          if (way === 'clear') continue;
          clipIds.push(clip.id);
          // A keyframed position is authored over time: writing a static
          // value would drop the animation, so that one is the user's call.
          if (way && !animatesPosition(clip)) {
            fixes.push({
              clipId: clip.id,
              transform: { ...t, y: way.y },
              ...(way.widthFrac !== box.widthFrac ? { widthFrac: way.widthFrac } : {}),
            });
          }
        }
      }
      if (clipIds.length) issues.push({ id: 'uiZone', clipIds, fixes });
    }

    // Black bands: footage smaller than the frame with nothing below it.
    const out = outputDimensions(project.aspectRatio);
    const letterboxed: string[] = [];
    const fills: FramingFix[] = [];
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
