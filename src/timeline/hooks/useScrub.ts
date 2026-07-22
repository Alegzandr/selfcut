/**
 * The scrub gesture: dragging the playhead from the ruler or from its handle.
 *
 * Scrubbing was the one timeline drag that never got the treatment its
 * neighbours have, so it lives here now and both surfaces share it - magnetism
 * with a guide line, edge autoscroll, Escape cancel, and a full down/move/up
 * /cancel triad.
 *
 * It also stops the transport on the way in. Every `seek` bumps `seekVersion`,
 * which makes the engine tear down and reschedule the whole audio graph; doing
 * that on each pointermove stutters the audio and leaves playback racing away
 * from the pointer. Pausing is what the mobile scroll-scrub and the clip-click
 * seek already do, and what a monteur expects coming from Premiere or CapCut.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { useStore } from '../../store/store';
import { msFromContentX, timelineContentEl } from '../coords';
import { collectSnapPoints, snapTime } from '../snapping';
import { hapticOnSnap, type SnapHapticState } from '../../lib/haptics';
import { PROJECT_FPS, SNAP_THRESHOLD_PX } from '../../app/config';

const FRAME_MS = 1000 / PROJECT_FPS;
/** Distance from the scroller edge where autoscroll kicks in, and its per-frame cap. */
const EDGE_PX = 40;
const MAX_SCROLL_STEP_PX = 24;

interface ScrubState {
  pointerId: number;
  el: HTMLElement;
  content: HTMLElement;
  scroller: HTMLElement | null;
  /** Time before the gesture, restored when Escape cancels it. */
  startMs: number;
  /** Snap targets, captured once at press: they must not shift mid-drag. */
  points: number[];
  lastPointerX: number;
  lastSnap: number | null;
}

interface Options {
  /**
   * Whether pressing already moves the playhead. True on the ruler (a click
   * anywhere is a seek), false on the handle (grabbing it must not nudge it).
   */
  seekOnDown: boolean;
}

/** Snap targets for a seek, minus the one the playhead already occupies. */
function seekSnapPoints(fromMs: number): number[] {
  const s = useStore.getState();
  return collectSnapPoints(s.project, [], fromMs, s.loopRegion).filter(
    (p) => Math.abs(p - fromMs) > 0.5,
  );
}

/**
 * The single rule for "where a pointer at `clientX` puts the playhead".
 * Magnetism follows the timeline-wide convention - the `snapEnabled` toggle,
 * inverted while Shift is held - and lands on the exact snap point. Free of a
 * snap, the time is quantized to a frame: that is the granularity the preview
 * shows anyway, so a sub-frame float is jitter with no payoff.
 */
function seekTimeAt(
  content: HTMLElement,
  clientX: number,
  shiftKey: boolean,
  points: number[],
  haptics: SnapHapticState,
): number {
  const state = useStore.getState();
  const raw = Math.max(0, msFromContentX(content, clientX));
  const snapActive = shiftKey ? !state.snapEnabled : state.snapEnabled;
  const thresholdMs = snapActive ? SNAP_THRESHOLD_PX / (state.pxPerSec / 1000) : 0;
  const snapped = hapticOnSnap(raw, snapTime(raw, points, thresholdMs), haptics);
  return snapped === raw ? Math.round(raw / FRAME_MS) * FRAME_MS : snapped;
}

/**
 * A one-shot positioning click - the empty timeline background - held to the
 * same rule as a drag on the ruler. Clicking below the ruler and clicking on it
 * mean the same thing, so they must not land on different frames.
 */
export function seekAtClientX(el: HTMLElement, clientX: number, shiftKey: boolean): void {
  const content = timelineContentEl(el);
  if (!content) return;
  const state = useStore.getState();
  if (state.playing) state.setPlaying(false);
  state.seek(
    seekTimeAt(content, clientX, shiftKey, seekSnapPoints(state.currentTimeMs), { lastSnap: null }),
  );
}

export function useScrub({ seekOnDown }: Options) {
  const scrub = useRef<ScrubState | null>(null);
  const rafRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const end = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    scrub.current = null;
  };

  useEffect(() => () => end(), []);

  /**
   * One scrub step. No snap guide here, unlike the clip drag: that line marks a
   * target the moving edge is aligning *to*, and a scrub lands the playhead
   * right on it. The head refusing to leave the edge is the signal; a second
   * line under the first would only hang below the tracks like an artifact.
   */
  const applyAt = (clientX: number, shiftKey: boolean) => {
    const s = scrub.current;
    if (!s) return;
    useStore.getState().seek(seekTimeAt(s.content, clientX, shiftKey, s.points, s));
  };

  /**
   * Edge autoscroll (rAF), same shape as the clip drag's: holding the pointer
   * against the viewport edge keeps the timeline moving under it. Without it a
   * scrub simply stalls at the last visible pixel.
   */
  const startAutoScroll = () => {
    if (rafRef.current != null) return;
    const step = () => {
      const s = scrub.current;
      if (!s) {
        rafRef.current = null;
        return;
      }
      const scroller = s.scroller;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const x = s.lastPointerX;
        const speed =
          x < rect.left + EDGE_PX
            ? Math.max(-MAX_SCROLL_STEP_PX, (x - (rect.left + EDGE_PX)) / 3)
            : x > rect.right - EDGE_PX
              ? Math.min(MAX_SCROLL_STEP_PX, (x - (rect.right - EDGE_PX)) / 3)
              : 0;
        if (speed !== 0) {
          const before = scroller.scrollLeft;
          scroller.scrollLeft = before + speed;
          // The content box moved under a stationary pointer, so the same
          // clientX now reads a different time.
          if (scroller.scrollLeft !== before) applyAt(x, false);
        }
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    // Right- and middle-press must not move the playhead: a context menu on the
    // ruler would otherwise drag the transport along with it.
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const content = timelineContentEl(el);
    if (!content) return;
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);

    const state = useStore.getState();
    // Scrubbing against a running transport fights it: pause first, like the
    // touch scrub and the clip-click seek already do.
    if (state.playing) state.setPlaying(false);

    const startMs = state.currentTimeMs;
    scrub.current = {
      pointerId: e.pointerId,
      el,
      content,
      scroller: el.closest<HTMLElement>('.timeline-scroller'),
      startMs,
      points: seekSnapPoints(startMs),
      lastPointerX: e.clientX,
      lastSnap: null,
    };

    // Escape aborts and puts the playhead back, like every other timeline drag.
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !scrub.current) return;
      ev.stopImmediatePropagation();
      const s = scrub.current;
      useStore.getState().seek(s.startMs);
      try {
        s.el.releasePointerCapture(s.pointerId);
      } catch {
        // already released
      }
      end();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    cleanupRef.current = () => window.removeEventListener('keydown', onKey, { capture: true });

    if (seekOnDown) applyAt(e.clientX, e.shiftKey);
    startAutoScroll();
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const s = scrub.current;
    if (!s || e.pointerId !== s.pointerId) return;
    s.lastPointerX = e.clientX;
    applyAt(e.clientX, e.shiftKey);
  };

  const onPointerUp = () => {
    if (scrub.current) end();
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}
