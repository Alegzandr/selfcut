/**
 * The clip drag's data model and per-step math: `DragState` captures everything
 * at press time, `applyClipDrag` turns one pointer position into store updates
 * for whichever mode the gesture is in (move / trim / ripple / roll / slip /
 * fade / volume). The session plumbing that feeds it lives in
 * `hooks/useClipDrag.ts`.
 */
import { Clip, MediaAsset, Project } from '../types';
import { clipDurationMs, clipEndMs } from '../model';
import { useStore } from '../store/store';
import { snapMove, snapTime } from './snapping';
import { msFromClientX, msFromContentX } from './coords';
import { MIN_CLIP_DURATION_MS, SNAP_THRESHOLD_PX } from '../app/config';
import { clamp, formatTime } from '../lib/time';
import { gainDb } from '../inspector/format';
import {
  faderToGain,
  faderToGainStepped,
  faderToLinePos,
  linePosToFader,
} from '../lib/gain';
import { hapticOnSnap } from '../lib/haptics';
import { trackIndexAtY, trackTops } from './trackHeight';

export interface DragState {
  mode: 'move' | 'trim-left' | 'trim-right' | 'fade-in' | 'fade-out' | 'slip' | 'volume';
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
  /** Volume line: the fader position at press, for the relative drag. */
  origFader: number;
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

/**
 * Pointer travel that spans the volume line's full range. Deliberately larger
 * than a track row: mapping the whole scale onto the ~55 px of clip height
 * would make a single pixel worth more than a dB. The line still follows the
 * drag, just damped - and Shift quarters it again for sub-dB trims.
 *
 * The drag moves the line's *position*, not the fader, so the line tracks the
 * pointer at one constant speed across the two halves of the scale.
 */
const VOLUME_DRAG_TRAVEL_PX = 220;

/** "+m:ss.d" / "−m:ss.d" - the badge's signed delta since the press. */
const signedMs = (v: number) => `${v < 0 ? '−' : '+'}${formatTime(Math.abs(v))}`;

/**
 * Ripple trim capture (Ctrl on a trim handle): downstream clips on this track
 * follow the edited edge, keeping their distance to it (their partners tag
 * along). Their original starts are recorded at press so each move is absolute.
 */
export const rippleForTrim = (project: Project, clip: Clip): { id: string; startMs: number }[] =>
  project.tracks
    .find((tr) => tr.id === clip.trackId)
    ?.clips.filter((c) => c.id !== clip.id && c.timelineStartMs > clip.timelineStartMs)
    .map((c) => ({ id: c.id, startMs: c.timelineStartMs })) ?? [];

/**
 * Roll edit capture (Alt on a trim handle): the cut point between this clip and
 * its neighbor moves, one side lengthens exactly as the other shortens. Only a
 * true edit point rolls (adjacent or crossfading neighbor) - anything else
 * yields null and the press falls back to a plain trim.
 */
export const rollForTrim = (
  project: Project,
  assets: Record<string, MediaAsset>,
  clip: Clip,
  mode: DragState['mode'],
): DragState['roll'] => {
  const siblings = project.tracks.find((tr) => tr.id === clip.trackId)?.clips ?? [];
  const neighbor =
    mode === 'trim-right'
      ? siblings
          .filter((c) => c.id !== clip.id && c.timelineStartMs > clip.timelineStartMs)
          .sort((a, b) => a.timelineStartMs - b.timelineStartMs)[0]
      : siblings
          .filter((c) => c.id !== clip.id && c.timelineStartMs < clip.timelineStartMs)
          .sort((a, b) => b.timelineStartMs - a.timelineStartMs)[0];
  const leftClip = mode === 'trim-right' ? clip : neighbor;
  const rightClip = mode === 'trim-right' ? neighbor : clip;
  if (!leftClip || !rightClip || rightClip.timelineStartMs > clipEndMs(leftClip) + 1) return null;
  const leftAsset = assets[leftClip.assetId];
  // Delta bounds: the left clip's out point can move within its source
  // headroom, the right clip's in point within its own - the cut only
  // rolls as far as BOTH sides allow.
  const minDelta = Math.max(
    (leftClip.sourceInMs + MIN_CLIP_DURATION_MS * leftClip.speed - leftClip.sourceOutMs) /
      leftClip.speed,
    -rightClip.sourceInMs / rightClip.speed,
  );
  const maxDelta = Math.min(
    ((leftAsset?.durationMs ?? Infinity) - leftClip.sourceOutMs) / leftClip.speed,
    (rightClip.sourceOutMs - rightClip.sourceInMs - MIN_CLIP_DURATION_MS * rightClip.speed) /
      rightClip.speed,
  );
  return {
    leftId: leftClip.id,
    rightId: rightClip.id,
    origLeftEndMs: clipEndMs(leftClip),
    origRightStartMs: rightClip.timelineStartMs,
    edge0Ms: mode === 'trim-right' ? clipEndMs(clip) : clip.timelineStartMs,
    minDelta,
    maxDelta,
  };
};

/**
 * One drag step at the given pointer position. Split from the pointermove
 * handler so edge autoscroll can re-run it every frame while the pointer
 * rests against a viewport edge and the content slides underneath.
 */
export const applyClipDrag = (
  d: DragState,
  clip: Clip,
  asset: MediaAsset | undefined,
  trackKind: 'video' | 'audio',
  clientX: number,
  clientY: number,
  shiftKey: boolean,
) => {
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
      .project.tracks.flatMap((tr) => tr.clips)
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
        ? clamp(
            trackIndexAtY(
              trackTops(tracks, state.trackHeightPx, new Set(state.expandedTrackIds)),
              clientY - rowsRect.top,
            ),
            0,
            tracks.length - 1,
          )
        : d.origTrackIndex;
      // A locked track refuses arrivals too, not just edits to what it holds.
      if (tracks[targetIdx]?.kind === trackKind && !tracks[targetIdx].locked) {
        targetTrackId = tracks[targetIdx].id;
      }

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
  } else if (d.mode === 'volume') {
    // Vegas volume line: the drag is relative to the press - the line never
    // jumps to the pointer. It moves in line positions, not fader units, so
    // the line keeps up with the pointer at the same rate on both sides of
    // unity. Shift = fine mode: a quarter of the travel, and the whole-dB
    // detents give way to the 0.1 dB grid for sub-dB nudges.
    const scale = shiftKey ? 0.25 : 1;
    const pos = clamp(
      faderToLinePos(d.origFader) - ((clientY - d.startY) / VOLUME_DRAG_TRAVEL_PX) * scale,
      0,
      1,
    );
    const fader = linePosToFader(pos);
    const volume = shiftKey ? faderToGain(fader) : faderToGainStepped(fader);
    state.updateClip(clip.id, { volume });
    state.setDragBadge({ clipId: clip.id, text: gainDb(volume) });
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
        // A still has no intrinsic duration: its clips stretch without bound.
        asset && asset.kind !== 'image' ? asset.durationMs : Infinity,
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
