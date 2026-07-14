import { useStore } from '../store/store';

/**
 * Single source of truth for timeline px <-> ms conversion. Every drag, scrub,
 * drop and playhead computation goes through here so the pad offset and zoom are
 * read in exactly one place. Screen X is always relative to the
 * `[data-timeline-content]` box, whose left edge is the t=0 origin (before pad).
 */

/**
 * The scrollable content box all timeline math is relative to. Resolves from any
 * element inside it (`closest`) or one that contains it (`querySelector`).
 */
export function timelineContentEl(from: HTMLElement): HTMLElement | null {
  return (
    from.closest<HTMLElement>('[data-timeline-content]') ??
    from.querySelector<HTMLElement>('[data-timeline-content]')
  );
}

/** Timeline time (ms) under a screen X, given the content box. Not clamped. */
export function msFromContentX(content: HTMLElement, clientX: number): number {
  const s = useStore.getState();
  const left = content.getBoundingClientRect().left;
  return (clientX - left - s.timelinePadLeft) / (s.pxPerSec / 1000);
}

/**
 * Timeline time (ms) under a screen X, resolving the content box from `el`.
 * Falls back to 0 when there is no content box yet (empty timeline). Callers
 * that need a different fallback should use {@link timelineContentEl} directly.
 */
export function msFromClientX(el: HTMLElement, clientX: number): number {
  const content = timelineContentEl(el);
  return content ? msFromContentX(content, clientX) : 0;
}

/** X offset (px) within the content box for a timeline time (ms). */
export function xFromMs(ms: number): number {
  const s = useStore.getState();
  return s.timelinePadLeft + ms * (s.pxPerSec / 1000);
}
