import { memo, useRef } from 'react';
import { Music } from 'lucide-react';
import { Clip, clipDurationMs } from '../types';
import { useStore } from '../store/store';
import { collectSnapPoints, snapMove, snapTime } from './snapping';
import { SNAP_THRESHOLD_PX, TIMELINE_PAD_LEFT, TRACK_HEIGHT_PX } from '../app/config';
import { clamp } from '../lib/time';

interface DragState {
  mode: 'move' | 'trim-left' | 'trim-right';
  startX: number;
  startY: number;
  origStartMs: number;
  durMs: number;
  origTrackIndex: number;
  points: number[];
  moved: boolean;
}

interface Props {
  clip: Clip;
  trackKind: 'video' | 'audio';
  selected: boolean;
  pxPerMs: number;
}

export const ClipView = memo(function ClipView({ clip, trackKind, selected, pxPerMs }: Props) {
  const asset = useStore((s) => s.assets[clip.assetId]);
  const drag = useRef<DragState | null>(null);

  const durMs = clipDurationMs(clip);
  const left = TIMELINE_PAD_LEFT + clip.timelineStartMs * pxPerMs;
  const width = Math.max(6, durMs * pxPerMs);

  const contentOf = (el: HTMLElement) =>
    el.closest('[data-timeline-content]') as HTMLElement;

  const beginDrag = (e: React.PointerEvent, mode: DragState['mode']) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const state = useStore.getState();
    state.selectClip(clip.id);
    state.beginGesture();
    drag.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origStartMs: clip.timelineStartMs,
      durMs,
      origTrackIndex: state.project.tracks.findIndex((t) => t.id === clip.trackId),
      points: collectSnapPoints(state.project, clip.id, state.currentTimeMs),
      moved: false,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    d.moved = true;

    const state = useStore.getState();
    const pxMs = state.pxPerSec / 1000;
    const snapThresholdMs = SNAP_THRESHOLD_PX / pxMs;

    if (d.mode === 'move') {
      let proposed = d.origStartMs + dx / pxMs;
      proposed = snapMove(proposed, d.durMs, d.points, snapThresholdMs);
      proposed = Math.max(0, proposed);

      let targetTrackId: string | undefined;
      const tracks = state.project.tracks;
      const deltaRows = Math.round(dy / TRACK_HEIGHT_PX);
      const targetIdx = clamp(d.origTrackIndex + deltaRows, 0, tracks.length - 1);
      if (tracks[targetIdx]?.kind === trackKind) targetTrackId = tracks[targetIdx].id;

      state.moveClip(clip.id, proposed, targetTrackId);
    } else {
      const rect = contentOf(e.currentTarget as HTMLElement).getBoundingClientRect();
      const contentX = e.clientX - rect.left;
      let tMs = (contentX - TIMELINE_PAD_LEFT) / pxMs;
      tMs = snapTime(tMs, d.points, snapThresholdMs);
      state.trimClip(clip.id, d.mode === 'trim-left' ? 'left' : 'right', tMs);
    }
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    useStore.getState().endGesture();
    drag.current = null;
  };

  const isVideo = trackKind === 'video';
  const border = selected
    ? 'ring-2 ring-sky-400 border-transparent'
    : isVideo
      ? 'border-sky-900'
      : 'border-emerald-900';

  return (
    <div
      className={`absolute top-1 bottom-1 touch-none overflow-hidden rounded-md border ${border} ${isVideo ? 'bg-sky-950' : 'bg-emerald-950'}`}
      style={{ left, width }}
      onPointerDown={(e) => beginDrag(e, 'move')}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {isVideo && asset?.thumbnails.length ? (
        <div className="pointer-events-none flex h-full w-full">
          {asset.thumbnails.map((src, i) => (
            <img key={i} src={src} className="h-full min-w-0 flex-1 object-cover" alt="" draggable={false} />
          ))}
        </div>
      ) : (
        <div className="pointer-events-none flex h-full items-center gap-1.5 bg-gradient-to-b from-emerald-900/60 to-emerald-950 px-2">
          <Music className="h-3.5 w-3.5 flex-none text-emerald-300" />
          <span className="truncate text-[10px] text-emerald-100">{asset?.file.name}</span>
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

      {/* Trim handles */}
      <div
        className={`absolute inset-y-0 left-0 w-3 cursor-ew-resize touch-none ${selected ? 'bg-sky-400/70' : 'bg-white/10'}`}
        onPointerDown={(e) => beginDrag(e, 'trim-left')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div
        className={`absolute inset-y-0 right-0 w-3 cursor-ew-resize touch-none ${selected ? 'bg-sky-400/70' : 'bg-white/10'}`}
        onPointerDown={(e) => beginDrag(e, 'trim-right')}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      {/* Fade indicators */}
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
    </div>
  );
});
