import { memo, useMemo } from 'react';
import { useStore, getTimelineFps } from '../store/store';
import { formatClock, formatTimePrecise, formatTimeShort } from '../lib/time';
import { MARKER_BAR_HEIGHT_PX, RULER_HEIGHT_PX } from '../app/config';
import { useTimelineViewport } from './viewport';
import { useScrub } from './hooks/useScrub';

/** Coarse steps, in seconds: everything from one second up. */
const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
/** Fine steps, in frames of the timeline rate: what a zoomed-in ruler counts in. */
const FRAME_STEPS = [1, 2, 5, 10, 15, 30];
/** Minimum spacing between two labelled ticks, so the labels never collide. */
const MIN_TICK_PX = 56;

interface Props {
  durationMs: number;
  pxPerMs: number;
  /** Extra ticks past the project end (0 on mobile so the scroll range stays exact). */
  overscanMs: number;
}

/**
 * A tick step: its length and whether it is a frame count (labelled with
 * frames, or milliseconds in decimal mode) or a round number of seconds.
 */
interface Step {
  ms: number;
  frames: boolean;
}

/**
 * The tick step for a zoom level. Sub-second steps are counted in FRAMES of
 * the timeline rate rather than in tenths of a second: zoomed in on a cut, a
 * monteur reads "0:02:12" and knows it is twelve frames in, where "0:02.4"
 * says nothing a razor can use - and the old ruler, which had no sub-second
 * label at all, read "0:02 0:02 0:02" across the whole screen.
 */
function stepFor(pxPerMs: number, fps: number): Step {
  const frameMs = 1000 / fps;
  for (const frames of FRAME_STEPS) {
    // A frame step that already spans a second or more is a second step.
    if (frames * frameMs >= 1000) break;
    if (frames * frameMs * pxPerMs >= MIN_TICK_PX) return { ms: frames * frameMs, frames: true };
  }
  const sec = SECOND_STEPS.find((s) => s * 1000 * pxPerMs >= MIN_TICK_PX) ?? 600;
  return { ms: sec * 1000, frames: false };
}

export const Ruler = memo(function Ruler({ durationMs, pxPerMs, overscanMs }: Props) {
  const padLeft = useStore((s) => s.timelinePadLeft);
  const fps = useStore(getTimelineFps);
  const timeFormat = useStore((s) => s.timeFormat);
  const viewport = useTimelineViewport();

  const step = useMemo(() => stepFor(pxPerMs, fps), [pxPerMs, fps]);

  const ticks = useMemo(() => {
    const stepMs = step.ms;
    const endMs = durationMs + overscanMs;
    // Emit only the ticks whose x falls inside the visible content range: a long
    // project at a fine step is otherwise thousands of DOM nodes. Fall back to
    // the whole range until the viewport is known.
    const firstMs = viewport ? Math.max(0, Math.floor((viewport.left - padLeft) / pxPerMs / stepMs) * stepMs) : 0;
    const lastMs = viewport ? Math.min(endMs, (viewport.right - padLeft) / pxPerMs) : endMs;
    const out: number[] = [];
    // Counted in steps rather than accumulated, so a frame step (16.666…ms)
    // never drifts off the frame grid over a long project.
    const first = Math.round(firstMs / stepMs);
    for (let i = first; i * stepMs <= lastMs; i++) out.push(i * stepMs);
    return out;
  }, [durationMs, step, overscanMs, viewport, padLeft, pxPerMs]);

  /**
   * Label per tick. Second steps read as the plain "m:ss" the ruler always
   * had; frame steps carry the frame count in the transport's own format, so
   * the ruler and the readout above it spell the same instant the same way.
   */
  const label = (tMs: number): string => {
    if (!step.frames) return formatTimeShort(tMs);
    if (timeFormat === 'decimal') return formatTimePrecise(tMs);
    // The rounding keeps a tick born of 16.666…ms arithmetic on its frame.
    return formatClock(tMs + 0.01, fps, 'timecode');
  };

  // A press anywhere on the ruler is a seek, so the scrub starts on the way down.
  const scrub = useScrub({ seekOnDown: true });

  return (
    <div
      // select-none: without it a mouse drag across the ruler highlights the
      // tick labels, and the scrub ends up dragging a text selection with it.
      className="sticky z-30 cursor-col-resize touch-none select-none border-b border-zinc-800 bg-zinc-900/95"
      style={{ top: MARKER_BAR_HEIGHT_PX, height: RULER_HEIGHT_PX }}
      {...scrub}
    >
      {ticks.map((tMs) => {
        // On a frame step, whole seconds keep the tall tick and the bright
        // label, so the second grid still reads through the frame grid.
        const onSecond = step.frames && Math.abs(tMs / 1000 - Math.round(tMs / 1000)) < 1e-6;
        return (
          <div
            key={Math.round(tMs * 1000)}
            className="absolute bottom-0 flex h-full items-start"
            style={{ left: padLeft + tMs * pxPerMs }}
          >
            <div className={`w-px ${onSecond || !step.frames ? 'h-full bg-zinc-700' : 'mt-3 h-3 bg-zinc-800'}`} />
            <span
              className={`pl-1 text-3xs leading-6 tabular-nums ${onSecond || !step.frames ? 'text-zinc-400' : 'text-zinc-500'}`}
            >
              {label(tMs)}
            </span>
          </div>
        );
      })}
    </div>
  );
});
