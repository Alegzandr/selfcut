import type { VideoSample } from 'mediabunny';
import { Clip, ClipText, DEFAULT_TRANSFORM, clipEnvelopeGainAt, clipZoomAt } from '../types';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface DestRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
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
  sample: VideoSample,
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
  sample.draw(ctx, sx, sy, cropW, cropH, dx, dy, dw, dh);
  ctx.globalAlpha = 1;
}

/** Font shorthand for a text clip at a given output height and clip scale. */
function textFont(text: ClipText, outH: number, scale: number): { font: string; px: number } {
  const px = Math.max(1, text.sizeFrac * outH * scale);
  return { font: `${text.bold ? '700' : '400'} ${px}px system-ui, -apple-system, sans-serif`, px };
}

/**
 * Draw a generated text clip. Same fade/crossfade semantics as media clips,
 * position and scale come from the clip transform (crop is ignored).
 */
export function drawTextClip(
  ctx: Ctx2D,
  clip: Clip,
  outW: number,
  outH: number,
  timelineMs: number,
  alphaMul = 1,
  xfadeInMs = 0,
): void {
  const text = clip.text;
  if (!text || !text.content) return;
  const alpha = clipEnvelopeGainAt(clip, timelineMs, xfadeInMs, 0) * alphaMul;
  if (alpha <= 0) return;

  const t = clip.transform ?? DEFAULT_TRANSFORM;
  const { font, px } = textFont(text, outH, t.scale);
  const lines = text.content.split('\n');
  const lineHeight = px * 1.2;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = t.x * outW;
  const cy = t.y * outH;
  const lineY = (i: number) => cy + (i - (lines.length - 1) / 2) * lineHeight;

  // Caption pill: rounded dark panel behind each line.
  if (text.background) {
    const padX = px * 0.35;
    const padY = px * 0.14;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]) continue;
      const w = ctx.measureText(lines[i]).width;
      const y = lineY(i);
      ctx.beginPath();
      ctx.roundRect(cx - w / 2 - padX, y - px / 2 - padY, w + padX * 2, px + padY * 2, px * 0.25);
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
      ctx.strokeText(lines[i], cx, lineY(i));
    }
  }

  ctx.fillStyle = text.color;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], cx, lineY(i));
  }
  ctx.restore();
}

/** Draw a generated full-frame colour or linear gradient. */
export function drawSolidClip(
  ctx: Ctx2D,
  clip: Clip,
  outW: number,
  outH: number,
  timelineMs: number,
  alphaMul = 1,
  xfadeInMs = 0,
): void {
  const solid = clip.solid;
  if (!solid) return;
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

let measureCtx: Ctx2D | null = null;

/**
 * Bounding box of a text clip in output coordinates (hit-testing and the
 * preview selection overlay). Uses a shared 1×1 measuring context.
 */
export function textClipRect(clip: Clip, outW: number, outH: number): DestRect {
  const text = clip.text;
  const t = clip.transform ?? DEFAULT_TRANSFORM;
  if (!text || !text.content) return { dx: t.x * outW, dy: t.y * outH, dw: 0, dh: 0 };
  if (!measureCtx) {
    measureCtx =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1).getContext('2d')
        : (document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D);
  }
  const { font, px } = textFont(text, outH, t.scale);
  const lines = text.content.split('\n');
  measureCtx!.font = font;
  let dw = 0;
  for (const line of lines) dw = Math.max(dw, measureCtx!.measureText(line).width);
  let dh = lines.length * px * 1.2;
  if (text.background) {
    dw += px * 0.7;
    dh += px * 0.28;
  }
  return { dx: t.x * outW - dw / 2, dy: t.y * outH - dh / 2, dw, dh };
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
