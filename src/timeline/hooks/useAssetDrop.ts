import { useEffect, useState, type DragEvent } from 'react';
import { useStore } from '../../store/store';
import { msFromContentX, timelineContentEl } from '../coords';
import {
  ASSET_DRAG_MIME,
  EFFECT_DRAG_MIME,
  MARKER_BAR_HEIGHT_PX,
  PRESET_DRAG_MIME,
  RULER_HEIGHT_PX,
  SNAP_THRESHOLD_PX,
  TRANSITION_DRAG_MIME,
} from '../../app/config';
import { isTransitionType } from '../../effects/catalog';
import { applyPresetToClips } from '../../ui/presetActions';
import { t } from '../../i18n';
import { NEW_TRACK_TARGET, resolveTargetTrack } from '../../store/projectOps';
import { trackTops } from '../trackHeight';
import { collectSnapPoints, snapMove, snapTime } from '../snapping';
import { draggedAssetId, setDraggedAssetId } from '../dragSource';
import { useImport } from '../../ui/useImport';
import type { Track } from '../../types';

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

/** True when the drag is carrying files from outside the browser. */
function hasFiles(e: DragEvent): boolean {
  return e.dataTransfer.types.includes('Files');
}

/** The track a drop would prefer, or the new-track sentinel below the last row. */
function preferredTrackId(e: DragEvent): string | undefined {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-track-id]');
  return row?.dataset.trackId ?? (belowTracks(e) ? NEW_TRACK_TARGET : undefined);
}

/**
 * Where a drop at this pointer position would land: the track it resolves to
 * and the (snapped) instant it would start at. Both the live ghost and the drop
 * itself go through this, from the same event coordinates - which is what makes
 * the clip land exactly where the ghost promised it would.
 *
 * `durationMs` is the length of what is being dropped, or null when it is not
 * known yet (an OS file, unprobed): a known length lets the trailing edge snap
 * too, an unknown one can only pull the head.
 */
function resolveDrop(
  e: DragEvent,
  kind: Track['kind'],
  durationMs: number | null,
): { startMs: number; trackId: string | undefined; track: Track | null } {
  const s = useStore.getState();
  const content = timelineContentEl(e.currentTarget as HTMLElement);
  const trackId = preferredTrackId(e);
  const track = resolveTargetTrack(s.project, kind, trackId);
  if (!content) return { startMs: 0, trackId, track };
  const raw = Math.max(0, msFromContentX(content, e.clientX));
  if (!s.snapEnabled) return { startMs: raw, trackId, track };
  // Magnetism, like a clip drag: the dropped media grabs clip edges, markers,
  // the playhead and the origin, so a drop can build a butt cut by eye.
  const points = collectSnapPoints(s.project, [], s.currentTimeMs, s.loopRegion);
  const thresholdMs = SNAP_THRESHOLD_PX / (s.pxPerSec / 1000);
  const snapped =
    durationMs != null
      ? snapMove(raw, durationMs, points, thresholdMs)
      : snapTime(raw, points, thresholdMs);
  return { startMs: Math.max(0, snapped), trackId, track };
}

/**
 * Drag onto the timeline. Three payloads land here:
 * - a media-library asset, dropped at a precise time (and track);
 * - files from outside the browser, imported and laid down where they were let
 *   go, rather than only filling the library;
 * - a catalogue entry (effect / transition / preset), dropped onto the clip it
 *   lands on.
 *
 * Below the last row a media drop creates a fresh track; `newTrackDragOver`
 * drives the placeholder row the Timeline shows there while the drag hovers it,
 * and the store's `dropPreview` drives the ghost of the clip to come.
 */
export function useAssetDrop() {
  const [newTrackDragOver, setNewTrackDragOver] = useState(false);
  const importFiles = useImport();

  // A drag can end without ever firing `dragleave` on us - Escape, or a drop
  // caught elsewhere - and the ghost would stay painted over the timeline.
  // Capture phase: the asset drop stops propagation, which a bubble listener
  // here would never survive.
  useEffect(() => {
    const clear = () => {
      setNewTrackDragOver(false);
      setDraggedAssetId(null);
      useStore.getState().setDropPreview(null);
    };
    window.addEventListener('drop', clear, { capture: true });
    window.addEventListener('dragend', clear, { capture: true });
    return () => {
      window.removeEventListener('drop', clear, { capture: true });
      window.removeEventListener('dragend', clear, { capture: true });
      clear();
    };
  }, []);

  /** Publish the ghost for a media drag (library asset, or files from the OS). */
  const previewMedia = (e: DragEvent) => {
    const s = useStore.getState();
    // Nothing to ghost onto on an empty project: that state is one big dropzone
    // with its own invitation, and the app's import overlay stays on top of it.
    if (s.project.tracks.length === 0) return;
    const asset = draggedAssetId() ? s.assets[draggedAssetId()!] : undefined;
    // Files have no duration and no name until they are read: `items` still
    // gives their count during the drag, which is all the label needs.
    const durationMs = asset ? asset.durationMs : null;
    const kind: Track['kind'] = asset?.kind === 'audio' ? 'audio' : 'video';
    const { startMs, trackId, track } = resolveDrop(e, kind, durationMs);
    // A known asset lands on the track its kind resolves to - the same answer
    // the drop will give. An unprobed file has no kind yet, so guessing one
    // would point the line at a row the import may well not use: it follows the
    // row under the pointer instead, which is the only honest promise here.
    const previewTrackId = asset
      ? (track?.id ?? null)
      : trackId && trackId !== NEW_TRACK_TARGET
        ? trackId
        : null;
    const label = asset
      ? asset.file.name
      : t('timeline.drop.files', { count: e.dataTransfer.items.length || 1 });
    s.setDropPreview({ startMs, durationMs, trackId: previewTrackId, label });
  };

  const onAssetDragOver = (e: DragEvent) => {
    const types = e.dataTransfer.types;
    if (types.includes(ASSET_DRAG_MIME) || hasFiles(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setNewTrackDragOver(belowTracks(e));
      previewMedia(e);
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
      useStore.getState().setDropPreview(null);
    }
  };

  const onAssetDrop = (e: DragEvent) => {
    setNewTrackDragOver(false);
    const s = useStore.getState();
    s.setDropPreview(null);
    const effectId = e.dataTransfer.getData(EFFECT_DRAG_MIME);
    const transition = e.dataTransfer.getData(TRANSITION_DRAG_MIME);
    const presetId = e.dataTransfer.getData(PRESET_DRAG_MIME);
    if (effectId || transition || presetId) {
      const clipId = clipUnder(e);
      if (!clipId) return;
      e.preventDefault();
      e.stopPropagation();
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
    if (assetId) {
      const asset = s.assets[assetId];
      if (!asset) return;
      e.preventDefault();
      e.stopPropagation();
      const { startMs, trackId } = resolveDrop(
        e,
        asset.kind === 'audio' ? 'audio' : 'video',
        asset.durationMs,
      );
      s.addClipFromAssetAt(assetId, startMs, trackId);
      return;
    }
    // Files from outside the browser: import them AND lay them down here, in
    // one go. `preventDefault` alone (no stopPropagation) is what tells the
    // app-level dropzone this drop is already spoken for - it still gets the
    // event, so its overlay closes on its own.
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    const { startMs, trackId } = resolveDrop(e, 'video', null);
    void importFiles(e.dataTransfer.files, {
      placeOnTimeline: true,
      at: { ms: startMs, trackId },
    });
  };

  return { onAssetDragOver, onAssetDragLeave, onAssetDrop, newTrackDragOver };
}
