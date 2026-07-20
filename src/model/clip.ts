import {
  AudioTrackInfo,
  Clip,
  ClipTransform,
  MediaAsset,
  ShapeClip,
  SolidClip,
  TextClip,
  isTrackPlayable,
} from '../types';

/**
 * Clip-level model math: durations, source<->timeline mapping, fade/zoom
 * envelopes and the kind guards. Pure functions, no DOM — the single source of
 * truth shared by preview, export and the timeline UI.
 */

export const DEFAULT_TRANSFORM: ClipTransform = {
  crop: { x: 0, y: 0, w: 1, h: 1 },
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
};

/**
 * Default width of a text clip's wrap box, as a fraction of the output width.
 * Under 1 on purpose: broadcast captions keep a margin, and a line that ends
 * flush against the frame edge reads as clipped.
 */
export const DEFAULT_TEXT_WIDTH_FRAC = 0.9;

/** A clip that renders generated text instead of a media asset. */
export function isTextClip(clip: Clip): clip is TextClip {
  return clip.kind === 'text';
}

/**
 * Deep-copy a clip. Clips are plain JSON data, so a JSON round-trip is enough —
 * and unlike `structuredClone` it also accepts Immer draft proxies, which every
 * browser's `structuredClone` rejects (DataCloneError). Always use this to
 * copy a clip inside a store mutation.
 */
export function cloneClip<T extends Clip>(clip: T): T {
  return JSON.parse(JSON.stringify(clip)) as T;
}

/**
 * The source audio track a clip draws its sound (and waveform) from: the one
 * whose `index` matches `clip.audioTrackIndex`, or the asset's first track when
 * the clip doesn't pin a track (undefined index = primary). Returns undefined
 * for a silent asset. Shared by the mix, the export and the timeline waveform so
 * they never disagree about which track a clip plays.
 */
export function audioTrackForClip(
  asset: MediaAsset,
  clip: Clip,
): AudioTrackInfo | undefined {
  if (asset.audioTracks.length === 0) return undefined;
  // A pinned index wins even when that track is undecodable: the clip exists to
  // play THAT track, and it becomes audible as soon as the user transcodes it.
  if (clip.audioTrackIndex != null) {
    const pinned = asset.audioTracks.find((a) => a.index === clip.audioTrackIndex);
    if (pinned) return pinned;
  }
  // Unpinned: fall back to something actually audible rather than to whichever
  // track happens to come first in the file.
  return asset.audioTracks.find(isTrackPlayable) ?? asset.audioTracks[0];
}

/** A clip that renders a drawn primitive instead of a media asset. */
export function isShapeClip(clip: Clip): clip is ShapeClip {
  return clip.kind === 'shape';
}

/** A clip with no backing media asset (text, solid or shape). */
export function isGeneratedClip(clip: Clip): clip is TextClip | SolidClip | ShapeClip {
  return clip.kind !== 'media';
}

/** Duration of a clip on the timeline, in ms. */
export function clipDurationMs(clip: Clip): number {
  return (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
}

/** End of a clip on the timeline, in ms. */
export function clipEndMs(clip: Clip): number {
  return clip.timelineStartMs + clipDurationMs(clip);
}

/** Source time (ms) corresponding to a timeline time (ms) for a clip. */
export function timelineToSourceMs(clip: Clip, timelineMs: number): number {
  return clip.sourceInMs + (timelineMs - clip.timelineStartMs) * clip.speed;
}

/**
 * Zoom-animation multiplier of a clip at a timeline time: ramps 1 → zoomEnd
 * across the clip. Applied on top of transform.scale everywhere a dest rect
 * is computed, so preview, hit-testing and export stay in lockstep.
 */
export function clipZoomAt(clip: Clip, timelineMs: number): number {
  const zoomEnd = clip.zoomEnd ?? 1;
  if (zoomEnd === 1) return 1;
  const dur = clipDurationMs(clip);
  if (dur <= 0) return 1;
  const progress = Math.min(1, Math.max(0, (timelineMs - clip.timelineStartMs) / dur));
  return 1 + (zoomEnd - 1) * progress;
}

/**
 * Fade gain including crossfade windows (overlap with neighboring clips).
 * A crossfade behaves like an implicit fade of the overlap duration; when the
 * clip also has an explicit fade on the same edge, the longer one wins so the
 * envelope stays a single linear ramp.
 */
export function clipEnvelopeGainAt(
  clip: Clip,
  timelineMs: number,
  xfadeInMs: number,
  xfadeOutMs: number,
): number {
  const dur = clipDurationMs(clip);
  const local = timelineMs - clip.timelineStartMs;
  const fadeIn = Math.max(clip.fadeInMs, xfadeInMs);
  const fadeOut = Math.max(clip.fadeOutMs, xfadeOutMs);
  let gain = 1;
  if (fadeIn > 0) gain = Math.min(gain, local / fadeIn);
  if (fadeOut > 0) gain = Math.min(gain, (dur - local) / fadeOut);
  return Math.max(0, Math.min(1, gain));
}
