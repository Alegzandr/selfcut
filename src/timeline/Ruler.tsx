import { memo, useMemo } from 'react';
import { useStore } from '../store/store';
import { formatTimeShort } from '../lib/time';
import { TIMELINE_PAD_LEFT } from '../app/config';

const TICK_STEPS_SEC = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

interface Props {
  durationMs: number;
  pxPerMs: number;
}

export const Ruler = memo(function Ruler({ durationMs, pxPerMs }: Props) {
  const stepSec = useMemo(() => {
    const pxPerSec = pxPerMs * 1000;
    return TICK_STEPS_SEC.find((s) => s * pxPerSec >= 56) ?? 600;
  }, [pxPerMs]);

  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t <= durationMs + 30_000; t += stepSec * 1000) out.push(t);
    return out;
  }, [durationMs, stepSec]);

  const scrubTo = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const tMs = (e.clientX - rect.left - TIMELINE_PAD_LEFT) / pxPerMs;
    useStore.getState().seek(tMs);
  };

  return (
    <div
      className="sticky top-0 z-20 h-6 cursor-col-resize touch-none border-b border-zinc-800 bg-zinc-900/95"
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
          style={{ left: TIMELINE_PAD_LEFT + tMs * pxPerMs }}
        >
          <div className="h-full w-px bg-zinc-700" />
          <span className="pl-1 text-[9px] leading-6 text-zinc-500">{formatTimeShort(tMs)}</span>
        </div>
      ))}
    </div>
  );
});
