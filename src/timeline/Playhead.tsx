import { RefObject, useEffect } from 'react';
import { useStore } from '../store/store';

interface Props {
  scrollerRef: RefObject<HTMLDivElement | null>;
}

/** Desktop playhead: positioned at the current time, draggable, paged into view while playing. */
export function Playhead({ scrollerRef }: Props) {
  const currentTimeMs = useStore((s) => s.currentTimeMs);
  const playing = useStore((s) => s.playing);
  const padLeft = useStore((s) => s.timelinePadLeft);
  const pxPerMs = useStore((s) => s.pxPerSec) / 1000;
  const x = padLeft + currentTimeMs * pxPerMs;

  // Keep the playhead in view while playing.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!playing || !scroller) return;
    const margin = 48;
    if (x > scroller.scrollLeft + scroller.clientWidth - margin) {
      scroller.scrollLeft = x - margin;
    } else if (x < scroller.scrollLeft + padLeft) {
      scroller.scrollLeft = Math.max(0, x - padLeft);
    }
  }, [x, playing, padLeft, scrollerRef]);

  const onPointerMove = (e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    const content = (e.currentTarget as HTMLElement).closest('[data-timeline-content]') as HTMLElement;
    const rect = content.getBoundingClientRect();
    useStore.getState().seek((e.clientX - rect.left - padLeft) / pxPerMs);
  };

  return (
    <div
      className="pointer-events-none absolute inset-y-0 z-30"
      style={{ left: x }}
    >
      <div className="absolute inset-y-0 -ml-px w-0.5 bg-red-500" />
      <div
        className="pointer-events-auto absolute -left-2 top-0 h-5 w-4 cursor-col-resize touch-none rounded-b-md bg-red-500"
        onPointerDown={(e) => {
          e.stopPropagation();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={onPointerMove}
      />
    </div>
  );
}
