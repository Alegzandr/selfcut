import type { VideoSample } from 'mediabunny';
import { Clip, DEFAULT_TRANSFORM, clipFadeGainAt } from '../types';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Draw a clip's video sample onto the output canvas, applying crop,
 * position, scale and fade opacity. Shared by preview and export.
 */
export function drawClipSample(
  ctx: Ctx2D,
  sample: VideoSample,
  clip: Clip,
  outW: number,
  outH: number,
  timelineMs: number,
): void {
  const alpha = clipFadeGainAt(clip, timelineMs);
  if (alpha <= 0) return;

  const t = clip.transform ?? DEFAULT_TRANSFORM;
  const sw = sample.displayWidth;
  const sh = sample.displayHeight;
  const sx = t.crop.x * sw;
  const sy = t.crop.y * sh;
  const cropW = Math.max(1, t.crop.w * sw);
  const cropH = Math.max(1, t.crop.h * sh);

  // "Contain" fit of the cropped region, then user scale, centered on (x, y).
  const fit = Math.min(outW / cropW, outH / cropH) * t.scale;
  const dw = cropW * fit;
  const dh = cropH * fit;
  const dx = t.x * outW - dw / 2;
  const dy = t.y * outH - dh / 2;

  ctx.globalAlpha = alpha;
  sample.draw(ctx, sx, sy, cropW, cropH, dx, dy, dw, dh);
  ctx.globalAlpha = 1;
}

/** Among a track's clips, the one shown at time t (latest-starting clip covering t). */
export function topClipAt(clips: Clip[], tMs: number): Clip | null {
  let best: Clip | null = null;
  for (const clip of clips) {
    const dur = (clip.sourceOutMs - clip.sourceInMs) / clip.speed;
    if (tMs >= clip.timelineStartMs && tMs < clip.timelineStartMs + dur) {
      if (!best || clip.timelineStartMs >= best.timelineStartMs) best = clip;
    }
  }
  return best;
}
