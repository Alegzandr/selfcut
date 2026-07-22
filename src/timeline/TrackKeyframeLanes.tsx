/**
 * Per-property keyframe lanes shown under a track when it is expanded - one
 * thin strip per animatable property, the diamonds of every clip on the track
 * laid out on it in timeline time. Click a diamond to seek the playhead onto
 * it; drag one to retime the whole keyframe column at that time (matching the
 * aggregate lane on the selected clip), the Adobe reflex of reading and
 * scrubbing an animation curve by its keys. An empty lane still shows: it
 * says "this property could be keyframed" instead of hiding until the first
 * key exists, which would make the row jump under the pointer mid-edit.
 */
import { memo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatableProp, Clip, Track } from '../types';
import { useStore } from '../store/store';
import { formatTime } from '../lib/time';
import { clipDurationMs } from '../model';
import { EXPANDED_TRACK_PROPS, KEYFRAME_LANE_HEIGHT_PX, KEYFRAME_LANES_GAP_PX } from './trackHeight';

/**
 * Bounds a keyframe at clip-local `time` may be dragged between: its
 * neighbours across every property that has a key there. Mirrors
 * `ClipKeyframes` so a diamond drag in either lane obeys the same collision
 * rules the retime action would enforce anyway.
 */
function dragBounds(clip: Clip, time: number): [number, number] {
  let lo = 0;
  let hi = clipDurationMs(clip);
  for (const keys of Object.values(clip.animation ?? {})) {
    if (!keys) continue;
    const idx = keys.findIndex((k) => Math.abs(k.t - time) < 1);
    if (idx < 0) continue;
    if (idx > 0) lo = Math.max(lo, keys[idx - 1]!.t + 1);
    if (idx < keys.length - 1) hi = Math.min(hi, keys[idx + 1]!.t - 1);
  }
  return [lo, hi];
}

interface Drag {
  clipId: string;
  startX: number;
  origT: number;
  curT: number;
  lo: number;
  hi: number;
  moved: boolean;
}

/** Clip-local ms of every keyframe on `clip.animation[prop]`, sorted. */
function keyTimes(clip: Clip, prop: AnimatableProp): number[] {
  const keys = clip.animation?.[prop];
  if (!keys?.length) return [];
  return keys.map((k) => k.t);
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
  const drag = useRef<Drag | null>(null);

  const onDown = (e: React.PointerEvent, clip: Clip, time: number) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const [lo, hi] = dragBounds(clip, time);
    useStore.getState().beginGesture();
    drag.current = {
      clipId: clip.id,
      startX: e.clientX,
      origT: time,
      curT: time,
      lo,
      hi,
      moved: false,
    };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) < 4) return;
    d.moved = true;
    const newT = Math.max(d.lo, Math.min(d.hi, d.origT + (e.clientX - d.startX) / pxPerMs));
    useStore.getState().moveClipKeyframes(d.clipId, d.curT, newT);
    d.curT = newT;
  };
  const onUp = () => {
    const d = drag.current;
    if (!d) return;
    const state = useStore.getState();
    state.endGesture();
    // A press that never moved is a click: seek onto that key and select its clip,
    // so the inspector's easing picker and the keyframe diamonds in the clip
    // lane both pop up on the same gesture.
    if (!d.moved) {
      const clip = track.clips.find((c) => c.id === d.clipId);
      if (clip) {
        state.seek(clip.timelineStartMs + d.origT);
        state.selectClip(d.clipId);
      }
    }
    drag.current = null;
  };

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-10"
      style={{
        height: KEYFRAME_LANE_HEIGHT_PX * EXPANDED_TRACK_PROPS.length + KEYFRAME_LANES_GAP_PX,
        paddingTop: KEYFRAME_LANES_GAP_PX,
      }}
    >
      {EXPANDED_TRACK_PROPS.map((prop) => (
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
            return times.map((time) => {
              const left = padLeft + (clip.timelineStartMs + time) * pxPerMs;
              const timeLabel = formatTime(clip.timelineStartMs + time);
              return (
                <button
                  key={`${clip.id}:${prop}:${time}`}
                  type="button"
                  aria-label={`${t('inspector.keyframe')} · ${propLabel} · ${timeLabel}`}
                  title={`${propLabel} · ${timeLabel}`}
                  className="absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] border border-zinc-900 bg-zinc-100 shadow cursor-ew-resize touch-none hover:bg-sky-200 active:bg-sky-300"
                  style={{ left }}
                  onPointerDown={(e) => onDown(e, clip, time)}
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

/** Inspector i18n key for the label of an animatable property. */
function propLabelKey(prop: AnimatableProp) {
  switch (prop) {
    case 'x':
      return 'inspector.positionX' as const;
    case 'y':
      return 'inspector.positionY' as const;
    case 'scale':
      return 'inspector.scale' as const;
    case 'rotation':
      return 'inspector.rotation' as const;
    case 'opacity':
      return 'inspector.opacity' as const;
  }
}
