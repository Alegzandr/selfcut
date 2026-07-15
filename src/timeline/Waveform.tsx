import { memo, useEffect, useRef } from 'react';
import { Clip, MediaAsset } from '../types';
import { audioTrackForClip, clipDurationMs } from '../model';

interface Props {
  asset: MediaAsset;
  clip: Clip;
  /** On-screen width of the clip in px (canvas resolution is capped, CSS stretches). */
  widthPx: number;
  /** CSS color of the bars. */
  color: string;
}

/** Waveform of the clip's source window [sourceInMs, sourceOutMs], mirrored around the center. */
export const Waveform = memo(function Waveform({ asset, clip, widthPx, color }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The clip's own source audio track (a multi-track video's clips each draw a
  // different track's waveform).
  const peaks = audioTrackForClip(asset, clip)?.peaks;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks?.length) return;
    // Full-resolution canvas (one bar per screen pixel) - a CSS-stretched
    // low-res canvas reads as a blurry blob, not a waveform.
    const w = Math.max(16, Math.min(30000, Math.round(widthPx)));
    const h = 64;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color;
    const spanMs = clip.sourceOutMs - clip.sourceInMs;
    const durMs = clipDurationMs(clip);
    for (let x = 0; x < w; x++) {
      // Same progress fraction drives the source sample (peaks) and the clip-local
      // time (fade envelope) - the clip's on-screen width *is* its timeline duration.
      // Everything here is independent of timelineStartMs, so moving a clip
      // along the timeline never triggers a repaint.
      const t = (x + 0.5) / w;
      const srcMs = clip.sourceInMs + t * spanMs;
      const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor((srcMs / asset.durationMs) * peaks.length)));
      const localMs = t * durMs;
      let fade = 1;
      if (clip.fadeInMs > 0) fade = Math.min(fade, localMs / clip.fadeInMs);
      if (clip.fadeOutMs > 0) fade = Math.min(fade, (durMs - localMs) / clip.fadeOutMs);
      const gain = clip.volume * Math.max(0, Math.min(1, fade));
      const bar = Math.max(2, peaks[idx]! * gain * h);
      ctx.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [
    peaks,
    clip.sourceInMs,
    clip.sourceOutMs,
    clip.volume,
    clip.fadeInMs,
    clip.fadeOutMs,
    clip.speed,
    widthPx,
    color,
    asset.durationMs,
  ]);

  if (!peaks?.length) return null;
  return <canvas ref={canvasRef} className="h-full w-full" />;
});
