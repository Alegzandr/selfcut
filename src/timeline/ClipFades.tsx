import { Clip } from '../types';
import { CLIP_COLORS } from '../lib/palette';

/**
 * Fade and crossfade visuals for a clip: pure, pointer-transparent overlays.
 * The interactive fade handles stay in ClipView - this module only draws.
 */
export function ClipFades({
  clip,
  width,
  pxPerMs,
  xfadeInMs,
  xfadeOutMs,
}: {
  clip: Clip;
  width: number;
  pxPerMs: number;
  xfadeInMs: number;
  xfadeOutMs: number;
}) {
  return (
    <>
      {/* Fade ramps: the dark wedge (fade from/to black) plus the classic-NLE
          ramp line drawn corner-to-top, so the fade is legible at a glance. */}
      {clip.fadeInMs > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-black/70 to-transparent"
          style={{ width: clip.fadeInMs * pxPerMs }}
        />
      )}
      {clip.fadeOutMs > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-black/70 to-transparent"
          style={{ width: clip.fadeOutMs * pxPerMs }}
        />
      )}
      {(clip.fadeInMs > 0 || clip.fadeOutMs > 0) && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${width} 100`}
          preserveAspectRatio="none"
        >
          {clip.fadeInMs > 0 && (
            <line
              x1={0}
              y1={100}
              x2={clip.fadeInMs * pxPerMs}
              y2={0}
              stroke={CLIP_COLORS.fadeRamp}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {clip.fadeOutMs > 0 && (
            <line
              x1={width - clip.fadeOutMs * pxPerMs}
              y1={0}
              x2={width}
              y2={100}
              stroke={CLIP_COLORS.fadeRamp}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      )}

      {/* Crossfade with a neighbor: the overlap window, marked with the ramp of
          this clip's edge (incoming rises, outgoing falls) — the two neighbors'
          ramps together read as the classic crossfade "X". */}
      {xfadeInMs > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 border-r border-sky-300/50 bg-sky-300/10"
          style={{ width: xfadeInMs * pxPerMs }}
        >
          <svg className="h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <line
              x1={0}
              y1={100}
              x2={100}
              y2={0}
              stroke={CLIP_COLORS.crossfadeRamp}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      )}
      {xfadeOutMs > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 border-l border-sky-300/50 bg-sky-300/10"
          style={{ width: xfadeOutMs * pxPerMs }}
        >
          <svg className="h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <line
              x1={0}
              y1={0}
              x2={100}
              y2={100}
              stroke={CLIP_COLORS.crossfadeRamp}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      )}
    </>
  );
}
