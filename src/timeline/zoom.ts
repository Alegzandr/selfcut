import { useStore } from '../store/store';
import { clamp } from '../lib/time';

/** Zoom keeping the playhead at the same screen position (falls back to plain zoom). */
export function zoomAtPlayhead(factor: number): void {
  setZoomAtPlayhead(useStore.getState().pxPerSec * factor);
}

/** Jump to an absolute scale, keeping the playhead where it is on screen. */
export function setZoomAtPlayhead(pxPerSec: number): void {
  const s = useStore.getState();
  const scroller = document.querySelector<HTMLElement>('.timeline-scroller');
  const oldPxMs = s.pxPerSec / 1000;
  s.setPxPerSec(pxPerSec);
  const newPxMs = useStore.getState().pxPerSec / 1000;
  if (!scroller) return;
  const pad = s.timelinePadLeft;
  const anchorView = clamp(pad + s.currentTimeMs * oldPxMs - scroller.scrollLeft, 0, scroller.clientWidth);
  scroller.scrollLeft = pad + s.currentTimeMs * newPxMs - anchorView;
}
