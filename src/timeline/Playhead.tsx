import { RefObject, useEffect, useRef } from 'react';
import { useStore } from '../store/store';
import { msFromClientX } from './coords';
import { MARKER_BAR_HEIGHT_PX, RULER_HEIGHT_PX } from '../app/config';
import { trackRowHeightPx } from './trackHeight';

const HEAD_HEIGHT_PX = MARKER_BAR_HEIGHT_PX + RULER_HEIGHT_PX;

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
  const headBarRef = useRef<HTMLDivElement>(null);
  const trackBarRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  // Sum of the per-track row heights: an expanded track adds its keyframe lanes
  // to the base, so the playhead's track bar has to grow with it or stop short.
  const totalHeight = useStore((s) => {
    const expanded = new Set(s.expandedTrackIds);
    let h = 0;
    for (const t of s.project.tracks) h += trackRowHeightPx(s.trackHeightPx, expanded.has(t.id));
    return h;
  });

  useEffect(() => {
    const parts = [headBarRef.current, trackBarRef.current, handleRef.current];
    if (parts.some((p) => !p)) return;
    let lastX = -1;
    const apply = () => {
      const s = useStore.getState();
      const x = s.timelinePadLeft + s.currentTimeMs * (s.pxPerSec / 1000);
      if (x !== lastX) {
        lastX = x;
        for (const p of parts) p!.style.transform = `translateX(${x}px)`;
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

  // The playhead is three siblings rather than one transformed wrapper: a
  // wrapper with a transform would create a stacking context, forcing them to
  // share a single z-index. They each need a different layer:
  //  - head bar: *over* the marker bar / ruler (z-30), so the line reads as
  //    continuous from the handle down to the tracks;
  //  - track bar: *under* the sticky track headers (z-20), and stopping at the
  //    last track so it does not bleed into the "add track" row below;
  //  - handle: above everything.
  const bar = 'pointer-events-none absolute -ml-px left-0 w-0.5 bg-red-500 will-change-transform';
  return (
    <>
      <div ref={headBarRef} className={`${bar} top-0 z-30`} style={{ height: HEAD_HEIGHT_PX }} />
      <div
        ref={trackBarRef}
        className={`${bar} z-10`}
        style={{ top: HEAD_HEIGHT_PX, height: totalHeight }}
      />
      <div
        ref={handleRef}
        className="absolute -ml-2 left-0 top-0 z-40 h-5 w-4 cursor-col-resize touch-none rounded-b-md bg-red-500 will-change-transform"
        onPointerDown={(e) => {
          e.stopPropagation();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={onPointerMove}
      />
    </>
  );
}
