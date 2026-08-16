import { BezierPoint, Clip, ClipMask, ClipShape, ClipText, ShapeClip, SolidClip, TextClip, Track, TransitionType } from '../types';
import {
  DEFAULT_TEXT_WIDTH_FRAC,
  DEFAULT_TRANSFORM,
  clipEnvelopeGainAt,
  clipRotationAt,
  clipZoomAt,
  isTextClip,
  resolveBlur,
  resolveColor,
  resolveMaskMotion,
  resolveOpacity,
  resolveTransform,
  trackCrossfades,
} from '../model';
import { gradeFrame } from './colorPass';
import { fontStack } from '../lib/fonts';
import type { DrawableFrame } from '../media/stillImage';
import { count, endSpan, span } from '../perf/probe';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DestRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Rotate the canvas around a point, for the duration of `paint`.
 *
 * Applied around the clip's own centre so a rotation never drifts the clip -
 * the transform's x/y keep meaning "where the centre is", which is what the
 * drag gesture and the inspector both edit. A zero angle takes no save/restore
 * at all: the overwhelmingly common case must not pay for the feature.
 */
function withRotation(ctx: Ctx2D, deg: number, cx: number, cy: number, paint: () => void): void {
  if (!deg) {
    paint();
    return;
  }
  ctx.save();
  applyRotation(ctx, deg, cx, cy);
  paint();
  ctx.restore();
}

/**
 * Rotate the canvas around a point, leaving the restore to the caller - for the
 * draw paths that already sit inside their own save/restore pair.
 */
function applyRotation(ctx: Ctx2D, deg: number, cx: number, cy: number): void {
  if (!deg) return;
  ctx.translate(cx, cy);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.translate(-cx, -cy);
}

/** Rotation of a clip in degrees, tolerating transforms saved before it existed. */
export function clipRotation(clip: Clip): number {
  return clip.transform?.rotation ?? 0;
}

/**
 * Map a point in output coordinates into a clip's UN-rotated frame, so a plain
 * axis-aligned rect test still answers "is the pointer on this clip".
 */
export function unrotatePoint(
  px: number,
  py: number,
  deg: number,
  cx: number,
  cy: number,
): { x: number; y: number } {
  if (!deg) return { x: px, y: py };
  const a = (-deg * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

/**
 * Destination rectangle of a clip in the output, from the source dimensions
 * and the clip transform (crop → "contain" fit → user scale → per-axis
 * stretch, centered on x/y).
 * Shared by drawing, preview hit-testing and the selection overlay.
 * `timelineMs` applies the animated zoom (Ken Burns); omit for the static rect.
 */
export function clipDestRect(
  clip: Clip,
  srcW: number,
  srcH: number,
  outW: number,
  outH: number,
  timelineMs?: number,
): DestRect {
  const rt = resolveTransform(clip, timelineMs ?? clip.timelineStartMs);
  const zoom = timelineMs !== undefined ? clipZoomAt(clip, timelineMs) : 1;
  const cropW = Math.max(1, rt.crop.w * srcW);
  const cropH = Math.max(1, rt.crop.h * srcH);
  const fit = Math.min(outW / cropW, outH / cropH) * rt.scale * zoom;
  // The per-axis stretch multiplies the fitted size, so it is the last thing
  // applied and the only thing that can make the drawn rect differ in ratio
  // from the source. At 1/1 (the default, and every project saved before this
  // existed) the expression is exactly the uniform fit it used to be.
  const dw = cropW * fit * rt.scaleX;
  const dh = cropH * fit * rt.scaleY;
  return { dx: rt.x * outW - dw / 2, dy: rt.y * outH - dh / 2, dw, dh };
}

/**
 * Draw a clip's video sample onto the output canvas, applying crop, position,
 * scale and fade opacity. Shared by preview and export.
 *
 * `alphaMul` is the track opacity; `xfadeInMs` is the overlap with the
 * previous clip on the track. Only the ramp-IN is applied visually: the
 * incoming clip composites over the outgoing one with rising alpha, which
 * gives a true cross-dissolve without the mid-fade dip to black that two
 * symmetrical alpha ramps would produce.
 */
export function drawClipSample(
  ctx: Ctx2D,
  sample: DrawableFrame,
  clip: Clip,
  outW: number,
  outH: number,
  timelineMs: number,
  alphaMul = 1,
  xfadeInMs = 0,
): void {
  const alpha = clipEnvelopeGainAt(clip, timelineMs, xfadeInMs, 0) * alphaMul * resolveOpacity(clip, timelineMs);
  if (alpha <= 0) return;

  const t = clip.transform ?? DEFAULT_TRANSFORM;
  const sw = sample.displayWidth;
  const sh = sample.displayHeight;
  const sx = t.crop.x * sw;
  const sy = t.crop.y * sh;
  const cropW = Math.max(1, t.crop.w * sw);
  const cropH = Math.max(1, t.crop.h * sh);
  const { dx, dy, dw, dh } = clipDestRect(clip, sw, sh, outW, outH, timelineMs);

  // Colour grade runs as an isolated WebGL pass that returns a canvas drawn in
  // the frame's place; a null grade (no adjustment or no WebGL) draws the frame
  // directly, so the ungraded path is untouched.
  const color = resolveColor(clip, timelineMs);
  let graded: CanvasImageSource | null = null;
  if (color) {
    const started = span();
    graded = gradeFrame(sample, sw, sh, color);
    endSpan('grade', started);
    if (graded) count('gradedClips');
  }
  // Blur is the browser's own gaussian via the 2D filter. Its cost is measured
  // (`blur` channel) rather than assumed: it is the one effect whose price is
  // set by the browser's filter implementation and not by anything here.
  const blurPx = resolveBlur(clip, timelineMs) * outH * 0.06;

  // Resampling quality is only worth paying for when the draw actually
  // resamples. A 1:1 blit - the common case for a full-frame clip in an export
  // at the source resolution - asks the rasterizer for a filtered path it then
  // has no work to do in, so it is turned off outright there.
  const resampling = Math.abs(dw - cropW) > 0.5 || Math.abs(dh - cropH) > 0.5;
  setResampling(ctx, resampling);

  const drawStarted = span();
  ctx.globalAlpha = alpha;
  if (blurPx > 0) ctx.filter = `blur(${blurPx}px)`;
  withRotation(ctx, clipRotationAt(clip, timelineMs), dx + dw / 2, dy + dh / 2, () => {
    if (graded) ctx.drawImage(graded, sx, sy, cropW, cropH, dx, dy, dw, dh);
    else sample.draw(ctx, sx, sy, cropW, cropH, dx, dy, dw, dh);
  });
  if (blurPx > 0) ctx.filter = 'none';
  ctx.globalAlpha = 1;
  endSpan(blurPx > 0 ? 'blur' : 'blit', drawStarted);
  count('clipDraws');
}

/**
 * Last resampling mode written to each context, so the common case (every clip
 * in a frame wants the same one) touches the two properties once instead of
 * once per clip. Weak, so a disposed offscreen context is not retained.
 */
const resamplingState = new WeakMap<object, boolean>();

function setResampling(ctx: Ctx2D, on: boolean): void {
  if (resamplingState.get(ctx) === on) return;
  resamplingState.set(ctx, on);
  ctx.imageSmoothingEnabled = on;
  if (on) ctx.imageSmoothingQuality = 'high';
}

/**
 * Forget what `setResampling` believes about a context. Resizing a canvas resets
 * every context property, so the caller that resizes must say so or the cache
 * would keep a stale belief and skip the re-arm.
 */
export function invalidateResampling(ctx: Ctx2D): void {
  resamplingState.delete(ctx);
}

/** Font shorthand for a text clip at a given output height and clip scale. */
function textFont(text: ClipText, outH: number, scale: number): { font: string; px: number } {
  const px = Math.max(1, text.sizeFrac * outH * scale);
  return { font: `${text.bold ? '700' : '400'} ${px}px ${fontStack(text.font)}`, px };
}

/** Width of the wrap box in output pixels. */
function textBoxWidth(text: ClipText, outW: number): number {
  return Math.max(1, (text.widthFrac ?? DEFAULT_TEXT_WIDTH_FRAC) * outW);
}

/**
 * Break one paragraph greedily at `maxW`. A single word too long for the box
 * (a URL, a long compound) is split per character rather than left to overflow
 * the frame — a caption that runs off screen is worse than an ugly break.
 * `ctx.font` must already be set.
 */
function wrapParagraph(ctx: Ctx2D, paragraph: string, maxW: number): string[] {
  if (ctx.measureText(paragraph).width <= maxW) return [paragraph];
  const lines: string[] = [];
  let line = '';
  for (const word of paragraph.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxW) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    if (ctx.measureText(word).width <= maxW) {
      line = word;
      continue;
    }
    // Hard-break the oversized word, keeping the tail as the running line.
    let chunk = '';
    for (const char of word) {
      if (chunk && ctx.measureText(chunk + char).width > maxW) {
        lines.push(chunk);
        chunk = char;
      } else {
        chunk += char;
      }
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The lines a text clip actually paints: explicit `\n` breaks first, then word
 * wrap inside the box. Shared by drawing and by `textClipRect`, so the
 * selection overlay always frames exactly what is on screen.
 */
export function layoutTextLines(ctx: Ctx2D, text: ClipText, outW: number): string[] {
  const maxW = textBoxWidth(text, outW);
  return text.content.split('\n').flatMap((p) => (p ? wrapParagraph(ctx, p, maxW) : ['']));
}

/**
 * Where lines are anchored horizontally, in output pixels. `align` positions
 * them against the edges of the wrap box (centered on `transform.x`), not
 * against each other — so left-aligning a caption pins it to a stable margin
 * instead of shifting with the longest line.
 */
function textAnchorX(text: ClipText, tx: number, outW: number): number {
  const cx = tx * outW;
  const half = textBoxWidth(text, outW) / 2;
  if (text.align === 'left') return cx - half;
  if (text.align === 'right') return cx + half;
  return cx;
}

/** Left edge of a painted line of width `w`, given the anchor and alignment. */
function lineLeft(align: ClipText['align'], anchorX: number, w: number): number {
  if (align === 'left') return anchorX;
  if (align === 'right') return anchorX - w;
  return anchorX - w / 2;
}

/**
 * Draw a generated text clip. Same fade/crossfade semantics as media clips,
 * position and scale come from the clip transform (crop is ignored).
 */
export function drawTextClip(
  ctx: Ctx2D,
  clip: TextClip,
  outW: number,
  outH: number,
  timelineMs: number,
  alphaMul = 1,
  xfadeInMs = 0,
): void {
  const text = clip.text;
  if (!text.content) return;
  const alpha = clipEnvelopeGainAt(clip, timelineMs, xfadeInMs, 0) * alphaMul * resolveOpacity(clip, timelineMs);
  if (alpha <= 0) return;

  const rt = resolveTransform(clip, timelineMs);
  const { font, px } = textFont(text, outH, rt.scale);

  ctx.save();
  ctx.globalAlpha = alpha;
  // Rotates the caption block as a whole, inside the save/restore already here.
  // Around the transform centre, not the text baseline, so a rotated caption
  // stays where it was placed.
  applyRotation(ctx, rt.rotation, rt.x * outW, rt.y * outH);
  // Set before laying out: wrapping measures against this exact font.
  ctx.font = font;
  const lines = layoutTextLines(ctx, text, outW);
  const lineHeight = px * 1.2;
  ctx.textAlign = text.align ?? 'center';
  ctx.textBaseline = 'middle';
  const anchorX = textAnchorX(text, rt.x, outW);
  const cy = rt.y * outH;
  const lineY = (i: number) => cy + (i - (lines.length - 1) / 2) * lineHeight;

  // Caption pill: rounded dark panel behind each line.
  if (text.background) {
    const padX = px * 0.35;
    const padY = px * 0.14;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      const w = ctx.measureText(lines[i]!).width;
      const y = lineY(i);
      ctx.beginPath();
      ctx.roundRect(
        lineLeft(text.align, anchorX, w) - padX,
        y - px / 2 - padY,
        w + padX * 2,
        px + padY * 2,
        px * 0.25,
      );
      ctx.fill();
    }
  } else {
    // Soft shadow so light text stays readable over light footage.
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = px * 0.12;
    ctx.shadowOffsetY = px * 0.03;
  }

  // Thick dark stroke under the fill (the classic caption outline).
  if (text.outline) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, px * 0.16);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    for (let i = 0; i < lines.length; i++) {
      ctx.strokeText(lines[i]!, anchorX, lineY(i));
    }
  }

  ctx.fillStyle = text.color;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i]!, anchorX, lineY(i));
  }
  ctx.restore();
}

/** Draw a generated full-frame colour or linear gradient. */
export function drawSolidClip(
  ctx: Ctx2D,
  clip: SolidClip,
  outW: number,
  outH: number,
  timelineMs: number,
  alphaMul = 1,
  xfadeInMs = 0,
): void {
  const solid = clip.solid;
  const alpha = clipEnvelopeGainAt(clip, timelineMs, xfadeInMs, 0) * alphaMul * resolveOpacity(clip, timelineMs);
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (solid.kind === 'gradient') {
    const radians = ((solid.angle ?? 0) * Math.PI) / 180;
    const x = Math.cos(radians) * outW / 2;
    const y = Math.sin(radians) * outH / 2;
    const gradient = ctx.createLinearGradient(outW / 2 - x, outH / 2 - y, outW / 2 + x, outH / 2 + y);
    gradient.addColorStop(0, solid.color);
    gradient.addColorStop(1, solid.color2 ?? solid.color);
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = solid.color;
  }
  ctx.fillRect(0, 0, outW, outH);
  ctx.restore();
}

/**
 * Bounding box of a shape in output coordinates. The size is the shape's own
 * fraction of the frame, the centre and the scale come from the transform - so
 * hit-testing, the selection outline and the corner handles need no extra case.
 */
export function shapeClipRect(clip: ShapeClip, outW: number, outH: number, timelineMs?: number): DestRect {
  const rt = resolveTransform(clip, timelineMs ?? clip.timelineStartMs);
  const dw = clip.shape.w * outW * rt.scale;
  const dh = clip.shape.h * outH * rt.scale;
  return { dx: rt.x * outW - dw / 2, dy: rt.y * outH - dh / 2, dw, dh };
}

/** Trace the outline into the current path, centred on (cx, cy). */
function traceShape(ctx: Ctx2D, shape: ClipShape, rect: DestRect): void {
  const { dx, dy, dw, dh } = rect;
  if (shape.kind === 'ellipse') {
    ctx.ellipse(dx + dw / 2, dy + dh / 2, dw / 2, dh / 2, 0, 0, Math.PI * 2);
    return;
  }
  if (shape.kind === 'polygon') {
    // Inscribed in the box, first vertex pointing up - the orientation everyone
    // expects from a triangle or a pentagon.
    const sides = Math.max(3, Math.round(shape.sides));
    const cx = dx + dw / 2;
    const cy = dy + dh / 2;
    for (let i = 0; i < sides; i++) {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / sides;
      const px = cx + (Math.cos(a) * dw) / 2;
      const py = cy + (Math.sin(a) * dh) / 2;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    return;
  }
  const r = Math.min(shape.radius, 0.5) * Math.min(dw, dh);
  if (r > 0) ctx.roundRect(dx, dy, dw, dh, r);
  else ctx.rect(dx, dy, dw, dh);
}

export function drawShapeClip(
  ctx: Ctx2D,
  clip: ShapeClip,
  outW: number,
  outH: number,
  timelineMs: number,
  alphaMul = 1,
  xfadeInMs = 0,
): void {
  const alpha = clipEnvelopeGainAt(clip, timelineMs, xfadeInMs, 0) * alphaMul * resolveOpacity(clip, timelineMs);
  if (alpha <= 0) return;
  const rect = shapeClipRect(clip, outW, outH, timelineMs);
  if (rect.dw <= 0 || rect.dh <= 0) return;

  const shape = clip.shape;
  ctx.save();
  ctx.globalAlpha = alpha;
  applyRotation(ctx, clipRotationAt(clip, timelineMs), rect.dx + rect.dw / 2, rect.dy + rect.dh / 2);
  ctx.beginPath();
  traceShape(ctx, shape, rect);
  ctx.fillStyle = shape.fill;
  ctx.fill();
  if (shape.stroke && shape.strokeWidth > 0) {
    // Relative to the output height, so a shape keeps its look across the
    // resolution rungs the preview renders at.
    ctx.lineWidth = shape.strokeWidth * outH;
    ctx.strokeStyle = shape.stroke;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.restore();
}

let measureCtx: Ctx2D | null = null;

/**
 * Bounding box of a text clip in output coordinates (hit-testing and the
 * preview selection overlay). Uses a shared 1×1 measuring context.
 */
export function textClipRect(clip: TextClip, outW: number, outH: number, timelineMs?: number): DestRect {
  const text = clip.text;
  const rt = resolveTransform(clip, timelineMs ?? clip.timelineStartMs);
  if (!text.content) return { dx: rt.x * outW, dy: rt.y * outH, dw: 0, dh: 0 };
  if (!measureCtx) {
    measureCtx =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1).getContext('2d')
        : (document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D);
  }
  const { font, px } = textFont(text, outH, rt.scale);
  measureCtx!.font = font;
  const lines = layoutTextLines(measureCtx!, text, outW);
  let dw = 0;
  for (const line of lines) dw = Math.max(dw, measureCtx!.measureText(line).width);
  let dh = lines.length * px * 1.2;
  if (text.background) {
    dw += px * 0.7;
    dh += px * 0.28;
  }
  // Same anchor as the drawing pass, so the overlay frames the painted block
  // whatever the alignment.
  return { dx: lineLeft(text.align, textAnchorX(text, rt.x, outW), dw), dy: rt.y * outH - dh / 2, dw, dh };
}

/**
 * A track's clips sorted by start time, with the lookup tables that turn "which
 * clips are visible at t" into a binary search plus a two-step walk instead of a
 * scan of every clip.
 *
 * Memoized on the clips array itself (see `trackIndex`), the way
 * `trackCrossfades` already is: an untouched track keeps its index across every
 * frame of playback, and an edit produces a new array so the index rebuilds
 * exactly once.
 */
interface TrackIndex {
  /** Clips by ascending `timelineStartMs`. */
  order: Clip[];
  /** Exclusive end of `order[i]` on the timeline. */
  ends: Float64Array;
  /** max(ends[0..i]) - lets the backward walk stop as soon as nothing can reach t. */
  maxEnd: Float64Array;
}

const trackIndexCache = new WeakMap<Clip[], TrackIndex>();

function buildTrackIndex(clips: Clip[]): TrackIndex {
  const order = clips.slice().sort((a, b) => a.timelineStartMs - b.timelineStartMs);
  const ends = new Float64Array(order.length);
  const maxEnd = new Float64Array(order.length);
  let running = -Infinity;
  for (let i = 0; i < order.length; i++) {
    const clip = order[i]!;
    ends[i] = clip.timelineStartMs + (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
    running = Math.max(running, ends[i]!);
    maxEnd[i] = running;
  }
  return { order, ends, maxEnd };
}

function trackIndex(clips: Clip[]): TrackIndex {
  let index = trackIndexCache.get(clips);
  if (!index) {
    index = buildTrackIndex(clips);
    trackIndexCache.set(clips, index);
  }
  return index;
}

/** Index of the last clip whose start is <= t, or -1. */
function lastStartedAt(index: TrackIndex, tMs: number): number {
  let lo = 0;
  let hi = index.order.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index.order[mid]!.timelineStartMs <= tMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Clips of a track visible at time t, in draw order (earliest start first -
 * the later clip composites over the earlier one during a crossfade).
 * A legal layout has at most two (pairwise overlaps only).
 *
 * Allocates its result, so it is for the paths that need an array (hit-testing,
 * tests). The render loop uses `forEachVisibleVideoClip`, which does not.
 */
export function clipsAt(clips: Clip[], tMs: number): Clip[] {
  const index = trackIndex(clips);
  const last = lastStartedAt(index, tMs);
  const visible: Clip[] = [];
  if (last < 0) return visible;
  let first = last;
  while (first > 0 && index.maxEnd[first - 1]! > tMs) first--;
  for (let i = first; i <= last; i++) {
    if (index.ends[i]! > tMs) visible.push(index.order[i]!);
  }
  return visible;
}

/** A clip visible at a given time, paired with its crossfade ramp-in duration. */
export interface VisibleClip {
  clip: Clip;
  xfadeInMs: number;
}

/**
 * Visit the visible clips of a video track at time t, each with its crossfade
 * ramp-in, in draw order. Nothing for non-video, hidden or empty tracks. Preview
 * and export both iterate this, so they composite tracks identically.
 *
 * Allocation-free: this runs once per track per frame, 60 times a second, and
 * the array it used to build was garbage on every one of them.
 */
export function forEachVisibleVideoClip(
  track: Track,
  tMs: number,
  fn: (clip: Clip, xfadeInMs: number) => void,
): void {
  if (track.kind !== 'video' || track.hidden || track.clips.length === 0) return;
  const index = trackIndex(track.clips);
  const last = lastStartedAt(index, tMs);
  if (last < 0) return;
  // Walk back to the earliest clip that could still be on screen, then forward
  // from there, so `fn` sees them in start order like the sort used to give.
  let first = last;
  while (first > 0 && index.maxEnd[first - 1]! > tMs) first--;
  const xfades = trackCrossfades(track.clips);
  for (let i = first; i <= last; i++) {
    if (index.ends[i]! > tMs) fn(index.order[i]!, xfades.get(index.order[i]!.id)?.inMs ?? 0);
  }
}

/**
 * Visit the video clips of a track that start inside `(tMs, tMs + windowMs]`,
 * in start order.
 *
 * The playback engine uses this to open a clip's decoder before the playhead
 * reaches it. A cold cursor has to demux the file, configure a decoder and seek
 * to a keyframe before it can hand over a first frame, and a clip with nothing
 * decoded yet draws nothing - which on a straight cut is a black flash at every
 * boundary.
 */
export function forEachUpcomingVideoClip(
  track: Track,
  tMs: number,
  windowMs: number,
  fn: (clip: Clip) => void,
): void {
  if (track.kind !== 'video' || track.hidden || track.clips.length === 0) return;
  const index = trackIndex(track.clips);
  const until = tMs + windowMs;
  // Everything after `lastStartedAt` starts later than t, and `order` is sorted
  // by start, so the first clip past the window ends the walk.
  for (let i = lastStartedAt(index, tMs) + 1; i < index.order.length; i++) {
    const clip = index.order[i]!;
    if (clip.timelineStartMs > until) break;
    fn(clip);
  }
}

/** Array form of `forEachVisibleVideoClip`, for tests and non-hot callers. */
export function visibleVideoClips(track: Track, tMs: number): VisibleClip[] {
  const out: VisibleClip[] = [];
  forEachVisibleVideoClip(track, tMs, (clip, xfadeInMs) => {
    out.push({ clip, xfadeInMs });
  });
  return out;
}

/** Pixel geometry of a mask on an `outW × outH` frame: top-left box and centre. */
export function maskBoundsPx(
  mask: ClipMask,
  outW: number,
  outH: number,
): { left: number; top: number; w: number; h: number; cx: number; cy: number } {
  const w = mask.w * outW;
  const h = mask.h * outH;
  const cx = mask.x * outW;
  const cy = mask.y * outH;
  return { left: cx - w / 2, top: cy - h / 2, w, h, cx, cy };
}

/**
 * A reusable full-frame scratch canvas for masked clips: the clip is drawn here,
 * the mask multiplied into its alpha, then the result composited onto the frame.
 * One per thread (preview main-thread, export worker), grown to the output size.
 */
let maskScratch: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } | null = null;

function getMaskScratch(w: number, h: number): typeof maskScratch {
  if (typeof OffscreenCanvas === 'undefined') return null;
  if (!maskScratch) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    maskScratch = { canvas, ctx };
  }
  if (maskScratch.canvas.width !== w || maskScratch.canvas.height !== h) {
    maskScratch.canvas.width = w;
    maskScratch.canvas.height = h;
  }
  return maskScratch;
}

/**
 * Axis-aligned region of the frame a mask can leave visible, in pixels.
 *
 * A mask multiplies the clip's alpha, so every pixel outside the mask shape is
 * transparent and compositing it is pure waste - and the scratch canvas it is
 * built in is full-frame, so clearing and copying all of it was the single
 * largest cost a masked clip carried. Returning a tight box lets the draw, the
 * clear and the composite all shrink to it.
 *
 * An INVERTED mask keeps everything outside the shape, so its region is the
 * whole frame and there is nothing to win: the function says so rather than
 * pretending otherwise.
 */
export function maskDirtyRect(
  mask: ClipMask,
  outW: number,
  outH: number,
  motion: { tx: number; ty: number; scale: number; rotation: number },
): { x: number; y: number; w: number; h: number } {
  const full = { x: 0, y: 0, w: outW, h: outH };
  if (mask.invert) return full;

  const { left, top, w, h, cx: boxCx, cy: boxCy } = maskBoundsPx(mask, outW, outH);
  let minx: number;
  let miny: number;
  let maxx: number;
  let maxy: number;
  const path = mask.shape === 'path' ? mask.path : undefined;
  if (path) {
    if (path.length < 2) return full;
    minx = Infinity;
    miny = Infinity;
    maxx = -Infinity;
    maxy = -Infinity;
    // Handles are included: a bezier segment never leaves the hull of its
    // anchors and control points, so this box always contains the curve.
    for (const p of path) {
      for (const q of [p, p.in, p.out]) {
        if (!q) continue;
        const x = q.x * outW;
        const y = q.y * outH;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
      }
    }
  } else {
    if (w <= 0 || h <= 0) return { x: 0, y: 0, w: 0, h: 0 };
    minx = left;
    miny = top;
    maxx = left + w;
    maxy = top + h;
  }

  // The same transform `applyMask` stamps the shape with: rotate/scale about the
  // shape's own centre, then translate. Applied to the four corners, then re-boxed.
  const { cx, cy } = path ? maskPathCenterPx(path, outW, outH) : { cx: boxCx, cy: boxCy };
  const rad = (motion.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  let rx0 = Infinity;
  let ry0 = Infinity;
  let rx1 = -Infinity;
  let ry1 = -Infinity;
  for (const [px, py] of [
    [minx, miny],
    [maxx, miny],
    [minx, maxy],
    [maxx, maxy],
  ] as const) {
    const sx = (px - cx) * motion.scale;
    const sy = (py - cy) * motion.scale;
    const x = cx + sx * cos - sy * sin + motion.tx * outW;
    const y = cy + sx * sin + sy * cos + motion.ty * outH;
    if (x < rx0) rx0 = x;
    if (x > rx1) rx1 = x;
    if (y < ry0) ry0 = y;
    if (y > ry1) ry1 = y;
  }

  // Feather is a gaussian blur on the matte; three sigma covers >99.7% of it,
  // and the browser's own blur kernel is cut off around there too.
  const pad = mask.feather > 0 ? Math.max(0.5, mask.feather * outH * 0.5) * 3 + 2 : 1;
  const x = Math.max(0, Math.floor(rx0 - pad));
  const y = Math.max(0, Math.floor(ry0 - pad));
  return {
    x,
    y,
    w: Math.min(outW, Math.ceil(rx1 + pad)) - x,
    h: Math.min(outH, Math.ceil(ry1 + pad)) - y,
  };
}

/** Bounding-box centre (px) of a pen path — the pivot its motion turns around. */
export function maskPathCenterPx(path: BezierPoint[], outW: number, outH: number): { cx: number; cy: number } {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const p of path) {
    const x = p.x * outW;
    const y = p.y * outH;
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  }
  return { cx: (minx + maxx) / 2, cy: (miny + maxy) / 2 };
}

/** Trace a closed bezier path (pen mask) onto the current sub-path, in px. */
function traceMaskPath(ctx: OffscreenCanvasRenderingContext2D, path: BezierPoint[], outW: number, outH: number): void {
  const n = path.length;
  ctx.moveTo(path[0]!.x * outW, path[0]!.y * outH);
  for (let i = 0; i < n; i++) {
    const cur = path[i]!;
    const next = path[(i + 1) % n]!;
    // A missing handle collapses the control point onto its anchor — a straight
    // segment — so corners and curves mix on one path.
    const c1 = cur.out ?? { x: cur.x, y: cur.y };
    const c2 = next.in ?? { x: next.x, y: next.y };
    ctx.bezierCurveTo(c1.x * outW, c1.y * outH, c2.x * outW, c2.y * outH, next.x * outW, next.y * outH);
  }
  ctx.closePath();
}

/**
 * Multiply a mask into the scratch's alpha: keep inside the shape, or outside.
 * The animated `motion` (tracking or keyframes) translates, scales and rotates
 * the shape around its own centre before it is stamped, so a tracked mask
 * follows the subject.
 */
function applyMask(
  ctx: OffscreenCanvasRenderingContext2D,
  mask: ClipMask,
  outW: number,
  outH: number,
  motion: { tx: number; ty: number; scale: number; rotation: number },
): void {
  const path = mask.shape === 'path' ? mask.path : undefined;
  const { left, top, w, h, cx: boxCx, cy: boxCy } = maskBoundsPx(mask, outW, outH);
  if (path) {
    if (path.length < 2) return;
  } else if (w <= 0 || h <= 0) {
    return;
  }
  // A pen path turns around its own bounding-box centre; a box shape around its box.
  const { cx, cy } = path ? maskPathCenterPx(path, outW, outH) : { cx: boxCx, cy: boxCy };
  ctx.save();
  // destination-in keeps the destination only where the shape is opaque; the
  // inverse keeps it only where the shape is NOT. A blurred fill gives the
  // feathered edge (its partial alpha becomes the soft matte).
  ctx.globalCompositeOperation = mask.invert ? 'destination-out' : 'destination-in';
  if (mask.feather > 0) ctx.filter = `blur(${Math.max(0.5, mask.feather * outH * 0.5)}px)`;
  // Motion: translate by the frame-fraction offset, then scale/rotate about the
  // shape's centre so the drawn geometry below can stay in its authored place.
  ctx.translate(motion.tx * outW, motion.ty * outH);
  ctx.translate(cx, cy);
  ctx.rotate((motion.rotation * Math.PI) / 180);
  ctx.scale(motion.scale, motion.scale);
  ctx.translate(-cx, -cy);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  if (path) traceMaskPath(ctx, path, outW, outH);
  else if (mask.shape === 'ellipse') ctx.ellipse(boxCx, boxCy, w / 2, h / 2, 0, 0, Math.PI * 2);
  else ctx.rect(left, top, w, h);
  ctx.fill();
  ctx.restore();
}

/**
 * Draw a single clip onto the frame, dispatching by kind - the one place clip-
 * kind rendering is decided, shared by preview and export. Media clips need a
 * decoded `sample` (null skips them); text and solid clips are self-contained.
 *
 * A clip carrying a `mask` is rendered to a scratch frame first, the mask
 * multiplied into its alpha, then composited in one draw — so masking works the
 * same for footage, text, solids and shapes, and feathered edges blend over the
 * lower tracks.
 */
function dispatchClipDraw(
  ctx: Ctx2D,
  clip: Clip,
  outW: number,
  outH: number,
  timelineMs: number,
  alphaMul: number,
  xfadeInMs: number,
  sample: DrawableFrame | null,
): void {
  const scratch = clip.mask ? getMaskScratch(outW, outH) : null;
  if (clip.mask && scratch) {
    const started = span();
    const motion = resolveMaskMotion(clip.mask, timelineMs - clip.timelineStartMs);
    // Everything outside the mask ends up at alpha 0, so the clear, the draw,
    // the matte composite and the copy-back all restrict to this box. A small
    // mask on a 4K frame used to pay for the full 4K on every one of those four.
    const dirty = maskDirtyRect(clip.mask, outW, outH, motion);
    if (dirty.w <= 0 || dirty.h <= 0) {
      endSpan('mask', started);
      return;
    }
    count('maskPx', dirty.w * dirty.h);
    scratch.ctx.save();
    scratch.ctx.beginPath();
    scratch.ctx.rect(dirty.x, dirty.y, dirty.w, dirty.h);
    scratch.ctx.clip();
    scratch.ctx.clearRect(dirty.x, dirty.y, dirty.w, dirty.h);
    dispatchClipDrawRaw(scratch.ctx, clip, outW, outH, timelineMs, alphaMul, xfadeInMs, sample);
    applyMask(scratch.ctx, clip.mask, outW, outH, motion);
    scratch.ctx.restore();
    // Composited under the current ctx transform, so an in-flight transition
    // (slide/zoom) still carries the masked clip with it.
    ctx.drawImage(scratch.canvas, dirty.x, dirty.y, dirty.w, dirty.h, dirty.x, dirty.y, dirty.w, dirty.h);
    endSpan('mask', started);
    return;
  }
  dispatchClipDrawRaw(ctx, clip, outW, outH, timelineMs, alphaMul, xfadeInMs, sample);
}

function dispatchClipDrawRaw(
  ctx: Ctx2D,
  clip: Clip,
  outW: number,
  outH: number,
  timelineMs: number,
  alphaMul: number,
  xfadeInMs: number,
  sample: DrawableFrame | null,
): void {
  if (isTextClip(clip)) {
    drawTextClip(ctx, clip, outW, outH, timelineMs, alphaMul, xfadeInMs);
  } else if (clip.kind === 'solid') {
    drawSolidClip(ctx, clip, outW, outH, timelineMs, alphaMul, xfadeInMs);
  } else if (clip.kind === 'shape') {
    drawShapeClip(ctx, clip, outW, outH, timelineMs, alphaMul, xfadeInMs);
  } else if (sample) {
    drawClipSample(ctx, sample, clip, outW, outH, timelineMs, alphaMul, xfadeInMs);
  }
}

/**
 * How a non-dissolve transition renders the incoming clip at overlap progress
 * `p` (0 at the cut, 1 fully in): an alpha multiplier plus an optional edge
 * slide, reveal clip, zoom, or a full-frame colour dip drawn over the outgoing
 * clip. Pure geometry so it can be unit-tested.
 */
export interface TransitionTreatment {
  alpha: number;
  translate?: { x: number; y: number };
  scale?: number;
  clip?: { x: number; y: number; w: number; h: number };
  overlay?: { color: string; alpha: number };
}

export function transitionTreatment(
  type: TransitionType,
  p: number,
  outW: number,
  outH: number,
): TransitionTreatment {
  // The dip fades the outgoing clip into a colour (alpha peaks at the midpoint)
  // then the incoming clip fades up out of it.
  const dip = 1 - Math.abs(2 * p - 1);
  switch (type) {
    case 'dipBlack':
      return { alpha: Math.max(0, 2 * p - 1), overlay: { color: '#000', alpha: dip } };
    case 'dipWhite':
      return { alpha: Math.max(0, 2 * p - 1), overlay: { color: '#fff', alpha: dip } };
    case 'slideLeft':
      return { alpha: 1, translate: { x: (1 - p) * outW, y: 0 } };
    case 'slideRight':
      return { alpha: 1, translate: { x: -(1 - p) * outW, y: 0 } };
    case 'slideUp':
      return { alpha: 1, translate: { x: 0, y: (1 - p) * outH } };
    case 'slideDown':
      return { alpha: 1, translate: { x: 0, y: -(1 - p) * outH } };
    case 'wipe':
      return { alpha: 1, clip: { x: 0, y: 0, w: p * outW, h: outH } };
    case 'zoom':
      return { alpha: p, scale: 0.6 + 0.4 * p };
    default:
      return { alpha: p };
  }
}

/**
 * Draw a single clip, applying its entry transition over the overlap. Dissolve
 * (and any clip past its overlap) takes the plain alpha-ramp path unchanged;
 * other types wrap the draw with a slide/wipe/zoom/dip while the transition,
 * not the crossfade ramp, drives the incoming clip's visibility. The outgoing
 * clip is already on the canvas, so a dip's colour overlay covers it and a
 * slide/wipe lets it show through. Shared by preview and export.
 */
export function drawClip(
  ctx: Ctx2D,
  clip: Clip,
  outW: number,
  outH: number,
  timelineMs: number,
  alphaMul: number,
  xfadeInMs: number,
  sample: DrawableFrame | null,
): void {
  const type = clip.transition ?? 'dissolve';
  const p = xfadeInMs > 0 ? Math.max(0, Math.min(1, (timelineMs - clip.timelineStartMs) / xfadeInMs)) : 1;
  if (type === 'dissolve' || xfadeInMs <= 0 || p >= 1) {
    dispatchClipDraw(ctx, clip, outW, outH, timelineMs, alphaMul, xfadeInMs, sample);
    return;
  }

  const treat = transitionTreatment(type, p, outW, outH);
  ctx.save();
  if (treat.overlay && treat.overlay.alpha > 0) {
    ctx.globalAlpha = treat.overlay.alpha * alphaMul;
    ctx.fillStyle = treat.overlay.color;
    ctx.fillRect(0, 0, outW, outH);
    ctx.globalAlpha = 1;
  }
  if (treat.translate) ctx.translate(treat.translate.x, treat.translate.y);
  if (treat.scale && treat.scale !== 1) {
    ctx.translate(outW / 2, outH / 2);
    ctx.scale(treat.scale, treat.scale);
    ctx.translate(-outW / 2, -outH / 2);
  }
  if (treat.clip) {
    ctx.beginPath();
    ctx.rect(treat.clip.x, treat.clip.y, treat.clip.w, treat.clip.h);
    ctx.clip();
  }
  // The transition owns the incoming clip's visibility, so pass its alpha and
  // disable the crossfade ramp (xfadeInMs = 0); the clip's own fades still apply.
  dispatchClipDraw(ctx, clip, outW, outH, timelineMs, alphaMul * treat.alpha, 0, sample);
  ctx.restore();
}
