/**
 * Keyframe markers on the selected clip: a glyph at every keyframe time,
 * aggregated across the clip's animated properties - its shape spelling the
 * interpolation of the column (see `KeyframeIcon`). Drag a diamond to retime its
 * key column; a click (no drag) seeks the playhead to it — the Adobe/Vegas
 * reflex of reading, navigating and nudging an animation by its keys. Shown on
 * selection, like the fade handles, so an idle timeline stays quiet.
 */
import { memo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Clip, KeyframeProp, KeyframeRef } from '../types';
import { clipDurationMs, keyShape, type KeyShape } from '../model';
import { KeyframeIcon } from './KeyframeIcon';
import { useStore } from '../store/store';
import { formatTime } from '../lib/time';

/** One aggregated key column: a time, the properties keyed there, and its glyph. */
interface KeyColumn {
  t: number;
  props: KeyframeProp[];
  shape: KeyShape;
}

/**
 * The key columns of a clip: every distinct keyframe time across its animated
 * properties, sorted. A column's glyph is the shape its keys agree on; when a
 * scale key eases and a rotation key at the same time holds, it falls back to
 * the neutral diamond rather than picking a winner and lying about the other.
 */
function keyColumns(clip: Clip): KeyColumn[] {
  const byTime = new Map<number, KeyColumn>();
  // Transform keys only, matching `dragBounds`: this lane retimes what it shows,
  // and a colour key drawn here would be dragged by a gesture that never touches it.
  for (const [name, keys] of Object.entries(clip.animation ?? {})) {
    const prop = name as KeyframeProp;
    for (const k of keys ?? []) {
      const shape = keyShape(k);
      const col = byTime.get(k.t);
      if (!col) byTime.set(k.t, { t: k.t, props: [prop], shape });
      else {
        col.props.push(prop);
        if (col.shape !== shape) col.shape = 'diamond';
      }
    }
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
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
  const columns = keyColumns(clip);
  if (!columns.length) return null;
  const size = coarse ? 'h-4 w-4' : 'h-3 w-3';
  const glyph = coarse ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5';

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
  // Right-click on a column selects the whole column - every property keyed at
  // that instant - then opens the menu on it. Re-easing one property of a
  // column and leaving its siblings behind is never what this lane means: it is
  // the aggregate view, and it edits the aggregate.
  const onMenu = (e: React.MouseEvent, col: KeyColumn) => {
    e.preventDefault();
    e.stopPropagation();
    const refs: KeyframeRef[] = col.props.map((prop) => ({ clipId: clip.id, prop, t: col.t }));
    const state = useStore.getState();
    state.setSelectedKeyframes(refs);
    state.openContextMenu(e.clientX, e.clientY, { kind: 'keyframe', ref: refs[0]! });
  };

  return (
    // A thin lane along the clip's bottom edge; the diamonds take pointer events,
    // the lane does not, so it never blocks a clip drag.
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-3">
      {columns.map((col) => (
        <button
          key={col.t}
          type="button"
          aria-label={`${t('inspector.keyframe')} · ${formatTime(clip.timelineStartMs + col.t)}`}
          title={`${t('inspector.keyframe')} · ${formatTime(clip.timelineStartMs + col.t)}`}
          className={`group pointer-events-auto absolute bottom-0 flex -translate-x-1/2 items-center justify-center cursor-ew-resize touch-none ${size}`}
          style={{ left: col.t * pxPerMs }}
          onPointerDown={(e) => onDown(e, col.t)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onContextMenu={(e) => onMenu(e, col)}
        >
          <KeyframeIcon shape={col.shape} className={`${glyph} drop-shadow`} />
        </button>
      ))}
    </div>
  );
});
