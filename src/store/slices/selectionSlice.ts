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
  /**
   * The single gate a locked track needs: every edit path (delete, nudge, drag,
   * clipboard, trim) runs off the selection, so refusing to select a locked
   * clip protects it everywhere without a check in each operation.
   */
  const selectable = (ids: string[]): string[] => {
    const locked = new Set<string>();
    for (const track of get().project.tracks) {
      if (track.locked) for (const clip of track.clips) locked.add(clip.id);
    }
    return locked.size === 0 ? ids : ids.filter((id) => !locked.has(id));
  };

  return {
    selectClip: (id) => {
      const ids = id ? selectable([id]) : [];
      set({
        selectedClipId: ids[0] ?? null,
        selectedClipIds: ids,
        // Crop-edit mode is bound to one clip; any selection change ends it.
        cropEditing: false,
        ...(ids.length === 0 ? { inspectorOpen: false } : {}),
      });
    },

    selectAllClips: () => {
      const ids = selectable(get().project.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      set({ selectedClipIds: ids, selectedClipId: ids[ids.length - 1] ?? null });
    },

    toggleSelectClip: (id) => {
      if (selectable([id]).length === 0) return;
      const ids = get().selectedClipIds.includes(id)
        ? get().selectedClipIds.filter((x) => x !== id)
        : [...get().selectedClipIds, id];
      set({
        selectedClipIds: ids,
        selectedClipId: ids[ids.length - 1] ?? null,
        ...(ids.length === 0 ? { inspectorOpen: false } : {}),
      });
    },

    setSelectedClips: (raw) => {
      const ids = selectable(raw);
      set({
        selectedClipIds: ids,
        selectedClipId: ids[ids.length - 1] ?? null,
        cropEditing: false,
        ...(ids.length === 0 ? { inspectorOpen: false } : {}),
      });
    },

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
      const hits: string[] = [];
      for (const track of tracks.slice(r0, r1 + 1)) {
        for (const clip of track.clips) {
          if (clip.timelineStartMs < t1 && clipEndMs(clip) > t0) hits.push(clip.id);
        }
      }
      const ids = selectable(hits);
      set({
        selectedClipIds: ids,
        selectedClipId: ids.includes(targetId) ? targetId : (ids[ids.length - 1] ?? null),
        cropEditing: false,
      });
    },
  };
}
