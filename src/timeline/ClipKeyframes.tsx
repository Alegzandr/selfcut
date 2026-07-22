/**
 * Keyframe markers on the selected clip: a diamond at every keyframe time,
 * aggregated across the clip's animated properties. Drag a diamond to retime its
 * key column; a click (no drag) seeks the playhead to it — the Adobe/Vegas
 * reflex of reading, navigating and nudging an animation by its keys. Shown on
 * selection, like the fade handles, so an idle timeline stays quiet.
 */
import { memo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Clip } from '../types';
import { clipDurationMs } from '../model';
import { useStore } from '../store/store';
import { formatTime } from '../lib/time';

/** Unique keyframe times (clip-local ms) across every animated property of a clip. */
function keyframeTimes(clip: Clip): number[] {
  const anim = clip.animation;
  if (!anim) return [];
  const set = new Set<number>();
  for (const keys of Object.values(anim)) {
    if (keys) for (const k of keys) set.add(k.t);
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * How far the key at `time` may be dragged: between its neighbours across every
 * property that has a key there, so a drag can never make two keys collide.
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
  startX: number;
  origT: number;
  curT: number;
  lo: number;
  hi: number;
  moved: boolean;
}

export const ClipKeyframes = memo(function ClipKeyframes({
  clip,
  pxPerMs,
  coarse,
}: {
  clip: Clip;
  pxPerMs: number;
  coarse: boolean;
}) {
  const { t } = useTranslation();
  const drag = useRef<Drag | null>(null);
  const times = keyframeTimes(clip);
  if (!times.length) return null;
  const size = coarse ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5';

  const onDown = (e: React.PointerEvent, time: number) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const [lo, hi] = dragBounds(clip, time);
    useStore.getState().beginGesture();
    drag.current = { startX: e.clientX, origT: time, curT: time, lo, hi, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) < 4) return;
    d.moved = true;
    const newT = Math.max(d.lo, Math.min(d.hi, d.origT + (e.clientX - d.startX) / pxPerMs));
    useStore.getState().moveClipKeyframes(clip.id, d.curT, newT);
    d.curT = newT;
  };
  const onUp = () => {
    const d = drag.current;
    if (!d) return;
    useStore.getState().endGesture();
    // A press that never moved is a click: seek to the key instead.
    if (!d.moved) useStore.getState().seek(clip.timelineStartMs + d.origT);
    drag.current = null;
  };

  return (
    // A thin lane along the clip's bottom edge; the diamonds take pointer events,
    // the lane does not, so it never blocks a clip drag.
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-3">
      {times.map((time) => (
        <button
          key={time}
          type="button"
          aria-label={`${t('inspector.keyframe')} · ${formatTime(clip.timelineStartMs + time)}`}
          title={`${t('inspector.keyframe')} · ${formatTime(clip.timelineStartMs + time)}`}
          className={`pointer-events-auto absolute bottom-0.5 -translate-x-1/2 rotate-45 rounded-[1px] border border-zinc-900 bg-zinc-100 shadow cursor-ew-resize touch-none active:bg-sky-300 ${size}`}
          style={{ left: time * pxPerMs }}
          onPointerDown={(e) => onDown(e, time)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
      ))}
    </div>
  );
});
