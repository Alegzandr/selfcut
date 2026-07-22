import { memo, useMemo } from 'react';
import { useStore } from '../store/store';
import { formatTimeShort } from '../lib/time';
import { msFromClientX } from './coords';
import { MARKER_BAR_HEIGHT_PX, RULER_HEIGHT_PX } from '../app/config';
import { useTimelineViewport } from './viewport';

const TICK_STEPS_SEC = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

interface Props {
  durationMs: number;
  pxPerMs: number;
  /** Extra ticks past the project end (0 on mobile so the scroll range stays exact). */
  overscanMs: number;
}

export const Ruler = memo(function Ruler({ durationMs, pxPerMs, overscanMs }: Props) {
  const padLeft = useStore((s) => s.timelinePadLeft);
  const viewport = useTimelineViewport();

  const stepSec = useMemo(() => {
    const pxPerSec = pxPerMs * 1000;
    return TICK_STEPS_SEC.find((s) => s * pxPerSec >= 56) ?? 600;
  }, [pxPerMs]);

  const ticks = useMemo(() => {
    const stepMs = stepSec * 1000;
    const endMs = durationMs + overscanMs;
    // Emit only the ticks whose x falls inside the visible content range: a long
    // project at a fine step is otherwise thousands of DOM nodes. Fall back to
    // the whole range until the viewport is known.
    const firstMs = viewport ? Math.max(0, Math.floor((viewport.left - padLeft) / pxPerMs / stepMs) * stepMs) : 0;
    const lastMs = viewport ? Math.min(endMs, (viewport.right - padLeft) / pxPerMs) : endMs;
    const out: number[] = [];
    for (let t = firstMs; t <= lastMs; t += stepMs) out.push(t);
    return out;
  }, [durationMs, stepSec, overscanMs, viewport, padLeft, pxPerMs]);

  const scrubTo = (e: React.PointerEvent) => {
    useStore.getState().seek(msFromClientX(e.currentTarget as HTMLElement, e.clientX));
  };

  return (
    <div
      className="sticky z-30 cursor-col-resize touch-none border-b border-zinc-800 bg-zinc-900/95"
      style={{ top: MARKER_BAR_HEIGHT_PX, height: RULER_HEIGHT_PX }}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        scrubTo(e);
      }}
      onPointerMove={(e) => {
        if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) scrubTo(e);
      }}
    >
      {ticks.map((tMs) => (
        <div
          key={tMs}
          className="absolute bottom-0 flex h-full items-start"
          style={{ left: padLeft + tMs * pxPerMs }}
        >
          <div className="h-full w-px bg-zinc-700" />
          <span className="pl-1 text-3xs leading-6 text-zinc-400">{formatTimeShort(tMs)}</span>
        </div>
      ))}
    </div>
  );
});
