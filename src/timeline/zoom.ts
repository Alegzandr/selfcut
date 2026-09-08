import { useStore, projectDurationMs } from '../store/store';
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

/**
 * Fit the whole cut in the viewport (Shift+Z in every NLE): the scale that
 * shows t=0 to the project end with a little air, and the scroller back at
 * the origin so the fit is actually what is on screen.
 */
export function zoomToFit(): void {
  const s = useStore.getState();
  const scroller = document.querySelector<HTMLElement>('.timeline-scroller');
  if (!scroller) return;
  const durationMs = projectDurationMs(s.project);
  if (durationMs <= 0) return;
  // The pad is the mobile half-width on a coarse pointer (the fixed centre
  // playhead needs the room on both sides), 0 on desktop; the fit is measured
  // between the pads on desktop and against the whole viewport on touch, where
  // the content can only ever be seen half a screen at a time.
  const pad = s.timelinePadLeft;
  const available = pad > 0 ? scroller.clientWidth : Math.max(120, scroller.clientWidth - 32);
  s.setPxPerSec((available / durationMs) * 1000);
  scroller.scrollLeft = 0;
}
