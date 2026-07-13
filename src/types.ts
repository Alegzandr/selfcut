export type AspectRatio = '16:9' | '9:16';

export interface Project {
  id: string;
  aspectRatio: AspectRatio;
  fps: number;
  tracks: Track[];
}

export interface Track {
  id: string;
  kind: 'video' | 'audio';
  clips: Clip[];
  muted?: boolean;
  hidden?: boolean;
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

export interface Clip {
  id: string;
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
  transform?: ClipTransform;
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
  const dur = clipDurationMs(clip);
  const local = timelineMs - clip.timelineStartMs;
  let gain = 1;
  if (clip.fadeInMs > 0) gain = Math.min(gain, local / clip.fadeInMs);
  if (clip.fadeOutMs > 0) gain = Math.min(gain, (dur - local) / clip.fadeOutMs);
  return Math.max(0, Math.min(1, gain));
}

/** Output dimensions for an aspect ratio (default export resolution). */
export function outputDimensions(aspect: AspectRatio): { width: number; height: number } {
  return aspect === '16:9' ? { width: 1920, height: 1080 } : { width: 1080, height: 1920 };
}
