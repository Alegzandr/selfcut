import { useEffect, useRef, useState } from 'react';
import { DRAG_TICK_MS, createFileDragTracker, type FileDragTracker } from './fileDragTracker';

/** Internal drags (library asset, catalogue entry) must not raise the overlay. */
function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer?.types.includes('Files') ?? false;
}

/**
 * True while files from outside the browser hover the window.
 *
 * Listening on the window rather than on a container is what makes the overlay
 * close reliably: a drag that leaves through a nested element - which is every
 * drag, once the editor is populated - fires its `dragleave` on that element,
 * never on the container, so a container-level handler would leave the overlay
 * painted over an app that stays perfectly clickable underneath.
 */
export function useFileDragOverlay(): boolean {
  const [dragging, setDragging] = useState(false);
  const tracker = useRef<FileDragTracker | null>(null);

  useEffect(() => {
    const t = createFileDragTracker(setDragging);
    tracker.current = t;
    const now = () => performance.now();
    const onEnter = (e: DragEvent) => {
      if (hasFiles(e)) t.enter(now());
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) t.over(now());
    };
    const onLeave = (e: DragEvent) => {
      if (hasFiles(e)) t.leave(now());
    };
    const onEnd = () => t.end();
    // Capture phase: a drop the timeline claims stops propagation, and a bubble
    // listener out here would never see it.
    const capture = { capture: true } as const;
    window.addEventListener('dragenter', onEnter, capture);
    window.addEventListener('dragover', onOver, capture);
    window.addEventListener('dragleave', onLeave, capture);
    window.addEventListener('drop', onEnd, capture);
    window.addEventListener('dragend', onEnd, capture);
    return () => {
      window.removeEventListener('dragenter', onEnter, capture);
      window.removeEventListener('dragover', onOver, capture);
      window.removeEventListener('dragleave', onLeave, capture);
      window.removeEventListener('drop', onEnd, capture);
      window.removeEventListener('dragend', onEnd, capture);
      t.end();
      tracker.current = null;
    };
  }, []);

  // The timer only has work to do while something is showing, so it only runs
  // then - an idle editor keeps no interval alive.
  useEffect(() => {
    if (!dragging) return;
    const id = setInterval(() => tracker.current?.tick(performance.now()), DRAG_TICK_MS);
    return () => clearInterval(id);
  }, [dragging]);

  return dragging;
}
