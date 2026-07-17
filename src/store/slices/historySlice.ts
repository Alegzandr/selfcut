import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import { resolveOverlaps } from '../projectOps';
import { HISTORY_LIMIT } from '../constants';

export function createHistorySlice(
  set: StoreSet,
  get: StoreGet,
  _helpers: SliceHelpers,
): Pick<EditorState, 'beginGesture' | 'endGesture' | 'cancelGesture' | 'undo' | 'redo'> {
  return {
    beginGesture: () => set({ gestureSnapshot: get().project }),

    cancelGesture: () => {
      const snap = get().gestureSnapshot;
      if (snap) set({ project: snap, gestureSnapshot: null });
    },

    endGesture: () => {
      // Settle any illegal overlap created during the gesture (drag/trim);
      // legal pairwise overlaps are kept - they are crossfades.
      const settled = resolveOverlaps(get().project, get().selectedClipId);
      if (settled !== get().project) set({ project: settled });
      const { gestureSnapshot, project, past } = get();
      if (gestureSnapshot && gestureSnapshot !== project) {
        set({
          past: [...past, gestureSnapshot].slice(-HISTORY_LIMIT),
          future: [],
          gestureSnapshot: null,
        });
      } else {
        set({ gestureSnapshot: null });
      }
    },

    undo: () => {
      const { past, future, project } = get();
      if (past.length === 0) return;
      const prev = past[past.length - 1];
      set({
        project: prev,
        past: past.slice(0, -1),
        future: [project, ...future],
        selectedClipId: null,
        selectedClipIds: [],
        inspectorOpen: false,
      });
    },

    redo: () => {
      const { past, future, project } = get();
      if (future.length === 0) return;
      const next = future[0];
      set({
        project: next,
        past: [...past, project].slice(-HISTORY_LIMIT),
        future: future.slice(1),
        selectedClipId: null,
        selectedClipIds: [],
        inspectorOpen: false,
      });
    },
  };
}
