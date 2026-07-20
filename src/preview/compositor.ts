import { Clip, ClipShape, ClipText, ShapeClip, SolidClip, TextClip, Track } from '../types';
import {
  DEFAULT_TEXT_WIDTH_FRAC,
  DEFAULT_TRANSFORM,
  clipEnvelopeGainAt,
  clipZoomAt,
  isTextClip,
  trackCrossfades,
} from '../model';
import { fontStack } from '../lib/fonts';
import type { DrawableFrame } from '../media/stillImage';

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
 * and the clip transform (crop → "contain" fit → user scale, centered on x/y).
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
  const t = clip.transform ?? DEFAULT_TRANSFORM;
  const zoom = timelineMs !== undefined ? clipZoomAt(clip, timelineMs) : 1;
  const cropW = Math.max(1, t.crop.w * srcW);
  const cropH = Math.max(1, t.crop.h * srcH);
  const fit = Math.min(outW / cropW, outH / cropH) * t.scale * zoom;
  const dw = cropW * fit;
  const dh = cropH * fit;
  return { dx: t.x * outW - dw / 2, dy: t.y * outH - dh / 2, dw, dh };
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
  const alpha = clipEnvelopeGainAt(clip, timelineMs, xfadeInMs, 0) * alphaMul;
  if (alpha <= 0) return;

  const t = clip.transform ?? DEFAULT_TRANSFORM;
  const sw = sample.displayWidth;
  const sh = sample.displayHeight;
  const sx = t.crop.x * sw;
  const sy = t.crop.y * sh;
  const cropW = Math.max(1, t.crop.w * sw);
  const cropH = Math.max(1, t.crop.h * sh);
  const { dx, dy, dw, dh } = clipDestRect(clip, sw, sh, outW, outH, timelineMs);

  ctx.globalAlpha = alpha;
  withRotation(ctx, t.rotation ?? 0, dx + dw / 2, dy + dh / 2, () =>
    sample.draw(ctx, sx, sy, cropW, cropH, dx, dy, dw, dh),
  );
  ctx.globalAlpha = 1;
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
  const alpha = clipEnvelopeGainAt(clip, timelineMs, xfadeInMs, 0) * alphaMul;
  if (alpha <= 0) return;

  const t = clip.transform ?? DEFAULT_TRANSFORM;
  const { font, px } = textFont(text, outH, t.scale);

  ctx.save();
  ctx.globalAlpha = alpha;
  // Rotates the caption block as a whole, inside the save/restore already here.
  // Around the transform centre, not the text baseline, so a rotated caption
  // stays where it was placed.
  applyRotation(ctx, t.rotation ?? 0, t.x * outW, t.y * outH);
  // Set before laying out: wrapping measures against this exact font.
  ctx.font = font;
  const lines = layoutTextLines(ctx, text, outW);
  const lineHeight = px * 1.2;
  ctx.textAlign = text.align ?? 'center';
  ctx.textBaseline = 'middle';
  const anchorX = textAnchorX(text, t.x, outW);
  const cy = t.y * outH;
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
  const alpha = clipEnvelopeGainAt(clip, timelineMs, xfadeInMs, 0) * alphaMul;
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
export function shapeClipRect(clip: ShapeClip, outW: number, outH: number): DestRect {
  const t = clip.transform ?? DEFAULT_TRANSFORM;
  const dw = clip.shape.w * outW * t.scale;
  const dh = clip.shape.h * outH * t.scale;
  return { dx: t.x * outW - dw / 2, dy: t.y * outH - dh / 2, dw, dh };
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
  const alpha = clipEnvelopeGainAt(clip, timelineMs, xfadeInMs, 0) * alphaMul;
  if (alpha <= 0) return;
  const rect = shapeClipRect(clip, outW, outH);
  if (rect.dw <= 0 || rect.dh <= 0) return;

  const shape = clip.shape;
  ctx.save();
  ctx.globalAlpha = alpha;
  applyRotation(ctx, clipRotation(clip), rect.dx + rect.dw / 2, rect.dy + rect.dh / 2);
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
export function textClipRect(clip: TextClip, outW: number, outH: number): DestRect {
  const text = clip.text;
  const t = clip.transform ?? DEFAULT_TRANSFORM;
  if (!text.content) return { dx: t.x * outW, dy: t.y * outH, dw: 0, dh: 0 };
  if (!measureCtx) {
    measureCtx =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1).getContext('2d')
        : (document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D);
  }
  const { font, px } = textFont(text, outH, t.scale);
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
  return { dx: lineLeft(text.align, textAnchorX(text, t.x, outW), dw), dy: t.y * outH - dh / 2, dw, dh };
}

/**
 * Clips of a track visible at time t, in draw order (earliest start first -
 * the later clip composites over the earlier one during a crossfade).
 * A legal layout has at most two (pairwise overlaps only).
 */
export function clipsAt(clips: Clip[], tMs: number): Clip[] {
  const visible: Clip[] = [];
  for (const clip of clips) {
    const dur = (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
    if (tMs >= clip.timelineStartMs && tMs < clip.timelineStartMs + dur) visible.push(clip);
  }
  return visible.sort((a, b) => a.timelineStartMs - b.timelineStartMs);
}

/** A clip visible at a given time, paired with its crossfade ramp-in duration. */
export interface VisibleClip {
  clip: Clip;
  xfadeInMs: number;
}

/**
 * Visible clips of a video track at time t, each with its crossfade ramp-in, in
 * draw order. Empty for non-video, hidden or empty tracks. Preview and export
 * both iterate this, so they composite tracks identically.
 */
export function visibleVideoClips(track: Track, tMs: number): VisibleClip[] {
  if (track.kind !== 'video' || track.hidden) return [];
  const visible = clipsAt(track.clips, tMs);
  if (visible.length === 0) return [];
  const xfades = trackCrossfades(track.clips);
  return visible.map((clip) => ({ clip, xfadeInMs: xfades.get(clip.id)?.inMs ?? 0 }));
}

/**
 * Draw a single clip onto the frame, dispatching by kind - the one place clip-
 * kind rendering is decided, shared by preview and export. Media clips need a
 * decoded `sample` (null skips them); text and solid clips are self-contained.
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
