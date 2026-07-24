import {
  AnimatableProp,
  AudioTrackInfo,
  Clip,
  ClipAnimation,
  ClipMask,
  ClipTransform,
  MediaAsset,
  ShapeClip,
  SolidClip,
  TextClip,
  isTrackPlayable,
} from '../types';
import { sampleChannel } from './animation';
import { buildCurveTexture, curvesAreIdentity } from './curves';

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

/** A clip transform with every animatable field resolved to a plain number. */
export interface ResolvedTransform {
  crop: ClipTransform['crop'];
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/** Value of an animatable property at a clip-local time, or its static fallback. */
function animatedValue(
  anim: ClipAnimation | undefined,
  prop: AnimatableProp,
  fallback: number,
  localMs: number,
): number {
  const keys = anim?.[prop];
  return keys && keys.length ? sampleChannel(keys, localMs) : fallback;
}

/**
 * The clip's transform at a timeline time, with any keyframed property sampled
 * and any static one passed through. The one place animation is folded into
 * geometry — preview, export and hit-testing all resolve through here, so a
 * moving clip is framed identically wherever it is drawn or picked. Crop is not
 * animatable in v1 and is passed through as-is.
 */
export function resolveTransform(clip: Clip, timelineMs: number): ResolvedTransform {
  const t = clip.transform ?? DEFAULT_TRANSFORM;
  const local = timelineMs - clip.timelineStartMs;
  const a = clip.animation;
  return {
    crop: t.crop,
    x: animatedValue(a, 'x', t.x, local),
    y: animatedValue(a, 'y', t.y, local),
    scale: animatedValue(a, 'scale', t.scale, local),
    rotation: animatedValue(a, 'rotation', t.rotation ?? 0, local),
  };
}

/**
 * Per-clip opacity at a timeline time: the sampled `opacity` channel (clamped
 * 0..1) when the clip animates it, otherwise 1. Multiplied into the draw alpha
 * on top of fades and track opacity, so an opacity keyframe animates a clip's
 * transparency without touching the fade envelope.
 */
export function resolveOpacity(clip: Clip, timelineMs: number): number {
  const keys = clip.animation?.opacity;
  if (!keys || !keys.length) return 1;
  return Math.max(0, Math.min(1, sampleChannel(keys, timelineMs - clip.timelineStartMs)));
}

/** Rotation (degrees) at a timeline time, sampling the channel or the static value. */
export function clipRotationAt(clip: Clip, timelineMs: number): number {
  return animatedValue(clip.animation, 'rotation', clip.transform?.rotation ?? 0, timelineMs - clip.timelineStartMs);
}

/**
 * Blur amount (0..1) at a timeline time — a fraction of the output height,
 * applied as a Canvas 2D `filter` when the clip is composited. Separate from
 * `resolveColor` because blur is a spatial filter, not a WebGL colour grade, and
 * a blur-only clip must not spin up the colour pass.
 */
export function resolveBlur(clip: Clip, timelineMs: number): number {
  const b = clip.color?.blur;
  if (b === undefined) return 0;
  return Math.max(0, sampleChannel(b, timelineMs - clip.timelineStartMs));
}

/** A mask's animated transform sampled to plain numbers at a clip-local time. */
export interface ResolvedMaskMotion {
  tx: number;
  ty: number;
  scale: number;
  rotation: number;
}

/**
 * The mask's motion transform at a clip-local time: each channel sampled, or its
 * identity default (0 offset, scale 1, no rotation) when the mask does not
 * animate that axis. Shared by preview and export so a tracked mask lands in the
 * same place wherever it is drawn.
 */
export function resolveMaskMotion(mask: ClipMask, localMs: number): ResolvedMaskMotion {
  const m = mask.motion;
  return {
    tx: m?.tx !== undefined ? sampleChannel(m.tx, localMs) : 0,
    ty: m?.ty !== undefined ? sampleChannel(m.ty, localMs) : 0,
    scale: m?.scale !== undefined ? sampleChannel(m.scale, localMs) : 1,
    rotation: m?.rotation !== undefined ? sampleChannel(m.rotation, localMs) : 0,
  };
}

/** Colour grading resolved to plain numbers at a timeline time. */
export interface ResolvedColor {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  tint: number;
  vignette: number;
  /**
   * The LUT to apply before the numeric adjustments, when the clip carries one
   * at a non-zero intensity. `id` is looked up in the renderer's LUT registry
   * (fed from `Project.luts`); a LUT that isn't registered is drawn as no LUT.
   */
  lut?: { id: string; intensity: number };
  /**
   * Baked 256×4 RGBA tone-curve texture (see `buildCurveTexture`), present only
   * when the clip carries non-identity curves. The colour pass uploads it to a
   * 1D lookup; absent = no curve stage.
   */
  curve?: Uint8Array;
  /**
   * Chroma key parameters resolved for the shader: the key colour as linear
   * 0..1 RGB, plus the three matte controls. Present only when the clip keys.
   */
  chroma?: {
    color: [number, number, number];
    similarity: number;
    smoothness: number;
    spill: number;
  };
}

/**
 * Parse a `#rgb`/`#rrggbb` hex colour to an RGB triple in 0..1. Falls back to
 * pure green (the green-screen default) for anything it can't read, so the
 * shader always gets a usable key colour.
 */
export function hexToRgb01(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return [0, 1, 0];
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * The clip's colour grade at a timeline time, sampling every (keyframable)
 * channel — or null when the clip has no grade or every field is the identity,
 * so the compositor skips the WebGL pass entirely for the common ungraded case.
 */
export function resolveColor(clip: Clip, timelineMs: number): ResolvedColor | null {
  const c = clip.color;
  if (!c) return null;
  const local = timelineMs - clip.timelineStartMs;
  const r: ResolvedColor = {
    brightness: sampleChannel(c.brightness ?? 0, local),
    contrast: sampleChannel(c.contrast ?? 0, local),
    saturation: sampleChannel(c.saturation ?? 0, local),
    temperature: sampleChannel(c.temperature ?? 0, local),
    tint: sampleChannel(c.tint ?? 0, local),
    vignette: sampleChannel(c.vignette ?? 0, local),
  };
  // A LUT at intensity 0 is a no-op the WebGL pass shouldn't spin up for.
  const lut = c.lut && c.lut.intensity > 0 ? { id: c.lut.id, intensity: Math.min(1, c.lut.intensity) } : undefined;
  const curves = c.curves && !curvesAreIdentity(c.curves) ? c.curves : undefined;
  const key = c.chromaKey
    ? {
        color: hexToRgb01(c.chromaKey.color),
        similarity: c.chromaKey.similarity,
        smoothness: c.chromaKey.smoothness,
        spill: c.chromaKey.spill,
      }
    : undefined;
  if (
    r.brightness === 0 &&
    r.contrast === 0 &&
    r.saturation === 0 &&
    r.temperature === 0 &&
    r.tint === 0 &&
    r.vignette === 0 &&
    !lut &&
    !curves &&
    !key
  ) {
    return null;
  }
  if (lut) r.lut = lut;
  if (curves) r.curve = buildCurveTexture(curves);
  if (key) r.chroma = key;
  return r;
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
