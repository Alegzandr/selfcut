import { useState, type DragEvent } from 'react';
import { useStore } from '../../store/store';
import { msFromContentX, timelineContentEl } from '../coords';
import {
  ASSET_DRAG_MIME,
  EFFECT_DRAG_MIME,
  MARKER_BAR_HEIGHT_PX,
  PRESET_DRAG_MIME,
  RULER_HEIGHT_PX,
  TRANSITION_DRAG_MIME,
} from '../../app/config';
import { isTransitionType } from '../../effects/catalog';
import { applyPresetToClips } from '../../ui/presetActions';
import { t } from '../../i18n';
import { NEW_TRACK_TARGET } from '../../store/projectOps';
import { trackTops } from '../trackHeight';

/** True when the drag sits below the last track row: dropping there makes a new track. */
function belowTracks(e: DragEvent): boolean {
  const content = timelineContentEl(e.currentTarget as HTMLElement);
  if (!content) return false;
  const s = useStore.getState();
  const n = s.project.tracks.length;
  if (n === 0) return false;
  const totalH = trackTops(s.project.tracks, s.trackHeightPx, new Set(s.expandedTrackIds))[n]!;
  const rowsBottom =
    content.getBoundingClientRect().top + MARKER_BAR_HEIGHT_PX + RULER_HEIGHT_PX + totalH;
  return e.clientY >= rowsBottom;
}

/** The clip a catalogue drag is currently over, or null when it is over empty space. */
function clipUnder(e: DragEvent): string | null {
  return (e.target as HTMLElement).closest<HTMLElement>('[data-clip-id]')?.dataset.clipId ?? null;
}

/**
 * Drag from the media library: drop an asset at a precise time (and track), or
 * drop a catalogue entry (effect / transition) onto the clip it lands on.
 * Below the last row an asset drop creates a fresh track; `newTrackDragOver`
 * drives the placeholder row the Timeline shows there while the drag hovers it.
 */
export function useAssetDrop() {
  const [newTrackDragOver, setNewTrackDragOver] = useState(false);
  const onAssetDragOver = (e: DragEvent) => {
    const types = e.dataTransfer.types;
    if (types.includes(ASSET_DRAG_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setNewTrackDragOver(belowTracks(e));
      return;
    }
    // Catalogue entries land on a clip, never on empty timeline: refusing the
    // drop off-clip is what tells the user where they are allowed to let go.
    if (
      types.includes(EFFECT_DRAG_MIME) ||
      types.includes(TRANSITION_DRAG_MIME) ||
      types.includes(PRESET_DRAG_MIME)
    ) {
      if (!clipUnder(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
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
    const effectId = e.dataTransfer.getData(EFFECT_DRAG_MIME);
    const transition = e.dataTransfer.getData(TRANSITION_DRAG_MIME);
    const presetId = e.dataTransfer.getData(PRESET_DRAG_MIME);
    if (effectId || transition || presetId) {
      const clipId = clipUnder(e);
      if (!clipId) return;
      e.preventDefault();
      e.stopPropagation();
      const s = useStore.getState();
      if (effectId) {
        s.applyEffectPreset(effectId, [clipId]);
      } else if (presetId) {
        // The shelf is session state, so a preset can be gone by the time a drag
        // that started before an undo/reset lands. Silence would read as broken.
        const preset = s.loadedPresets.find((p) => p.id === presetId);
        if (preset) applyPresetToClips(preset.look, [clipId]);
        else s.setError(t('errors.preset.invalidFile'));
      } else if (isTransitionType(transition) && !s.applyTransition(clipId, transition)) {
        // Silent failure here would read as a broken drop: the clip has no
        // predecessor to transition from, or a gap it refuses to close.
        s.setNotice(t('library.transitions.rejected'));
      }
      return;
    }
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
