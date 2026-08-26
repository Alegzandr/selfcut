import { useStore } from '../store/store';
import { MARKER_BAR_HEIGHT_PX, RULER_HEIGHT_PX } from '../app/config';
import { trackTops } from './trackHeight';

/**
 * Footprint of the drag currently hovering the timeline: the room the clip
 * would take, on the row it would take it, at the instant it would start - the
 * preview every NLE draws before you let go.
 *
 * Its own component, subscribed straight to the store, so the position updates
 * on every `dragover` without re-rendering the ruler and every track row along
 * with it.
 *
 * A file dragged in from the desktop has no duration until it is probed, so
 * there is no width to draw: it degrades to an insertion line at the instant it
 * would land, which promises only what is actually known.
 */
export function DropGhost({ pxPerMs }: { pxPerMs: number }) {
  const preview = useStore((s) => s.dropPreview);
  const tracks = useStore((s) => s.project.tracks);
  const padLeft = useStore((s) => s.timelinePadLeft);
  const baseHeightPx = useStore((s) => s.trackHeightPx);
  const expandedTrackIds = useStore((s) => s.expandedTrackIds);
  if (!preview || tracks.length === 0) return null;

  const tops = trackTops(tracks, baseHeightPx, new Set(expandedTrackIds));
  const index = preview.trackId ? tracks.findIndex((t) => t.id === preview.trackId) : -1;
  // A drop that would create a track ghosts on the placeholder row the Timeline
  // opens below the last one, which sits exactly at the total height.
  const top = MARKER_BAR_HEIGHT_PX + RULER_HEIGHT_PX + (index === -1 ? tops.at(-1)! : tops[index]!);
  const left = padLeft + preview.startMs * pxPerMs;
  // The clip band keeps the base height even on an expanded row: that is the
  // part of the row a clip actually occupies.
  const style = { top, left, height: baseHeightPx } as const;

  if (preview.durationMs === null) {
    return (
      <div className="pointer-events-none absolute z-20 flex items-start" style={style}>
        <div className="h-full w-0.5 rounded-full bg-brand-400" />
        <span className="ml-1 mt-1 whitespace-nowrap rounded bg-brand-700/90 px-1.5 py-0.5 text-3xs font-medium text-white shadow">
          {preview.label}
        </span>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none absolute z-20 overflow-hidden rounded-md border-2 border-dashed border-brand-400 bg-brand-400/20"
      style={{ ...style, width: Math.max(2, preview.durationMs * pxPerMs) }}
    >
      <span className="absolute inset-x-0 top-1 truncate px-1.5 text-3xs font-medium text-brand-100">
        {preview.label}
      </span>
    </div>
  );
}
