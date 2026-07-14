import { RefObject, useEffect, useRef } from 'react';
import { useStore } from '../store/store';
import { msFromClientX } from './coords';

interface Props {
  scrollerRef: RefObject<HTMLDivElement | null>;
}

/**
 * Desktop playhead: positioned at the current time, draggable, paged into view
 * while playing. Positioned via a direct DOM transform from a store
 * subscription - at 60 updates/sec during playback, going through React
 * reconciliation (and a layout-invalidating `left`) is pure overhead.
 */
export function Playhead({ scrollerRef }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    let lastX = -1;
    const apply = () => {
      const s = useStore.getState();
      const x = s.timelinePadLeft + s.currentTimeMs * (s.pxPerSec / 1000);
      if (x !== lastX) {
        lastX = x;
        el.style.transform = `translateX(${x}px)`;
      }
      // Keep the playhead in view while playing.
      const scroller = scrollerRef.current;
      if (s.playing && scroller) {
        const margin = 48;
        if (x > scroller.scrollLeft + scroller.clientWidth - margin) {
          scroller.scrollLeft = x - margin;
        } else if (x < scroller.scrollLeft + s.timelinePadLeft) {
          scroller.scrollLeft = Math.max(0, x - s.timelinePadLeft);
        }
      }
    };
    apply();
    return useStore.subscribe((s, prev) => {
      if (
        s.currentTimeMs !== prev.currentTimeMs ||
        s.pxPerSec !== prev.pxPerSec ||
        s.timelinePadLeft !== prev.timelinePadLeft ||
        s.playing !== prev.playing
      ) {
        apply();
      }
    });
  }, [scrollerRef]);

  const onPointerMove = (e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return;
    useStore.getState().seek(msFromClientX(e.currentTarget as HTMLElement, e.clientX));
  };

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-y-0 left-0 z-30 will-change-transform">
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
