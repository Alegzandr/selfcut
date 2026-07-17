import { memo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Music, Type } from 'lucide-react';
import { Clip, MediaAsset } from '../types';
import { audioTrackForClip, clipDurationMs, clipEndMs } from '../model';
import { useStore } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { collectSnapPoints, snapMove, snapTime } from './snapping';
import { msFromClientX, msFromContentX, timelineContentEl } from './coords';
import {
  MARKER_BAR_HEIGHT_PX,
  MIN_CLIP_DURATION_MS,
  RULER_HEIGHT_PX,
  SNAP_THRESHOLD_PX,
  TRACK_HEADER_WIDTH_PX,
  TRACK_HEIGHT_PX,
} from '../app/config';
import { clamp, formatTime } from '../lib/time';
import { useIsCoarsePointer } from '../lib/device';
import { hapticOnSnap, snapTick } from '../lib/haptics';
import { Waveform } from './Waveform';

interface DragState {
  mode: 'move' | 'trim-left' | 'trim-right' | 'fade-in' | 'fade-out' | 'slip';
  /** The element that captured the pointer - drag math resolves coords from it. */
  el: HTMLElement;
  startX: number;
  startY: number;
  origStartMs: number;
  durMs: number;
  origTrackIndex: number;
  points: number[];
  moved: boolean;
  /** Last snapped-to position (ms), to fire one haptic tick per snap. */
  lastSnap: number | null;
  /** Multi-selection drag: original start of every clip moving together. */
  groupStarts: Map<string, number>;
  /** Timeline time (ms) under the pointer at press, to seek on a click without drag. */
  downMs: number;
  /** The clip the drag actually edits (a Ctrl+drag clone replaces the pressed clip). */
  targetClipId: string;
  /** Ctrl held on the body at press: the first movement clones the selection and drags the copies. */
  copyOnDrag: boolean;
  /** Source window at press (slip / ripple math works from these, not live state). */
  origSourceInMs: number;
  origSourceOutMs: number;
  /** Ripple trim (Ctrl on a trim handle): same-track downstream clips and their original starts. */
  ripple: { id: string; startMs: number }[] | null;
  /**
   * Roll edit (Alt on a trim handle at a true edit point): the two clips
   * around the cut and the delta bounds allowed by both source windows.
   */
  roll: {
    leftId: string;
    rightId: string;
    origLeftEndMs: number;
    origRightStartMs: number;
    /** The grabbed edge's original position - deltas measure from here. */
    edge0Ms: number;
    minDelta: number;
    maxDelta: number;
  } | null;
  /** The row container, to resolve the track under the pointer (content-relative). */
  rowsEl: HTMLElement | null;
  /**
   * Move drags are driven by window-level listeners: switching tracks reparents
   * (and remounts) the clip's component mid-gesture, which would kill
   * element-level events. Resolved-once anchors keep the math alive after the
   * element detaches.
   */
  winDriven: boolean;
  contentEl: HTMLElement | null;
  scrollerEl: HTMLElement | null;
}

/** "+m:ss.d" / "−m:ss.d" - the badge's signed delta since the press. */
const signedMs = (v: number) => `${v < 0 ? '−' : '+'}${formatTime(Math.abs(v))}`;

interface Props {
  clip: Clip;
  trackKind: 'video' | 'audio';
  selected: boolean;
  pxPerMs: number;
  /** Overlap with the neighboring clips (crossfade windows), for the visuals. */
  xfadeInMs?: number;
  xfadeOutMs?: number;
}

/**
 * Filmstrip: thumbnails tiled at the source aspect ratio (never stretched),
 * each tile showing the frame closest to its position in the clip.
 */
const Filmstrip = memo(function Filmstrip({
  asset,
  clip,
  widthPx,
}: {
  asset: MediaAsset;
  clip: Clip;
  widthPx: number;
}) {
  const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9;
  const tileW = Math.max(24, Math.round((TRACK_HEIGHT_PX - 8) * aspect));
  const count = Math.min(1000, Math.max(1, Math.ceil(widthPx / tileW)));
  const spanMs = clip.sourceOutMs - clip.sourceInMs;
  const thumbs = asset.thumbnails;
  return (
    <div className="flex h-full w-full overflow-hidden">
      {Array.from({ length: count }, (_, i) => {
        const srcMs = clip.sourceInMs + ((i + 0.5) / count) * spanMs;
        const idx = Math.min(
          thumbs.length - 1,
          Math.max(0, Math.round((srcMs / asset.durationMs) * (thumbs.length - 1))),
        );
        return (
          <img
            key={i}
            src={thumbs[idx]}
            className="h-full flex-none object-cover"
            style={{ width: tileW }}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
          />
        );
      })}
    </div>
  );
});

export const ClipView = memo(function ClipView({
  clip,
  trackKind,
  selected,
  pxPerMs,
  xfadeInMs = 0,
  xfadeOutMs = 0,
}: Props) {
  const { t } = useTranslation();
  const asset = useStore((s) => s.assets[clip.assetId]);
  const padLeft = useStore((s) => s.timelinePadLeft);
  const coarse = useIsCoarsePointer();
  const drag = useRef<DragState | null>(null);
  /** Last pointer position, so edge autoscroll can re-apply the drag per frame. */
  const lastPointer = useRef<{ x: number; y: number; shift: boolean } | null>(null);
  const autoScrollRaf = useRef<number | null>(null);
  /** Pending long-press pick-up (touch, unselected clip): timer + press point. */
  const longPress = useRef<{ timer: number; x: number; y: number } | null>(null);
  /** Teardown for per-drag listeners (Escape cancel, touch scroll blocker). */
  const sessionCleanup = useRef<(() => void) | null>(null);
  /** This clip's floating drag readout (store-held, so it survives a remount). */
  const dragBadgeText = useStore((s) =>
    s.dragBadge?.clipId === clip.id ? s.dragBadge.text : null,
  );

  // Unmount cleanup - EXCEPT for a window-driven move session: switching
  // tracks remounts this component mid-gesture, and the session (window
  // listeners, rAF loop, drag ref - all held by closures) must keep driving
  // the drag until the pointer is released.
  useEffect(
    () => () => {
      if (drag.current?.winDriven) return;
      sessionCleanup.current?.();
      if (autoScrollRaf.current != null) cancelAnimationFrame(autoScrollRaf.current);
      if (longPress.current) clearTimeout(longPress.current.timer);
    },
    [],
  );

  const durMs = clipDurationMs(clip);
  const left = padLeft + clip.timelineStartMs * pxPerMs;
  const width = Math.max(6, durMs * pxPerMs);

  // The source audio track this clip draws its waveform from. When the source
  // carries several audio tracks, label the clip with which one it plays.
  const audioInfo = asset ? audioTrackForClip(asset, clip) : undefined;
  const hasPeaks = (audioInfo?.peaks?.length ?? 0) > 0;
  // Only an audio clip pins a single source track worth labelling - a video clip
  // delegates all of them, so it gets no track badge.
  const trackBadge =
    trackKind === 'audio' && asset && asset.audioTracks.length > 1 && audioInfo
      ? (audioInfo.language?.toUpperCase() ??
        t('clip.audioTrack', { n: asset.audioTracks.indexOf(audioInfo) + 1 }))
      : null;

  /** Tear down the drag session: listeners, autoscroll loop, guide line, badge. */
  const endDragSession = () => {
    sessionCleanup.current?.();
    sessionCleanup.current = null;
    if (autoScrollRaf.current != null) cancelAnimationFrame(autoScrollRaf.current);
    autoScrollRaf.current = null;
    const state = useStore.getState();
    state.setSnapGuide(null);
    state.setDragBadge(null);
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

  /**
   * One drag step at the given pointer position. Split from the pointermove
   * handler so edge autoscroll can re-run it every frame while the pointer
   * rests against a viewport edge and the content slides underneath.
   */
  const applyDrag = (clientX: number, clientY: number, shiftKey: boolean) => {
    const d = drag.current;
    if (!d) return;
    const state = useStore.getState();
    const pxMs = state.pxPerSec / 1000;
    // N toggles snapping globally; holding Shift inverts it for the current drag.
    const snapActive = shiftKey ? !state.snapEnabled : state.snapEnabled;
    const snapThresholdMs = snapActive ? SNAP_THRESHOLD_PX / pxMs : 0;
    // Coords via the content box resolved at press: d.el may be detached after
    // a cross-track remount, but the content element lives for the whole drag.
    const toMs = (x: number) =>
      d.contentEl ? msFromContentX(d.contentEl, x) : msFromClientX(d.el, x);
    // Post-edit clip values for the badge, read fresh from the store (the
    // `clip` prop can be a stale snapshot after a cross-track remount).
    const findLive = (id: string) =>
      useStore
        .getState()
        .project.tracks.flatMap((t) => t.clips)
        .find((c) => c.id === id);

    if (d.mode === 'move') {
      // Pointer-anchored: the grabbed spot stays glued under the pointer even
      // while autoscroll moves the content.
      const raw = toMs(clientX) - (d.downMs - d.origStartMs);
      let proposed = hapticOnSnap(raw, snapMove(raw, d.durMs, d.points, snapThresholdMs), d);
      proposed = Math.max(0, proposed);
      // Guide line at whichever point captured the clip's start or end.
      const guide =
        proposed !== raw
          ? d.points.find(
              (p) => Math.abs(p - proposed) < 0.5 || Math.abs(p - (proposed + d.durMs)) < 0.5,
            )
          : undefined;
      state.setSnapGuide(guide ?? null);

      if (d.groupStarts.size > 1) {
        // Group drag: same delta for everyone, clamped so no clip crosses t=0.
        let delta = proposed - d.origStartMs;
        const minStart = Math.min(...d.groupStarts.values());
        delta = Math.max(delta, -minStart);
        state.moveClips(
          [...d.groupStarts].map(([clipId, orig]) => ({ clipId, timelineStartMs: orig + delta })),
        );
      } else {
        // Target track = the row under the pointer, resolved content-relative
        // so vertical autoscroll (rect moves, pointer doesn't) stays correct.
        let targetTrackId: string | undefined;
        const tracks = state.project.tracks;
        const rowsRect = d.rowsEl?.getBoundingClientRect();
        const targetIdx = rowsRect
          ? clamp(Math.floor((clientY - rowsRect.top) / TRACK_HEIGHT_PX), 0, tracks.length - 1)
          : d.origTrackIndex;
        if (tracks[targetIdx]?.kind === trackKind) targetTrackId = tracks[targetIdx].id;

        state.moveClip(d.targetClipId, proposed, targetTrackId);
      }
      const moved = findLive(d.targetClipId);
      if (moved) {
        state.setDragBadge({
          clipId: d.targetClipId,
          text: `${formatTime(moved.timelineStartMs)} (${signedMs(moved.timelineStartMs - d.origStartMs)})`,
        });
      }
    } else if (d.mode === 'slip') {
      // Slip: dragging right shows earlier media (the source window slides left).
      const dx = clientX - d.startX;
      state.slipClip(d.targetClipId, d.origSourceInMs - (dx / pxMs) * clip.speed);
      const slipped = findLive(d.targetClipId);
      if (slipped) {
        state.setDragBadge({
          clipId: d.targetClipId,
          text: signedMs(slipped.sourceInMs - d.origSourceInMs),
        });
      }
    } else if (d.mode === 'fade-in' || d.mode === 'fade-out') {
      // Fade handles: drag inward from a clip edge to fade from/to black (and silence).
      const tMs = toMs(clientX);
      if (d.mode === 'fade-in') {
        const v = Math.round(clamp(tMs - d.origStartMs, 0, d.durMs) / 10) * 10;
        state.updateClip(clip.id, { fadeInMs: v });
      } else {
        const v = Math.round(clamp(d.origStartMs + d.durMs - tMs, 0, d.durMs) / 10) * 10;
        state.updateClip(clip.id, { fadeOutMs: v });
      }
    } else {
      const raw = toMs(clientX);
      if (d.roll) {
        // Roll edit: the cut moves by the pointer's DELTA (anchored at the
        // grab point, like every NLE - not teleported to the pointer), the cut
        // itself snapping to the timeline's snap points. Both edges move by
        // the same delta so overall length (and any crossfade overlap) is
        // preserved; trimClip carries the linked A/V partners along.
        const rawCut = d.roll.edge0Ms + (raw - d.downMs);
        const cut = hapticOnSnap(rawCut, snapTime(rawCut, d.points, snapThresholdMs), d);
        state.setSnapGuide(cut !== rawCut ? cut : null);
        const delta = clamp(cut - d.roll.edge0Ms, d.roll.minDelta, d.roll.maxDelta);
        state.trimClip(d.roll.leftId, 'right', d.roll.origLeftEndMs + delta);
        state.trimClip(d.roll.rightId, 'left', d.roll.origRightStartMs + delta);
        // Badge: the cut point's position and how far it rolled.
        state.setDragBadge({
          clipId: clip.id,
          text: `${formatTime(d.roll.edge0Ms + delta)} (${signedMs(delta)})`,
        });
        return;
      }
      const tMs = hapticOnSnap(raw, snapTime(raw, d.points, snapThresholdMs), d);
      state.setSnapGuide(tMs !== raw ? tMs : null);
      const trimBadge = () => {
        const trimmed = findLive(clip.id);
        if (!trimmed) return;
        const dur = clipDurationMs(trimmed);
        state.setDragBadge({
          clipId: clip.id,
          text: `${formatTime(dur)} (${signedMs(dur - d.durMs)})`,
        });
      };
      if (!d.ripple) {
        state.trimClip(clip.id, d.mode === 'trim-left' ? 'left' : 'right', tMs);
        trimBadge();
        return;
      }
      // Ripple trim: downstream clips keep their distance to the edited edge.
      // All deltas derive from the source window captured at press, so each
      // move is absolute (no per-event drift).
      const minSpan = MIN_CLIP_DURATION_MS * clip.speed;
      if (d.mode === 'trim-right') {
        const sourceOut = clamp(
          d.origSourceInMs + (tMs - d.origStartMs) * clip.speed,
          d.origSourceInMs + minSpan,
          asset ? asset.durationMs : Infinity,
        );
        const newEnd = d.origStartMs + (sourceOut - d.origSourceInMs) / clip.speed;
        state.trimClip(clip.id, 'right', newEnd);
        const delta = newEnd - (d.origStartMs + d.durMs);
        state.moveClips(d.ripple.map((r) => ({ clipId: r.id, timelineStartMs: r.startMs + delta })));
      } else {
        const sourceIn = clamp(
          d.origSourceInMs + (tMs - d.origStartMs) * clip.speed,
          0,
          d.origSourceOutMs - minSpan,
        );
        const removedMs = (sourceIn - d.origSourceInMs) / clip.speed;
        // trimClip works from the clip's CURRENT geometry: derive the absolute
        // target that lands on `sourceIn` from the live store state (the `clip`
        // prop can lag a render), then pull the trimmed clip back to its
        // original start - ripple keeps the edit point still, the downstream
        // content closes the gap instead.
        const live = state.project.tracks
          .flatMap((tr) => tr.clips)
          .find((c) => c.id === clip.id);
        if (!live) return;
        state.trimClip(clip.id, 'left', live.timelineStartMs + (sourceIn - live.sourceInMs) / clip.speed);
        state.moveClips([
          { clipId: clip.id, timelineStartMs: d.origStartMs },
          ...d.ripple.map((r) => ({ clipId: r.id, timelineStartMs: r.startMs - removedMs })),
        ]);
      }
      trimBadge();
    }
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
      if (lp && scroller && d.mode !== 'slip' && d.mode !== 'fade-in' && d.mode !== 'fade-out') {
        const rect = scroller.getBoundingClientRect();
        // The desktop gutter (sticky track headers) covers the scroller's left
        // side - autoscroll must kick in before the pointer dives under it.
        const leftEdge = rect.left + (coarse ? 0 : TRACK_HEADER_WIDTH_PX) + 40;
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
      // A plain click on a clip that didn't turn into a drag moves the playhead there.
      else if (d.mode === 'move') state.seek(Math.max(0, d.downMs));
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
      points: collectSnapPoints(state.project, [clip.id], state.currentTimeMs, state.loopRegion),
      moved: false,
      lastSnap: null,
      groupStarts: new Map([[clip.id, clip.timelineStartMs]]),
      downMs,
      targetClipId: clip.id,
      copyOnDrag: false,
      origSourceInMs: clip.sourceInMs,
      origSourceOutMs: clip.sourceOutMs,
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

  const beginDrag = (e: React.PointerEvent, mode: DragState['mode']) => {
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
    if (!coarse && e.altKey && mode === 'move' && clip.kind === 'media' && asset) mode = 'slip';
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
    // Ctrl on a trim handle: ripple trim - downstream clips on this track follow
    // the edited edge, keeping their distance to it (their partners tag along).
    const ripple =
      !coarse && (e.ctrlKey || e.metaKey) && isTrim
        ? (state.project.tracks
            .find((tr) => tr.id === clip.trackId)
            ?.clips.filter((c) => c.id !== clip.id && c.timelineStartMs > clip.timelineStartMs)
            .map((c) => ({ id: c.id, startMs: c.timelineStartMs })) ?? [])
        : null;
    // Alt on a trim handle: roll edit - the cut point between this clip and its
    // neighbor moves, one side lengthens exactly as the other shortens. Only a
    // true edit point rolls (adjacent or crossfading neighbor); Ctrl wins.
    let roll: DragState['roll'] = null;
    if (!coarse && e.altKey && !ripple && isTrim) {
      const siblings =
        state.project.tracks.find((tr) => tr.id === clip.trackId)?.clips ?? [];
      const neighbor =
        mode === 'trim-right'
          ? siblings
              .filter((c) => c.id !== clip.id && c.timelineStartMs > clip.timelineStartMs)
              .sort((a, b) => a.timelineStartMs - b.timelineStartMs)[0]
          : siblings
              .filter((c) => c.id !== clip.id && c.timelineStartMs < clip.timelineStartMs)
              .sort((a, b) => b.timelineStartMs - a.timelineStartMs)[0];
      const left = mode === 'trim-right' ? clip : neighbor;
      const right = mode === 'trim-right' ? neighbor : clip;
      if (left && right && right.timelineStartMs <= clipEndMs(left) + 1) {
        const leftAsset = state.assets[left.assetId];
        // Delta bounds: the left clip's out point can move within its source
        // headroom, the right clip's in point within its own - the cut only
        // rolls as far as BOTH sides allow.
        const minDelta = Math.max(
          (left.sourceInMs + MIN_CLIP_DURATION_MS * left.speed - left.sourceOutMs) / left.speed,
          -right.sourceInMs / right.speed,
        );
        const maxDelta = Math.min(
          ((leftAsset?.durationMs ?? Infinity) - left.sourceOutMs) / left.speed,
          (right.sourceOutMs - right.sourceInMs - MIN_CLIP_DURATION_MS * right.speed) /
            right.speed,
        );
        roll = {
          leftId: left.id,
          rightId: right.id,
          origLeftEndMs: clipEndMs(left),
          origRightStartMs: right.timelineStartMs,
          edge0Ms: mode === 'trim-right' ? clipEndMs(clip) : clip.timelineStartMs,
          minDelta,
          maxDelta,
        };
      }
    }
    // Time under the pointer at press: a plain click (no drag) on a clip moves
    // the playhead there, like a classic NLE.
    const contentEl = timelineContentEl(e.currentTarget as HTMLElement);
    const downMs = contentEl ? msFromContentX(contentEl, e.clientX) : clip.timelineStartMs;
    // Snap points: exclude the dragged group - and for a roll also the
    // neighbor, whose edge sits ON the cut and would pin the roll in place.
    const excluded = roll ? [...groupIds, roll.leftId, roll.rightId] : groupIds;
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
      origSourceInMs: clip.sourceInMs,
      origSourceOutMs: clip.sourceOutMs,
      ripple,
      roll,
      rowsEl: el.closest<HTMLElement>('[data-rowbg]')?.parentElement ?? null,
      winDriven: mode === 'move',
      contentEl,
      scrollerEl: el.closest<HTMLElement>('.timeline-scroller'),
    };
    if (mode === 'move') attachWindowDrag(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
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

  const isVideo = trackKind === 'video';
  const border = selected
    ? 'ring-2 ring-sky-400 border-transparent'
    : isVideo
      ? 'border-sky-900'
      : 'border-emerald-900';
  // Unselected on touch: no touch-action lock, so a horizontal pan scrubs the timeline.
  const touch = coarse && !selected ? '' : 'touch-none';

  return (
    <div
      data-clip-id={clip.id}
      data-clip-kind={trackKind}
      className={`absolute top-1 bottom-1 overflow-hidden rounded-md border ${touch} ${border} ${isVideo ? 'bg-sky-950' : 'bg-emerald-950'}`}
      style={{ left, width }}
      onPointerDown={(e) => beginDrag(e, 'move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClick={() => {
        if (coarse && !selected) useStore.getState().selectClip(clip.id);
      }}
      onDoubleClick={(e) => {
        if (coarse) return;
        e.stopPropagation();
        // Vegas-style: double-click turns the clip's bounds into the selection
        // region (yellow corners) - ready to loop, review or export that span.
        useStore
          .getState()
          .setLoopRegion({ startMs: clip.timelineStartMs, endMs: clip.timelineStartMs + durMs });
      }}
      onContextMenu={(e) => {
        if (coarse) return; // Desktop only: leave the native menu on touch long-press.
        e.preventDefault();
        e.stopPropagation();
        const state = useStore.getState();
        // Right-clicking outside the current selection selects this clip; a
        // right-click inside a multi-selection keeps it, so "delete" hits all.
        if (!state.selectedClipIds.includes(clip.id)) state.selectClip(clip.id);
        state.openContextMenu(e.clientX, e.clientY, { kind: 'clip', clipId: clip.id });
      }}
    >
      {clip.kind === 'text' ? (
        <div className="pointer-events-none flex h-full w-full items-center gap-1 bg-gradient-to-b from-violet-900/60 to-violet-950 px-1.5">
          <Type className="h-3 w-3 flex-none text-violet-300" />
          <span className="truncate text-[11px] font-medium text-violet-100">
            {clip.text.content.split('\n')[0] || t('clip.text.placeholder')}
          </span>
        </div>
      ) : clip.kind === 'solid' ? (
        <div
          className="pointer-events-none flex h-full w-full items-center gap-1 px-1.5"
          style={{
            background:
              clip.solid.kind === 'gradient'
                ? `linear-gradient(${clip.solid.angle ?? 0}deg, ${clip.solid.color}, ${clip.solid.color2 ?? clip.solid.color})`
                : clip.solid.color,
          }}
        >
          <span className="truncate text-[11px] font-medium text-white drop-shadow">{t(`clip.solid.${clip.solid.kind}`)}</span>
        </div>
      ) : isVideo && asset?.thumbnails.length ? (
        <div className="pointer-events-none h-full w-full">
          <Filmstrip asset={asset} clip={clip} widthPx={width} />
          {/* Audio envelope under the thumbnails - cutting to sound needs to be visual. */}
          {hasPeaks && (
            <div className="absolute inset-x-0 bottom-0 h-1/3 bg-black/40">
              <Waveform asset={asset} clip={clip} widthPx={width} color="rgba(255,255,255,0.85)" />
            </div>
          )}
        </div>
      ) : (
        <div className="pointer-events-none relative h-full w-full bg-gradient-to-b from-emerald-900/60 to-emerald-950">
          {hasPeaks && asset && (
            <div className="absolute inset-0">
              <Waveform asset={asset} clip={clip} widthPx={width} color="rgba(110,231,183,0.65)" />
            </div>
          )}
          <div className="absolute left-0 top-0 flex max-w-full items-center gap-1 px-1.5 py-0.5">
            {clip.linkId ? (
              <Link2 className="h-3 w-3 flex-none text-emerald-300" />
            ) : (
              <Music className="h-3 w-3 flex-none text-emerald-300" />
            )}
            <span className="truncate text-[10px] text-emerald-100">{asset?.file.name}</span>
            {trackBadge && (
              <span className="flex-none rounded bg-emerald-800/80 px-1 text-[9px] font-medium text-emerald-100">
                {trackBadge}
              </span>
            )}
          </div>
        </div>
      )}

      {/* A/V-link badge: this video clip's audio lives on a linked audio clip. */}
      {isVideo && clip.kind === 'media' && clip.linkId && (
        <div className="pointer-events-none absolute left-0.5 top-0.5 rounded bg-black/55 p-0.5">
          <Link2 className="h-2.5 w-2.5 text-sky-200" />
        </div>
      )}

      {/* Speed / volume badge */}
      {(clip.speed !== 1 || clip.volume !== 1) && (
        <div className="pointer-events-none absolute right-1 top-0.5 rounded bg-black/60 px-1 text-[9px] text-zinc-200">
          {clip.speed !== 1 ? `${clip.speed}×` : ''}
          {clip.speed !== 1 && clip.volume !== 1 ? ' · ' : ''}
          {clip.volume !== 1 ? `${Math.round(clip.volume * 100)}%` : ''}
        </div>
      )}

      {/* Live drag readout: position (move), cut point (roll), duration (trim)
          or source offset (slip) with the delta since the press - CapCut's trim
          bubble and the pro-NLE numeric feedback in one. Store-held so it
          survives the remount when the drag crosses onto another track. */}
      {dragBadgeText && (
        <div className="pointer-events-none absolute left-1/2 top-1 z-30 -translate-x-1/2 whitespace-nowrap rounded bg-zinc-950/85 px-1.5 py-0.5 font-mono text-[10px] leading-tight text-zinc-100 shadow">
          {dragBadgeText}
        </div>
      )}

      {/* Trim handles (touch: only once selected, CapCut-style) */}
      {(!coarse || selected) && (
        <>
          <div
            className={`absolute inset-y-0 left-0 cursor-ew-resize touch-none ${coarse ? 'w-4' : 'w-3'} ${selected ? 'bg-sky-400/80' : 'bg-white/10'}`}
            onPointerDown={(e) => beginDrag(e, 'trim-left')}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {selected && (
              <div className="pointer-events-none absolute inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded bg-zinc-900/70" />
            )}
          </div>
          <div
            className={`absolute inset-y-0 right-0 cursor-ew-resize touch-none ${coarse ? 'w-4' : 'w-3'} ${selected ? 'bg-sky-400/80' : 'bg-white/10'}`}
            onPointerDown={(e) => beginDrag(e, 'trim-right')}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {selected && (
              <div className="pointer-events-none absolute inset-y-2 left-1/2 w-0.5 -translate-x-1/2 rounded bg-zinc-900/70" />
            )}
          </div>
        </>
      )}

      {/* Fade ramps: the dark wedge (fade from/to black) plus the classic-NLE
          ramp line drawn corner-to-top, so the fade is legible at a glance. */}
      {clip.fadeInMs > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-black/70 to-transparent"
          style={{ width: clip.fadeInMs * pxPerMs }}
        />
      )}
      {clip.fadeOutMs > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-black/70 to-transparent"
          style={{ width: clip.fadeOutMs * pxPerMs }}
        />
      )}
      {(clip.fadeInMs > 0 || clip.fadeOutMs > 0) && (
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${width} 100`}
          preserveAspectRatio="none"
        >
          {clip.fadeInMs > 0 && (
            <line
              x1={0}
              y1={100}
              x2={clip.fadeInMs * pxPerMs}
              y2={0}
              stroke="rgba(251,191,36,0.95)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {clip.fadeOutMs > 0 && (
            <line
              x1={width - clip.fadeOutMs * pxPerMs}
              y1={0}
              x2={width}
              y2={100}
              stroke="rgba(251,191,36,0.95)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      )}

      {/* Crossfade with a neighbor: the overlap window, marked with the ramp of
          this clip's edge (incoming rises, outgoing falls) — the two neighbors'
          ramps together read as the classic crossfade "X". */}
      {xfadeInMs > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 border-r border-sky-300/50 bg-sky-300/10"
          style={{ width: xfadeInMs * pxPerMs }}
        >
          <svg className="h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <line
              x1={0}
              y1={100}
              x2={100}
              y2={0}
              stroke="rgba(125,211,252,0.9)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      )}
      {xfadeOutMs > 0 && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 border-l border-sky-300/50 bg-sky-300/10"
          style={{ width: xfadeOutMs * pxPerMs }}
        >
          <svg className="h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
            <line
              x1={0}
              y1={0}
              x2={100}
              y2={100}
              stroke="rgba(125,211,252,0.9)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      )}

      {/* Fade handles: drag from the clip's top corners to fade from/to black.
          The interactive box is deliberately larger than the visible dot so the
          corner is easy to grab; the dot itself sits at the ramp's top. */}
      {selected && (
        <>
          <Tooltip label={t('clip.fadeIn')}>
            <div
              className={`absolute top-0 z-10 flex -translate-x-1/2 items-start justify-center cursor-ew-resize touch-none ${coarse ? 'h-8 w-8' : 'h-6 w-6'}`}
              style={{ left: clamp(clip.fadeInMs * pxPerMs, 6, Math.max(6, width / 2)) }}
              onPointerDown={(e) => beginDrag(e, 'fade-in')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <span
                className={`pointer-events-none rounded-full border border-zinc-900 bg-amber-300 shadow ${coarse ? 'h-4 w-4' : 'h-3 w-3'}`}
              />
            </div>
          </Tooltip>
          <Tooltip label={t('clip.fadeOut')}>
            <div
              className={`absolute top-0 z-10 flex -translate-x-1/2 items-start justify-center cursor-ew-resize touch-none ${coarse ? 'h-8 w-8' : 'h-6 w-6'}`}
              style={{ left: clamp(width - clip.fadeOutMs * pxPerMs, Math.min(width - 6, width / 2), width - 6) }}
              onPointerDown={(e) => beginDrag(e, 'fade-out')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <span
                className={`pointer-events-none rounded-full border border-zinc-900 bg-amber-300 shadow ${coarse ? 'h-4 w-4' : 'h-3 w-3'}`}
              />
            </div>
          </Tooltip>
        </>
      )}
    </div>
  );
});
