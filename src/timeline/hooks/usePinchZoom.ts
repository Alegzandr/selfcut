import { type RefObject, useEffect } from 'react';
import { useStore } from '../../store/store';

/**
 * Two-finger pinch zoom + pause playback when the timeline is touched (mobile).
 */
export function usePinchZoom(
  scrollerRef: RefObject<HTMLDivElement | null>,
  coarse: boolean,
  pinching: RefObject<boolean>,
  empty: boolean,
) {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchStartDist = 0;
    let pinchStartPxPerSec = 0;

    // Coalesce the per-pointermove zoom write into one store commit per frame:
    // a pinch fires moves ~100/sec, and each setPxPerSec re-renders the whole
    // timeline. Flush the latest target once in rAF instead.
    let pendingPxPerSec = 0;
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (pendingPxPerSec > 0) useStore.getState().setPxPerSec(pendingPxPerSec);
    };

    const onDown = (e: PointerEvent) => {
      if (coarse && e.pointerType === 'touch') {
        const s = useStore.getState();
        if (s.playing) s.setPlaying(false);
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const a = pts[0]!;
        const b = pts[1]!;
        pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchStartPxPerSec = useStore.getState().pxPerSec;
        pinching.current = true;
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinchStartDist > 0) {
        const pts = [...pointers.values()];
        const a = pts[0]!;
        const b = pts[1]!;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        pendingPxPerSec = pinchStartPxPerSec * (dist / pinchStartDist);
        if (raf === 0) raf = requestAnimationFrame(flush);
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) {
        pinchStartDist = 0;
        pinching.current = false;
      }
    };

    scroller.addEventListener('pointerdown', onDown);
    scroller.addEventListener('pointermove', onMove);
    scroller.addEventListener('pointerup', onUp);
    scroller.addEventListener('pointercancel', onUp);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
      scroller.removeEventListener('pointerdown', onDown);
      scroller.removeEventListener('pointermove', onMove);
      scroller.removeEventListener('pointerup', onUp);
      scroller.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coarse, empty]);
}
