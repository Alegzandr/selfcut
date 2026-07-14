import { memo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Music, Type } from 'lucide-react';
import { Clip, MediaAsset, clipDurationMs } from '../types';
import { useStore } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { collectSnapPoints, snapMove, snapTime } from './snapping';
import { msFromClientX, msFromContentX, timelineContentEl } from './coords';
import { SNAP_THRESHOLD_PX, TRACK_HEIGHT_PX } from '../app/config';
import { clamp } from '../lib/time';
import { useIsCoarsePointer } from '../lib/device';
import { hapticOnSnap } from '../lib/haptics';
import { Waveform } from './Waveform';

interface DragState {
  mode: 'move' | 'trim-left' | 'trim-right' | 'fade-in' | 'fade-out';
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
}

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

  const durMs = clipDurationMs(clip);
  const left = padLeft + clip.timelineStartMs * pxPerMs;
  const width = Math.max(6, durMs * pxPerMs);

  const beginDrag = (e: React.PointerEvent, mode: DragState['mode']) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Mobile (CapCut-style): an unselected clip lets the timeline scroll; tap selects it
    // (via onClick), and only a selected clip can be dragged.
    if (coarse && !selected) return;
    e.stopPropagation();
    const state = useStore.getState();
    // Ctrl/Cmd+click (desktop): toggle membership in the multi-selection, no drag.
    if (!coarse && (e.ctrlKey || e.metaKey) && mode === 'move') {
      state.toggleSelectClip(clip.id);
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Dragging a clip that belongs to a multi-selection moves the whole group.
    const multi =
      mode === 'move' && state.selectedClipIds.length > 1 && state.selectedClipIds.includes(clip.id);
    if (!multi) state.selectClip(clip.id);
    state.beginGesture();
    const groupIds = multi ? state.selectedClipIds : [clip.id];
    const groupStarts = new Map<string, number>();
    for (const t of state.project.tracks) {
      for (const c of t.clips) {
        if (groupIds.includes(c.id)) groupStarts.set(c.id, c.timelineStartMs);
      }
    }
    // Time under the pointer at press: a plain click (no drag) on a clip moves
    // the playhead there, like a classic NLE.
    const contentEl = timelineContentEl(e.currentTarget as HTMLElement);
    const downMs = contentEl ? msFromContentX(contentEl, e.clientX) : clip.timelineStartMs;
    drag.current = {
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origStartMs: clip.timelineStartMs,
      durMs,
      origTrackIndex: state.project.tracks.findIndex((t) => t.id === clip.trackId),
      points: collectSnapPoints(state.project, groupIds, state.currentTimeMs, state.loopRegion),
      moved: false,
      lastSnap: null,
      groupStarts,
      downMs,
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
    // N toggles snapping globally; holding Shift (or Alt) inverts it for the current drag.
    const snapActive = e.shiftKey || e.altKey ? !state.snapEnabled : state.snapEnabled;
    const snapThresholdMs = snapActive ? SNAP_THRESHOLD_PX / pxMs : 0;

    if (d.mode === 'move') {
      const raw = d.origStartMs + dx / pxMs;
      let proposed = hapticOnSnap(raw, snapMove(raw, d.durMs, d.points, snapThresholdMs), d);
      proposed = Math.max(0, proposed);

      if (d.groupStarts.size > 1) {
        // Group drag: same delta for everyone, clamped so no clip crosses t=0.
        let delta = proposed - d.origStartMs;
        const minStart = Math.min(...d.groupStarts.values());
        delta = Math.max(delta, -minStart);
        state.moveClips(
          [...d.groupStarts].map(([clipId, orig]) => ({ clipId, timelineStartMs: orig + delta })),
        );
      } else {
        let targetTrackId: string | undefined;
        const tracks = state.project.tracks;
        const deltaRows = Math.round(dy / TRACK_HEIGHT_PX);
        const targetIdx = clamp(d.origTrackIndex + deltaRows, 0, tracks.length - 1);
        if (tracks[targetIdx]?.kind === trackKind) targetTrackId = tracks[targetIdx].id;

        state.moveClip(clip.id, proposed, targetTrackId);
      }
    } else if (d.mode === 'fade-in' || d.mode === 'fade-out') {
      // Fade handles: drag inward from a clip edge to fade from/to black (and silence).
      const tMs = msFromClientX(e.currentTarget as HTMLElement, e.clientX);
      if (d.mode === 'fade-in') {
        const v = Math.round(clamp(tMs - d.origStartMs, 0, d.durMs) / 10) * 10;
        state.updateClip(clip.id, { fadeInMs: v });
      } else {
        const v = Math.round(clamp(d.origStartMs + d.durMs - tMs, 0, d.durMs) / 10) * 10;
        state.updateClip(clip.id, { fadeOutMs: v });
      }
    } else {
      const raw = msFromClientX(e.currentTarget as HTMLElement, e.clientX);
      const tMs = hapticOnSnap(raw, snapTime(raw, d.points, snapThresholdMs), d);
      state.trimClip(clip.id, d.mode === 'trim-left' ? 'left' : 'right', tMs);
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    const state = useStore.getState();
    state.endGesture();
    // A click on a clip that didn't turn into a drag moves the playhead there.
    if (!coarse && !d.moved && d.mode === 'move') state.seek(Math.max(0, d.downMs));
    drag.current = null;
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
    >
      {clip.text ? (
        <div className="pointer-events-none flex h-full w-full items-center gap-1 bg-gradient-to-b from-violet-900/60 to-violet-950 px-1.5">
          <Type className="h-3 w-3 flex-none text-violet-300" />
          <span className="truncate text-[11px] font-medium text-violet-100">
            {clip.text.content.split('\n')[0] || t('clip.text.placeholder')}
          </span>
        </div>
      ) : clip.solid ? (
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
          {asset.peaks && (
            <div className="absolute inset-x-0 bottom-0 h-1/3 bg-black/40">
              <Waveform asset={asset} clip={clip} widthPx={width} color="rgba(255,255,255,0.85)" />
            </div>
          )}
        </div>
      ) : (
        <div className="pointer-events-none relative h-full w-full bg-gradient-to-b from-emerald-900/60 to-emerald-950">
          {asset?.peaks && (
            <div className="absolute inset-0">
              <Waveform asset={asset} clip={clip} widthPx={width} color="rgba(110,231,183,0.65)" />
            </div>
          )}
          <div className="absolute left-0 top-0 flex max-w-full items-center gap-1 px-1.5 py-0.5">
            <Music className="h-3 w-3 flex-none text-emerald-300" />
            <span className="truncate text-[10px] text-emerald-100">{asset?.file.name}</span>
          </div>
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
