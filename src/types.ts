export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:5';

export interface Project {
  id: string;
  aspectRatio: AspectRatio;
  fps: number;
  tracks: Track[];
  markers: Marker[];
}

/** A named point on the timeline (cue). */
export interface Marker {
  id: string;
  timeMs: number;
  /** Empty label: the marker shows its number only. */
  label: string;
}

/**
 * Timeline selection - the Vegas "yellow corners". Drives loop playback and
 * can restrict an export to that span. Session state, not project data.
 */
export interface LoopRegion {
  startMs: number;
  endMs: number;
}

/** Markers in timeline order - the order that numbers them (1, 2, 3…). */
export function sortedMarkers(project: Project): Marker[] {
  return [...(project.markers ?? [])].sort((a, b) => a.timeMs - b.timeMs);
}

export interface Track {
  id: string;
  kind: 'video' | 'audio';
  clips: Clip[];
  muted?: boolean;
  hidden?: boolean;
  /** Track gain applied on top of each clip's volume (0..2, default 1). */
  volume?: number;
  /** Video only: opacity multiplier for every clip on the track (0..1, default 1). */
  opacity?: number;
}

export interface MediaAsset {
  id: string;
  file: File;
  kind: 'video' | 'audio';
  durationMs: number;
  width?: number;
  height?: number;
  /** Whether the asset has a decodable audio track (true for pure audio, usually true for video). */
  hasAudio: boolean;
  /** Thumbnails (data URLs) spread across the duration, used to paint video clips. */
  thumbnails: string[];
  /** Normalized audio peaks (0..1) over the whole duration, for waveform rendering. */
  peaks?: number[];
}

export interface ClipTransform {
  /** Source crop, normalized 0..1 (x, y = top-left corner). */
  crop: { x: number; y: number; w: number; h: number };
  /** Center position of the clip in the output, normalized 0..1 (0.5 = centered). */
  x: number;
  y: number;
  /** Scale multiplier applied after the "contain" fit. */
  scale: number;
}

/** Content of a generated text clip (no backing media asset). */
export interface ClipText {
  content: string;
  /** CSS color of the glyphs. */
  color: string;
  /** Font size as a fraction of the output height (0.08 ≈ lower-third title). */
  sizeFrac: number;
  bold?: boolean;
  /** Thick dark stroke behind the glyphs — keeps captions readable over footage. */
  outline?: boolean;
  /** Rounded dark panel behind each line (caption pill). */
  background?: boolean;
}

/** A generated full-frame colour or two-colour gradient. */
export interface ClipSolid {
  /** A single fill, or a linear gradient between the two colours. */
  kind: 'color' | 'gradient';
  color: string;
  color2?: string;
  /** Direction of a gradient, in degrees (0 = left to right). */
  angle?: number;
}

export interface Clip {
  id: string;
  /** Empty string for generated clips (text) that have no media asset. */
  assetId: string;
  trackId: string;
  timelineStartMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  /** 1 = normal, <1 = slow motion, >1 = sped up. */
  speed: number;
  /** 0..2 */
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** Stereo balance, -1 (left) .. 1 (right). Default 0. */
  pan?: number;
  /** Downmix the clip's audio to mono. */
  mono?: boolean;
  transform?: ClipTransform;
  /**
   * Animated zoom (Ken Burns): scale multiplier reached at the END of the
   * clip, interpolated linearly from 1 at the start. 1/undefined = static.
   */
  zoomEnd?: number;
  /** Present on text clips; the clip then renders text instead of media. */
  text?: ClipText;
  /** Present on solid clips; the clip then renders a full-frame fill instead of media. */
  solid?: ClipSolid;
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

/** A clip that renders generated text instead of a media asset. */
export function isTextClip(clip: Clip): boolean {
  return clip.text != null;
}

/** A clip with no backing media asset. */
export function isGeneratedClip(clip: Clip): boolean {
  return clip.text != null || clip.solid != null;
}

export const DEFAULT_TRANSFORM: ClipTransform = {
  crop: { x: 0, y: 0, w: 1, h: 1 },
  x: 0.5,
  y: 0.5,
  scale: 1,
};

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

/** Total project duration (end of the last clip), in ms. */
export function projectDurationMs(project: Project): number {
  let max = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      max = Math.max(max, clipEndMs(clip));
    }
  }
  return max;
}

/** Fade gain of a clip at a given timeline time (0..1), used for both opacity and audio. */
export function clipFadeGainAt(clip: Clip, timelineMs: number): number {
  return clipEnvelopeGainAt(clip, timelineMs, 0, 0);
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

export interface CrossfadeWindows {
  /** Overlap with the previous clip on the track (ramp-in duration), ms. */
  inMs: number;
  /** Overlap with the next clip on the track (ramp-out duration), ms. */
  outMs: number;
}

/**
 * Crossfades of a track, derived purely from clip overlap: when two
 * consecutive clips overlap, the incoming clip ramps in and the outgoing
 * clip ramps out over the shared region (Vegas-style transition by sliding).
 */
export function trackCrossfades(clips: Clip[]): Map<string, CrossfadeWindows> {
  const out = new Map<string, CrossfadeWindows>();
  const sorted = [...clips].sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  for (const c of sorted) out.set(c.id, { inMs: 0, outMs: 0 });
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const overlap = clipEndMs(prev) - cur.timelineStartMs;
    if (overlap <= 0) continue;
    const window = Math.min(overlap, clipDurationMs(prev), clipDurationMs(cur));
    out.get(prev.id)!.outMs = Math.max(out.get(prev.id)!.outMs, window);
    out.get(cur.id)!.inMs = Math.max(out.get(cur.id)!.inMs, window);
  }
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
