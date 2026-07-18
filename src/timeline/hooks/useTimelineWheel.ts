import { type RefObject, useEffect } from 'react';
import { useStore } from '../../store/store';

/**
 * Wheel. Desktop (Vegas-style): plain wheel pans horizontally, Ctrl/Cmd+wheel zooms
 * at the cursor (also covers trackpad pinch), Alt+wheel keeps native vertical scroll.
 */
export function useTimelineWheel(
  scrollerRef: RefObject<HTMLDivElement | null>,
  coarse: boolean,
  empty: boolean,
) {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    // A trackpad pinch/wheel fires ~100+ events/sec; committing pxPerSec (and
    // thus re-rendering the whole timeline) on every one is the dominant zoom
    // jank. Coalesce into one store write per animation frame: accumulate the
    // net zoom factor and the latest cursor x, flush once in rAF, keeping the
    // point under the cursor pinned using the scrollLeft live at flush time.
    let pendingFactor = 1;
    let anchorClientX = 0;
    let raf = 0;
    const flush = () => {
      raf = 0;
      const state = useStore.getState();
      const rect = scroller.getBoundingClientRect();
      const pad = state.timelinePadLeft;
      const contentX = scroller.scrollLeft + anchorClientX - rect.left;
      const anchorMs = (contentX - pad) / (state.pxPerSec / 1000);
      state.setPxPerSec(state.pxPerSec * pendingFactor);
      pendingFactor = 1;
      const newPxPerMs = useStore.getState().pxPerSec / 1000;
      scroller.scrollLeft = anchorMs * newPxPerMs + pad - (anchorClientX - rect.left);
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      if (e.ctrlKey || e.metaKey || coarse) {
        e.preventDefault();
        pendingFactor *= Math.exp(-e.deltaY * 0.0018);
        anchorClientX = e.clientX;
        if (raf === 0) raf = requestAnimationFrame(flush);
      } else if (!e.altKey && !e.shiftKey) {
        e.preventDefault();
        scroller.scrollLeft += e.deltaY;
      }
    };
    scroller.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      scroller.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coarse, empty]);
}
