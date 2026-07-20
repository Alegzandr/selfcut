import { useState, type DragEvent } from 'react';
import { useStore } from '../../store/store';
import { msFromContentX, timelineContentEl } from '../coords';
import { ASSET_DRAG_MIME, MARKER_BAR_HEIGHT_PX, RULER_HEIGHT_PX } from '../../app/config';
import { NEW_TRACK_TARGET } from '../../store/projectOps';

/** True when the drag sits below the last track row: dropping there makes a new track. */
function belowTracks(e: DragEvent): boolean {
  const content = timelineContentEl(e.currentTarget as HTMLElement);
  if (!content) return false;
  const s = useStore.getState();
  const n = s.project.tracks.length;
  if (n === 0) return false;
  const rowsBottom =
    content.getBoundingClientRect().top +
    MARKER_BAR_HEIGHT_PX +
    RULER_HEIGHT_PX +
    n * s.trackHeightPx;
  return e.clientY >= rowsBottom;
}

/**
 * Drag from the media library: drop an asset at a precise time (and track).
 * Below the last row the drop creates a fresh track; `newTrackDragOver` drives
 * the placeholder row the Timeline shows there while the drag hovers it.
 */
export function useAssetDrop() {
  const [newTrackDragOver, setNewTrackDragOver] = useState(false);
  const onAssetDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(ASSET_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setNewTrackDragOver(belowTracks(e));
    }
  };
  const onAssetDragLeave = (e: DragEvent) => {
    // Only when the drag exits the whole surface, not when crossing children.
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
      setNewTrackDragOver(false);
    }
  };
  const onAssetDrop = (e: DragEvent) => {
    setNewTrackDragOver(false);
    const assetId = e.dataTransfer.getData(ASSET_DRAG_MIME);
    if (!assetId) return;
    e.preventDefault();
    e.stopPropagation();
    const s = useStore.getState();
    const content = timelineContentEl(e.currentTarget as HTMLElement);
    if (!content) {
      s.addClipFromAssetAt(assetId, 0);
      return;
    }
    const ms = msFromContentX(content, e.clientX);
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-track-id]');
    const trackId = row?.dataset.trackId ?? (belowTracks(e) ? NEW_TRACK_TARGET : undefined);
    s.addClipFromAssetAt(assetId, ms, trackId);
  };

  return { onAssetDragOver, onAssetDragLeave, onAssetDrop, newTrackDragOver };
}
