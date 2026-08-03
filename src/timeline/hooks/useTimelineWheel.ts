import { type RefObject, useEffect } from 'react';
import { useStore } from '../../store/store';

/**
 * Wheel. Desktop (Vegas-style): plain wheel pans horizontally, Ctrl/Cmd+wheel zooms
 * on the playhead (also covers trackpad pinch), Alt+wheel keeps native vertical scroll.
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
    // net zoom factor, flush once in rAF, keeping the playhead pinned to the
    // viewport offset it holds at flush time so repeated zooms stay centred on
    // it without the pointer having to chase the frame.
    let pendingFactor = 1;
    let raf = 0;
    const flush = () => {
      raf = 0;
      const state = useStore.getState();
      const pad = state.timelinePadLeft;
      const anchorMs = state.currentTimeMs;
      // Where the playhead sits inside the viewport right now; when it is
      // scrolled out of sight there is nothing to preserve, so pull it to the
      // middle and zoom around that instead.
      let viewX = anchorMs * (state.pxPerSec / 1000) + pad - scroller.scrollLeft;
      if (viewX < 0 || viewX > scroller.clientWidth) viewX = scroller.clientWidth / 2;
      state.setPxPerSec(state.pxPerSec * pendingFactor);
      pendingFactor = 1;
      const newPxPerMs = useStore.getState().pxPerSec / 1000;
      scroller.scrollLeft = anchorMs * newPxPerMs + pad - viewX;
    };

    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      if (e.ctrlKey || e.metaKey || coarse) {
        e.preventDefault();
        pendingFactor *= Math.exp(-e.deltaY * 0.0018);
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
