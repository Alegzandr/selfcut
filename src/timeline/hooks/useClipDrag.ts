/**
 * The clip gesture state machine: pointer handlers that turn a press on the
 * clip body, a trim handle, a fade corner or the volume line into a live drag
 * session - with edge autoscroll, Escape cancel, touch long-press pick-up and
 * window-driven move drags that survive a cross-track remount. The per-step
 * edit math lives in `../clipDrag.ts`.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { Clip, MediaAsset } from '../../types';
import { useStore } from '../../store/store';
import { linkedPartnerIds } from '../../store/projectOps';
import { collectSnapPoints } from '../snapping';
import { msFromContentX, timelineContentEl } from '../coords';
import { MARKER_BAR_HEIGHT_PX, RULER_HEIGHT_PX } from '../../app/config';
import { gainToFader } from '../../lib/gain';
import { snapTick } from '../../lib/haptics';
import { applyClipDrag, rippleForTrim, rollForTrim, type DragState } from '../clipDrag';

interface ClipDragArgs {
  clip: Clip;
  asset: MediaAsset | undefined;
  trackKind: 'video' | 'audio';
  /** Touch gestures depend on selection: an unselected clip pans, a selected one drags. */
  selected: boolean;
  coarse: boolean;
  durMs: number;
}

export function useClipDrag({ clip, asset, trackKind, selected, coarse, durMs }: ClipDragArgs) {
  const drag = useRef<DragState | null>(null);
  /** Last pointer position, so edge autoscroll can re-apply the drag per frame. */
  const lastPointer = useRef<{ x: number; y: number; shift: boolean } | null>(null);
  const autoScrollRaf = useRef<number | null>(null);
  /** Pending long-press pick-up (touch, unselected clip): timer + press point. */
  const longPress = useRef<{ timer: number; x: number; y: number } | null>(null);
  /** Teardown for per-drag listeners (Escape cancel, touch scroll blocker). */
  const sessionCleanup = useRef<(() => void) | null>(null);

  // Unmount cleanup - EXCEPT for a window-driven move session: switching
  // tracks remounts this component mid-gesture, and the session (window
  // listeners, rAF loop, drag ref - all held by closures) must keep driving
  // the drag until the pointer is released.
  useEffect(
    () => () => {
      if (drag.current?.winDriven) return;
      sessionCleanup.current?.();
      // A trim can't outlive its clip's component: don't strand the preview on
      // a frame the playhead isn't at.
      if (drag.current) useStore.getState().setPreviewOverride(null);
      if (autoScrollRaf.current != null) cancelAnimationFrame(autoScrollRaf.current);
      if (longPress.current) clearTimeout(longPress.current.timer);
    },
    [],
  );

  /** Tear down the drag session: listeners, autoscroll loop, guide line, badge, preview. */
  const endDragSession = () => {
    sessionCleanup.current?.();
    sessionCleanup.current = null;
    if (autoScrollRaf.current != null) cancelAnimationFrame(autoScrollRaf.current);
    autoScrollRaf.current = null;
    const state = useStore.getState();
    state.setSnapGuide(null);
    state.setDragBadge(null);
    // Give the picture back to the playhead - the trim preview only lives for
    // the length of the gesture.
    state.setPreviewOverride(null);
    drag.current = null;
  };

  /** Per-drag listeners: Escape cancels the whole gesture (classic NLE). */
  const armDragSession = (el: HTMLElement, pointerId: number) => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      // Swallow it before the global hotkeys deselect anything.
      ev.stopImmediatePropagation();
      useStore.getState().cancelGesture();
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        // already released
      }
      endDragSession();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    sessionCleanup.current = () => window.removeEventListener('keydown', onKey, { capture: true });
  };

  const applyDrag = (clientX: number, clientY: number, shiftKey: boolean) => {
    const d = drag.current;
    if (!d) return;
    applyClipDrag(d, clip, asset, trackKind, clientX, clientY, shiftKey);
  };

  /**
   * Edge autoscroll (rAF): dragging against the viewport edge scrolls the
   * timeline and keeps applying the drag, like every pro NLE. Runs only for
   * move/trim modes - slip and fades act on a stationary clip.
   */
  const startAutoScroll = () => {
    if (autoScrollRaf.current != null) return;
    const step = () => {
      const d = drag.current;
      if (!d) {
        autoScrollRaf.current = null;
        return;
      }
      const lp = lastPointer.current;
      const scroller = d.scrollerEl;
      if (
        lp &&
        scroller &&
        d.mode !== 'slip' &&
        d.mode !== 'fade-in' &&
        d.mode !== 'fade-out' &&
        d.mode !== 'volume'
      ) {
        const rect = scroller.getBoundingClientRect();
        // The header pane is outside the scroller, so its left edge is already
        // the timeline's: no gutter to compensate for.
        const leftEdge = rect.left + 40;
        const rightEdge = rect.right - 40;
        const speed =
          lp.x < leftEdge
            ? Math.max(-24, (lp.x - leftEdge) / 3)
            : lp.x > rightEdge
              ? Math.min(24, (lp.x - rightEdge) / 3)
              : 0;
        // Vertical: move mode only (track switching). The sticky marker bar and
        // ruler cover the scroller's top - the zone starts below them.
        const topEdge = rect.top + MARKER_BAR_HEIGHT_PX + RULER_HEIGHT_PX + 24;
        const bottomEdge = rect.bottom - 28;
        const vSpeed =
          d.mode !== 'move'
            ? 0
            : lp.y < topEdge
              ? Math.max(-16, (lp.y - topEdge) / 3)
              : lp.y > bottomEdge
                ? Math.min(16, (lp.y - bottomEdge) / 3)
                : 0;
        if (speed !== 0 || vSpeed !== 0) {
          const beforeX = scroller.scrollLeft;
          const beforeY = scroller.scrollTop;
          if (speed !== 0) scroller.scrollLeft = beforeX + speed;
          if (vSpeed !== 0) scroller.scrollTop = beforeY + vSpeed;
          if (scroller.scrollLeft !== beforeX || scroller.scrollTop !== beforeY) {
            applyDrag(lp.x, lp.y, lp.shift);
          }
        }
      }
      autoScrollRaf.current = requestAnimationFrame(step);
    };
    autoScrollRaf.current = requestAnimationFrame(step);
  };

  const clearLongPress = () => {
    if (longPress.current) {
      clearTimeout(longPress.current.timer);
      longPress.current = null;
    }
  };

  /** One drag step from any source (element event, window event, autoscroll frame). */
  const handleMoveEvent = (clientX: number, clientY: number, shiftKey: boolean) => {
    const d = drag.current;
    if (!d) return;
    lastPointer.current = { x: clientX, y: clientY, shift: shiftKey };
    if (!d.moved && Math.abs(clientX - d.startX) < 4 && Math.abs(clientY - d.startY) < 4) {
      return;
    }
    if (!d.moved) {
      if (d.copyOnDrag) {
        // First movement of a Ctrl+drag: clone the group in place and switch
        // the drag over to the clones - the originals stay where they are.
        const state = useStore.getState();
        const idMap = state.cloneClipsForDrag([...d.groupStarts.keys()]);
        d.targetClipId = idMap[clip.id] ?? clip.id;
        d.groupStarts = new Map([...d.groupStarts].map(([id, ms]) => [idMap[id] ?? id, ms]));
        // Re-collect snap points excluding the clones: the originals' edges are
        // now valid snap targets (a copy often lands right against its source).
        d.points = collectSnapPoints(
          state.project,
          Object.values(idMap),
          state.currentTimeMs,
          state.loopRegion,
        );
      }
      startAutoScroll();
    }
    d.moved = true;
    applyDrag(clientX, clientY, shiftKey);
  };

  /** End of drag from any source: commit the gesture and tear the session down. */
  const finishDrag = () => {
    const d = drag.current;
    if (!d) return;
    const state = useStore.getState();
    state.endGesture();
    if (!coarse && !d.moved) {
      // Ctrl+click that never dragged: toggle multi-selection membership.
      if (d.copyOnDrag) state.toggleSelectClip(clip.id);
      // A plain click on a clip that didn't turn into a drag moves the playhead
      // there - but never during playback, where selecting a clip must not
      // disturb where the preview is.
      else if (d.mode === 'move' && !state.playing) state.seek(Math.max(0, d.downMs));
    }
    endDragSession();
  };

  /**
   * Window-level drivers for a move drag: switching tracks reparents (and
   * remounts) this component, killing element-level events mid-gesture - the
   * window keeps delivering them for the whole session.
   */
  const attachWindowDrag = (pointerId: number) => {
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) handleMoveEvent(ev.clientX, ev.clientY, ev.shiftKey);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finishDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    const prev = sessionCleanup.current;
    sessionCleanup.current = () => {
      prev?.();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  };

  /** Long-press pick-up (touch): select the clip and start a move drag in place. */
  const pickUpClip = (el: HTMLElement, pointerId: number, clientX: number, clientY: number) => {
    longPress.current = null;
    const state = useStore.getState();
    state.selectClip(clip.id);
    state.beginGesture();
    try {
      el.setPointerCapture(pointerId);
    } catch {
      state.endGesture();
      return;
    }
    armDragSession(el, pointerId);
    // The press started on a pannable surface, so the browser still owns the
    // scroll gesture - a non-passive blocker keeps it from stealing the drag.
    const prevCleanup = sessionCleanup.current;
    const blockScroll = (ev: TouchEvent) => ev.preventDefault();
    window.addEventListener('touchmove', blockScroll, { passive: false });
    sessionCleanup.current = () => {
      prevCleanup?.();
      window.removeEventListener('touchmove', blockScroll);
    };
    snapTick();
    const contentEl = timelineContentEl(el);
    const downMs = contentEl ? msFromContentX(contentEl, clientX) : clip.timelineStartMs;
    lastPointer.current = { x: clientX, y: clientY, shift: false };
    drag.current = {
      mode: 'move',
      el,
      startX: clientX,
      startY: clientY,
      origStartMs: clip.timelineStartMs,
      durMs,
      origTrackIndex: state.project.tracks.findIndex((tr) => tr.id === clip.trackId),
      // Linked partners move along with the clip: their edges must not be snap
      // targets or the drag keeps sticking to its own starting position.
      points: collectSnapPoints(
        state.project,
        [clip.id, ...linkedPartnerIds(state.project, clip.id)],
        state.currentTimeMs,
        state.loopRegion,
      ),
      moved: false,
      lastSnap: null,
      groupStarts: new Map([[clip.id, clip.timelineStartMs]]),
      downMs,
      targetClipId: clip.id,
      copyOnDrag: false,
      origFader: gainToFader(clip.volume),
      origSourceInMs: clip.sourceInMs,
      origSourceOutMs: clip.sourceOutMs,
      stretch: false,
      ripple: null,
      roll: null,
      rowsEl: el.closest<HTMLElement>('[data-rowbg]')?.parentElement ?? null,
      winDriven: true,
      contentEl,
      scrollerEl: el.closest<HTMLElement>('.timeline-scroller'),
    };
    attachWindowDrag(pointerId);
    startAutoScroll();
  };

  const beginDrag = (e: ReactPointerEvent, mode: DragState['mode']) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Mobile (CapCut-style): an unselected clip lets the timeline scroll and a
    // tap selects it (via onClick) - but a STILL long-press picks the clip up
    // for an immediate drag, with a haptic tick.
    if (coarse && !selected) {
      if (mode === 'move' && e.pointerType === 'touch') {
        const el = e.currentTarget as HTMLElement;
        const { pointerId, clientX, clientY } = e;
        clearLongPress();
        longPress.current = {
          x: clientX,
          y: clientY,
          timer: window.setTimeout(() => pickUpClip(el, pointerId, clientX, clientY), 350),
        };
      }
      return;
    }
    e.stopPropagation();
    const state = useStore.getState();
    // Shift+click (desktop): select the whole range between the primary clip and this one.
    if (!coarse && e.shiftKey && !e.ctrlKey && !e.metaKey && mode === 'move') {
      if (state.selectedClipId && state.selectedClipId !== clip.id) {
        state.selectClipRange(state.selectedClipId, clip.id);
      } else {
        state.selectClip(clip.id);
      }
      return;
    }
    // Ctrl/Cmd on the body (desktop): a plain click toggles multi-selection
    // membership (on release), a held drag peels off a COPY (Vegas-style).
    const copyOnDrag = !coarse && (e.ctrlKey || e.metaKey) && mode === 'move';
    // Alt+drag on the body (desktop): slip edit - slide the media under a fixed
    // clip window. Only media clips have a source to slide.
    if (!coarse && e.altKey && mode === 'move' && clip.kind === 'media' && asset && asset.kind !== 'image') {
      mode = 'slip';
    }
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    armDragSession(el, e.pointerId);
    lastPointer.current = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
    // Dragging a clip that belongs to a multi-selection moves the whole group.
    const multi =
      mode === 'move' && state.selectedClipIds.length > 1 && state.selectedClipIds.includes(clip.id);
    if (!multi && !copyOnDrag) state.selectClip(clip.id);
    state.beginGesture();
    const groupIds =
      multi || (copyOnDrag && state.selectedClipIds.includes(clip.id) && state.selectedClipIds.length > 1)
        ? state.selectedClipIds
        : [clip.id];
    const groupStarts = new Map<string, number>();
    for (const tr of state.project.tracks) {
      for (const c of tr.clips) {
        if (groupIds.includes(c.id)) groupStarts.set(c.id, c.timelineStartMs);
      }
    }
    const isTrim = mode === 'trim-left' || mode === 'trim-right';
    const ctrl = e.ctrlKey || e.metaKey;
    // Ctrl on a trim handle: rate stretch - the edge moves but nothing is cut,
    // the same media just plays over a longer (slow motion) or shorter (fast
    // forward) span. Only timed media has a rate; anything else plainly trims.
    const stretch =
      !coarse &&
      ctrl &&
      !e.altKey &&
      isTrim &&
      clip.kind === 'media' &&
      !!asset &&
      asset.kind !== 'image';
    // Ctrl+Alt on a trim handle: ripple trim - downstream clips on this track
    // follow the edited edge, keeping their distance to it (their partners tag
    // along).
    const ripple =
      !coarse && ctrl && e.altKey && isTrim ? rippleForTrim(state.project, clip) : null;
    // Alt alone on a trim handle: roll edit - the cut point between this clip
    // and its neighbor moves, one side lengthens exactly as the other shortens.
    // Only a true edit point rolls (adjacent or crossfading neighbor).
    const roll: DragState['roll'] =
      !coarse && e.altKey && !ctrl && isTrim
        ? rollForTrim(state.project, state.assets, clip, mode)
        : null;
    // Time under the pointer at press: a plain click (no drag) on a clip moves
    // the playhead there, like a classic NLE.
    const contentEl = timelineContentEl(e.currentTarget as HTMLElement);
    const downMs = contentEl ? msFromContentX(contentEl, e.clientX) : clip.timelineStartMs;
    // Snap points: exclude the dragged group AND its linked partners (they
    // follow the drag, so their edges are moving targets that would pin the
    // clip to its own starting position) - and for a roll also the neighbor,
    // whose edge sits ON the cut and would pin the roll in place.
    const withPartners = [
      ...new Set(groupIds.flatMap((id) => [id, ...linkedPartnerIds(state.project, id)])),
    ];
    const excluded = roll ? [...withPartners, roll.leftId, roll.rightId] : withPartners;
    drag.current = {
      mode,
      el,
      startX: e.clientX,
      startY: e.clientY,
      origStartMs: clip.timelineStartMs,
      durMs,
      origTrackIndex: state.project.tracks.findIndex((tr) => tr.id === clip.trackId),
      points: collectSnapPoints(state.project, excluded, state.currentTimeMs, state.loopRegion),
      moved: false,
      lastSnap: null,
      groupStarts,
      downMs,
      targetClipId: clip.id,
      copyOnDrag,
      origFader: gainToFader(clip.volume),
      origSourceInMs: clip.sourceInMs,
      origSourceOutMs: clip.sourceOutMs,
      stretch,
      ripple,
      roll,
      rowsEl: el.closest<HTMLElement>('[data-rowbg]')?.parentElement ?? null,
      winDriven: mode === 'move',
      contentEl,
      scrollerEl: el.closest<HTMLElement>('.timeline-scroller'),
    };
    if (mode === 'move') attachWindowDrag(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    // A pending long-press dies as soon as the finger wanders: the pan wins.
    if (!drag.current && longPress.current) {
      if (Math.hypot(e.clientX - longPress.current.x, e.clientY - longPress.current.y) > 8) {
        clearLongPress();
      }
      return;
    }
    // A window-driven session gets the same event via the window listener.
    if (drag.current?.winDriven) return;
    handleMoveEvent(e.clientX, e.clientY, e.shiftKey);
  };

  const onPointerUp = () => {
    clearLongPress();
    if (drag.current?.winDriven) return;
    finishDrag();
  };

  return { beginDrag, onPointerMove, onPointerUp };
}
