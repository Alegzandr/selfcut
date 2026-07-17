import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { clipEndMs } from '../../model';

export function createSelectionSlice(
  set: StoreSet,
  get: StoreGet,
  _helpers: SliceHelpers,
): Pick<
  EditorState,
  'selectClip' | 'selectAllClips' | 'toggleSelectClip' | 'setSelectedClips' | 'selectClipRange'
> {
  return {
    selectClip: (id) =>
      set({
        selectedClipId: id,
        selectedClipIds: id ? [id] : [],
        // Crop-edit mode is bound to one clip; any selection change ends it.
        cropEditing: false,
        ...(id === null ? { inspectorOpen: false } : {}),
      }),

    selectAllClips: () => {
      const ids = get().project.tracks.flatMap((t) => t.clips.map((c) => c.id));
      set({ selectedClipIds: ids, selectedClipId: ids[ids.length - 1] ?? null });
    },

    toggleSelectClip: (id) => {
      const ids = get().selectedClipIds.includes(id)
        ? get().selectedClipIds.filter((x) => x !== id)
        : [...get().selectedClipIds, id];
      set({
        selectedClipIds: ids,
        selectedClipId: ids[ids.length - 1] ?? null,
        ...(ids.length === 0 ? { inspectorOpen: false } : {}),
      });
    },

    setSelectedClips: (ids) =>
      set({
        selectedClipIds: ids,
        selectedClipId: ids[ids.length - 1] ?? null,
        cropEditing: false,
        ...(ids.length === 0 ? { inspectorOpen: false } : {}),
      }),

    selectClipRange: (anchorId, targetId) => {
      const tracks = get().project.tracks;
      const locate = (id: string) => {
        for (let row = 0; row < tracks.length; row++) {
          const clip = tracks[row]!.clips.find((c) => c.id === id);
          if (clip) return { row, clip };
        }
        return null;
      };
      const a = locate(anchorId);
      const b = locate(targetId);
      if (!a || !b) {
        get().selectClip(targetId);
        return;
      }
      // The rectangle spanned by the two clips: every clip on a row between them
      // whose interval touches the anchor→target time span joins the selection.
      const r0 = Math.min(a.row, b.row);
      const r1 = Math.max(a.row, b.row);
      const t0 = Math.min(a.clip.timelineStartMs, b.clip.timelineStartMs);
      const t1 = Math.max(clipEndMs(a.clip), clipEndMs(b.clip));
      const ids: string[] = [];
      for (const track of tracks.slice(r0, r1 + 1)) {
        for (const clip of track.clips) {
          if (clip.timelineStartMs < t1 && clipEndMs(clip) > t0) ids.push(clip.id);
        }
      }
      set({ selectedClipIds: ids, selectedClipId: targetId, cropEditing: false });
    },
  };
}
