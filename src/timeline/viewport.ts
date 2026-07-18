import { useEffect, useState } from 'react';

/**
 * Visible slice of the timeline, in scroller *content* coordinates (px). The
 * ruler, filmstrips and waveforms subscribe to it so each renders only what is
 * on screen - the DOM node count and the per-pixel canvas work then stay bounded
 * to the viewport, no matter how long the project is or how deep the zoom.
 *
 * A tiny emitter (not the store) keeps this off the edit/playback commit path:
 * scrolling publishes here and only the virtualized leaves react, never the
 * whole timeline tree.
 */
export interface ContentRange {
  left: number;
  right: number;
}

let current: ContentRange | null = null;
const listeners = new Set<(r: ContentRange) => void>();

/** The timeline reports its visible content range here on scroll / resize / zoom. */
export function publishViewport(r: ContentRange): void {
  current = r;
  for (const fn of listeners) fn(r);
}

export function getViewport(): ContentRange | null {
  return current;
}

export function subscribeViewport(fn: (r: ContentRange) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function quantize(r: ContentRange | null, margin: number): ContentRange | null {
  if (!r) return null;
  // Pad by a margin and snap to a margin-sized grid, so the window only changes
  // when the user scrolls past a bucket - not on every pixel, and not on every
  // frame of the mobile playback auto-scroll. Small scrolls stay within the
  // padded window and trigger no re-render.
  return {
    left: Math.floor((r.left - margin) / margin) * margin,
    right: Math.ceil((r.right + margin) / margin) * margin,
  };
}

/**
 * The padded, bucket-snapped visible content range. Returns null until the
 * timeline has reported one, in which case callers should render everything
 * (identical to the pre-virtualization behavior - a safe fallback).
 */
export function useTimelineViewport(margin = 900): ContentRange | null {
  const [win, setWin] = useState<ContentRange | null>(() => quantize(getViewport(), margin));
  useEffect(() => {
    const apply = (r: ContentRange) =>
      setWin((prev) => {
        const q = quantize(r, margin)!;
        // Bail (keep the same reference) when the bucket is unchanged, so scroll
        // spam and per-frame auto-scroll don't re-render the leaf.
        return prev && prev.left === q.left && prev.right === q.right ? prev : q;
      });
    const cur = getViewport();
    if (cur) apply(cur);
    return subscribeViewport(apply);
  }, [margin]);
  return win;
}
