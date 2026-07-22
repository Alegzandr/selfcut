/**
 * Per-property keyframe lanes shown under a track when it is expanded - one
 * thin strip per animatable property, the diamonds of every clip on the track
 * laid out on it in timeline time. Click a diamond to seek the playhead onto
 * it, Ctrl/Cmd+click to add it to the selection, or box a set of them by
 * dragging a rectangle over the lanes - the Adobe reflex of reading and
 * scrubbing an animation curve by its keys. Dragging any selected diamond
 * slides the whole set, relative spacing intact.
 *
 * Unlike the aggregate lane on the selected clip, a drag here retimes only the
 * selected keys, not every property that happens to share their time: these
 * lanes exist precisely to edit one property apart from the others.
 *
 * An empty lane still shows: it says "this property could be keyframed" instead
 * of hiding until the first key exists, which would make the row jump under the
 * pointer mid-edit.
 */
import { memo, useRef } from 'react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Clip, KeyframeProp, KeyframeRef, Track } from '../types';
import { useStore } from '../store/store';
import { formatTime } from '../lib/time';
import { KEYFRAME_LANE_HEIGHT_PX, KEYFRAME_LANES_GAP_PX, lanesHeightPx, trackLanes } from './trackHeight';
import { keyframesOf } from '../model';
import { keyframeKey, keyframeKeySet, selectionDragBounds } from './keyframeSelection';

interface Drag {
  /** The pressed diamond, for the click-without-move case. */
  ref: KeyframeRef;
  startX: number;
  /** Delta already committed to the store, so each move sends the difference. */
  appliedMs: number;
  /** Bounds of the whole selection, as a delta range around its start. */
  lo: number;
  hi: number;
  moved: boolean;
}

/** Clip-local ms of every keyframe on a property, sorted. */
function keyTimes(clip: Clip, prop: KeyframeProp): number[] {
  return (keyframesOf(clip, prop) ?? []).map((k) => k.t);
}

export const TrackKeyframeLanes = memo(function TrackKeyframeLanes({
  track,
  pxPerMs,
}: {
  track: Track;
  pxPerMs: number;
}) {
  const { t } = useTranslation();
  const padLeft = useStore((s) => s.timelinePadLeft);
  const selectedKeyframes = useStore((s) => s.selectedKeyframes);
  const selectedKeys = keyframeKeySet(selectedKeyframes);
  const drag = useRef<Drag | null>(null);
  const lanes = trackLanes(track);

  const onDown = (e: React.PointerEvent, clip: Clip, prop: KeyframeProp, time: number) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const state = useStore.getState();
    const ref: KeyframeRef = { clipId: clip.id, prop, t: time };
    // Ctrl/Cmd+click adds or removes one diamond from the box-selection without
    // starting a drag - the same reflex as Ctrl+click on a clip.
    if (e.ctrlKey || e.metaKey) {
      const key = keyframeKey(ref);
      state.setSelectedKeyframes(
        selectedKeys.has(key)
          ? selectedKeyframes.filter((k) => keyframeKey(k) !== key)
          : [...selectedKeyframes, ref],
      );
      return;
    }
    // Pressing a diamond outside the selection makes it the selection; pressing
    // one inside keeps the set, so a box-select can be dragged as a block.
    const dragging = selectedKeys.has(keyframeKey(ref)) ? selectedKeyframes : [ref];
    if (dragging.length === 1) state.setSelectedKeyframes(dragging);
    const [lo, hi] = selectionDragBounds(state.project, dragging);
    state.beginGesture();
    drag.current = { ref, startX: e.clientX, appliedMs: 0, lo, hi, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) < 4) return;
    d.moved = true;
    const target = Math.max(d.lo, Math.min(d.hi, (e.clientX - d.startX) / pxPerMs));
    useStore.getState().moveSelectedKeyframes(target - d.appliedMs);
    d.appliedMs = target;
  };
  const onUp = () => {
    const d = drag.current;
    if (!d) return;
    const state = useStore.getState();
    state.endGesture();
    // A press that never moved is a click: seek onto that key and select its clip,
    // so the inspector's easing picker and the keyframe diamonds in the clip
    // lane both pop up on the same gesture. `selectClip` clears the keyframe
    // box-selection, so the pressed diamond is re-selected after it.
    if (!d.moved) {
      const clip = track.clips.find((c) => c.id === d.ref.clipId);
      if (clip) {
        state.seek(clip.timelineStartMs + d.ref.t);
        state.selectClip(d.ref.clipId);
        state.setSelectedKeyframes([d.ref]);
      }
    }
    drag.current = null;
  };

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-10"
      style={{
        height: lanesHeightPx(lanes.length),
        paddingTop: KEYFRAME_LANES_GAP_PX,
      }}
    >
      {lanes.map((prop) => (
        <div
          key={prop}
          data-track-lane={prop}
          className="relative border-t border-zinc-800/50 bg-zinc-900/30"
          style={{ height: KEYFRAME_LANE_HEIGHT_PX }}
        >
          {track.clips.map((clip) => {
            const times = keyTimes(clip, prop);
            if (!times.length) return null;
            const propLabel = t(propLabelKey(prop));
            return times.map((time, i) => {
              const left = padLeft + (clip.timelineStartMs + time) * pxPerMs;
              const timeLabel = formatTime(clip.timelineStartMs + time);
              const selected = selectedKeys.has(keyframeKey({ clipId: clip.id, prop, t: time }));
              return (
                <button
                  // Keyed by rank, not by time: a drag retimes the key under the
                  // pointer, and a time-based key would remount the button
                  // mid-gesture - taking the pointer capture, and the drag, with
                  // it. Ranks are stable because a drag never reorders the lane.
                  key={`${clip.id}:${prop}:${i}`}
                  type="button"
                  aria-label={`${t('inspector.keyframe')} · ${propLabel} · ${timeLabel}`}
                  aria-pressed={selected}
                  title={`${propLabel} · ${timeLabel}`}
                  className={`absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] border shadow cursor-ew-resize touch-none ${
                    selected
                      ? 'scale-125 border-sky-200 bg-sky-400'
                      : 'border-zinc-900 bg-zinc-100 hover:bg-sky-200 active:bg-sky-300'
                  }`}
                  style={{ left }}
                  onPointerDown={(e) => onDown(e, clip, prop, time)}
                  onPointerMove={onMove}
                  onPointerUp={onUp}
                  onPointerCancel={onUp}
                />
              );
            });
          })}
        </div>
      ))}
    </div>
  );
});

/** Inspector i18n key for the label of a keyframable property. */
function propLabelKey(prop: KeyframeProp): ParseKeys {
  switch (prop) {
    case 'x':
      return 'inspector.positionX';
    case 'y':
      return 'inspector.positionY';
    case 'scale':
      return 'inspector.scale';
    case 'rotation':
      return 'inspector.rotation';
    case 'opacity':
      return 'inspector.opacity';
    // The colour params reuse the inspector's own Adjust labels, so a lane and
    // the slider it mirrors are named with the same word in every locale.
    default:
      return `inspector.adjust.${prop}` as ParseKeys;
  }
}
