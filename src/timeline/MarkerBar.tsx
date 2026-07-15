import { memo, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/store';
import { Tooltip } from '../ui/Tooltip';
import { Marker } from '../types';
import { collectSnapPoints, snapTime } from './snapping';
import { msFromClientX } from './coords';
import {
  MARKER_BAR_HEIGHT_PX,
  RULER_HEIGHT_PX,
  SNAP_THRESHOLD_PX,
  TRACK_HEIGHT_PX,
} from '../app/config';
import { hapticOnSnap } from '../lib/haptics';

/** Timeline ms under a client X, clamped to the origin (the bar has no negative time). */
function markerMsFromClientX(el: HTMLElement, clientX: number): number {
  return Math.max(0, msFromClientX(el, clientX));
}

interface RegionDrag {
  kind: 'region';
  /** The edge that stays put (the other one follows the pointer). */
  anchorMs: number;
  startX: number;
  moved: boolean;
  points: number[];
  lastSnap: number | null;
}

interface MarkerDrag {
  kind: 'marker';
  id: string;
  startX: number;
  moved: boolean;
  points: number[];
  lastSnap: number | null;
}

type Drag = RegionDrag | MarkerDrag;

/**
 * Vegas-style bar above the ruler: drag it to carve a loop region (the yellow
 * corners), and hold the timeline's markers. The region is session state - it
 * drives loop playback and can restrict the export - while markers are project
 * data (undoable, saved).
 */
export const MarkerBar = memo(function MarkerBar({ pxPerMs }: { pxPerMs: number }) {
  const { t } = useTranslation();
  const padLeft = useStore((s) => s.timelinePadLeft);
  const region = useStore((s) => s.loopRegion);
  const loopEnabled = useStore((s) => s.loopEnabled);
  // Subscribe to the markers only (not the whole project): a clip drag must not
  // re-render + re-sort the marker bar on every frame.
  const markerList = useStore((s) => s.project.markers);
  const [editing, setEditing] = useState<Marker | null>(null);
  const drag = useRef<Drag | null>(null);

  const markers = useMemo(() => [...markerList].sort((a, b) => a.timeMs - b.timeMs), [markerList]);
  const xOf = (ms: number) => padLeft + ms * pxPerMs;

  /** Snap points, minus the position the drag currently owns (it must not stick to itself). */
  const snapPointsExcept = (ownMs: number | null): number[] => {
    const s = useStore.getState();
    const points = collectSnapPoints(s.project, [], s.currentTimeMs, s.loopRegion);
    return ownMs === null ? points : points.filter((p) => Math.abs(p - ownMs) > 0.5);
  };

  const snapped = (e: React.PointerEvent, d: Drag): number => {
    const s = useStore.getState();
    const thresholdMs = e.altKey ? 0 : SNAP_THRESHOLD_PX / (s.pxPerSec / 1000);
    const raw = markerMsFromClientX(e.currentTarget as HTMLElement, e.clientX);
    return hapticOnSnap(raw, snapTime(raw, d.points, thresholdMs), d);
  };

  // Empty bar: start a fresh region. A press that never moves is a plain click - it clears it.
  const onBarPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const anchorMs = markerMsFromClientX(el, e.clientX);
    drag.current = {
      kind: 'region',
      anchorMs,
      startX: e.clientX,
      moved: false,
      points: snapPointsExcept(null),
      lastSnap: null,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) < 3) return;
    d.moved = true;
    const s = useStore.getState();
    const at = snapped(e, d);
    if (d.kind === 'region') s.setLoopRegion({ startMs: d.anchorMs, endMs: at });
    else s.moveMarker(d.id, at);
  };

  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const s = useStore.getState();
    if (d.kind === 'marker') {
      s.endGesture();
      // A marker pressed but not dragged is a cue: jump to it.
      if (!d.moved) s.seek(s.project.markers.find((m) => m.id === d.id)?.timeMs ?? s.currentTimeMs);
      return;
    }
    // A press on the bar that never moved is a click: it clears the selection.
    if (!d.moved) s.setLoopRegion(null);
  };

  // Region handles ("yellow corners"): drag one edge, the opposite one anchors.
  const onHandlePointerDown = (e: React.PointerEvent, edge: 'in' | 'out') => {
    if (!region || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = {
      kind: 'region',
      anchorMs: edge === 'in' ? region.endMs : region.startMs,
      startX: e.clientX,
      moved: false,
      // The dragged edge must not snap onto itself; the opposite one is fine.
      points: snapPointsExcept(edge === 'in' ? region.startMs : region.endMs),
      lastSnap: null,
    };
  };

  const onMarkerPointerDown = (e: React.PointerEvent, marker: Marker) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    useStore.getState().beginGesture();
    drag.current = {
      kind: 'marker',
      id: marker.id,
      startX: e.clientX,
      moved: false,
      points: snapPointsExcept(marker.timeMs),
      lastSnap: null,
    };
  };

  const commitRename = (value: string) => {
    if (editing) useStore.getState().renameMarker(editing.id, value.trim());
    setEditing(null);
  };

  const handle = 'absolute inset-y-0 w-2.5 cursor-ew-resize touch-none bg-amber-400';

  return (
    <div
      data-marker-bar
      className="sticky top-0 z-20 touch-none border-b border-zinc-800 bg-zinc-900"
      style={{ height: MARKER_BAR_HEIGHT_PX }}
      title={t('marker.barHint')}
      onPointerDown={onBarPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {region && (
        <>
          <div
            className={`absolute inset-y-0 ${loopEnabled ? 'bg-amber-400/35' : 'bg-amber-400/20'}`}
            style={{ left: xOf(region.startMs), width: Math.max(1, (region.endMs - region.startMs) * pxPerMs) }}
          />
          <Tooltip label={t('marker.regionIn')}>
            <div
              className={`${handle} rounded-l-sm`}
              style={{ left: xOf(region.startMs) }}
              onPointerDown={(e) => onHandlePointerDown(e, 'in')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </Tooltip>
          <Tooltip label={t('marker.regionOut')}>
            <div
              className={`${handle} rounded-r-sm`}
              style={{ left: xOf(region.endMs) - 10 }}
              onPointerDown={(e) => onHandlePointerDown(e, 'out')}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />
          </Tooltip>
        </>
      )}

      {markers.map((marker, i) => (
        <Tooltip
          key={marker.id}
          label={
            marker.label
              ? t('marker.titleLabeled', { n: i + 1, label: marker.label })
              : t('marker.title', { n: i + 1 })
          }
        >
          <div
            className="absolute top-0 z-10 flex h-full max-w-[160px] cursor-grab touch-none items-center gap-1 rounded-r-sm border-l-2 border-cyan-400 bg-cyan-500/25 pl-1 pr-1.5 text-[10px] leading-none text-cyan-100 active:cursor-grabbing"
            style={{ left: xOf(marker.timeMs) }}
            onPointerDown={(e) => onMarkerPointerDown(e, marker)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(marker);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              useStore.getState().removeMarker(marker.id);
            }}
          >
            <span className="truncate">{marker.label || i + 1}</span>
          </div>
        </Tooltip>
      ))}

      {editing && (
        <input
          autoFocus
          defaultValue={editing.label}
          placeholder={t('marker.placeholder', {
            n: markers.findIndex((m) => m.id === editing.id) + 1,
          })}
          className="absolute top-0 z-20 h-full w-32 rounded-sm border border-cyan-400 bg-zinc-950 px-1 text-[10px] text-cyan-100 outline-none"
          style={{ left: xOf(editing.timeMs) }}
          onPointerDown={(e) => e.stopPropagation()}
          onBlur={(e) => commitRename(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value);
            else if (e.key === 'Escape') setEditing(null);
          }}
        />
      )}
    </div>
  );
});

/**
 * Region shading and marker lines drawn across the tracks. Purely decorative
 * (pointer-events-none) - every interaction lives in the bar above.
 */
export const TimelineOverlay = memo(function TimelineOverlay({
  pxPerMs,
  trackCount,
}: {
  pxPerMs: number;
  trackCount: number;
}) {
  const padLeft = useStore((s) => s.timelinePadLeft);
  const region = useStore((s) => s.loopRegion);
  const markers = useStore((s) => s.project.markers);

  return (
    <div
      className="pointer-events-none absolute inset-x-0"
      style={{ top: MARKER_BAR_HEIGHT_PX + RULER_HEIGHT_PX, height: trackCount * TRACK_HEIGHT_PX }}
    >
      {region && (
        <div
          className="absolute inset-y-0 border-x border-amber-400/70 bg-amber-300/[0.06]"
          style={{
            left: padLeft + region.startMs * pxPerMs,
            width: Math.max(1, (region.endMs - region.startMs) * pxPerMs),
          }}
        />
      )}
      {markers.map((marker) => (
        <div
          key={marker.id}
          className="absolute inset-y-0 w-px bg-cyan-400/40"
          style={{ left: padLeft + marker.timeMs * pxPerMs }}
        />
      ))}
    </div>
  );
});
