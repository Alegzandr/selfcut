import type { StoreSet, StoreGet, SliceHelpers } from '../sliceHelpers';
import type { EditorState } from '../editorState';
import type { Project } from '../../types';
import { produce } from 'immer';
import { findComp, syncCompClips } from '../../model';
import { resolveOverlaps } from '../projectOps';
import { disposeUnreachableAssets, reviveAssets } from '../assetLifecycle';
import { announce } from '../../lib/a11yBus';
import { HISTORY_LIMIT } from '../constants';

/**
 * The composition the editor may keep standing in across a history step: the one
 * it is in, when that project version still has it, and the root otherwise.
 */
function standingIn(state: EditorState, project: Project): string | null {
  const compId = state.activeCompId;
  if (compId === null) return null;
  return findComp(project, compId) ? compId : null;
}

export function createHistorySlice(
  set: StoreSet,
  get: StoreGet,
  _helpers: SliceHelpers,
): Pick<EditorState, 'beginGesture' | 'endGesture' | 'cancelGesture' | 'undo' | 'redo'> {
  return {
    beginGesture: () => {
      // A gesture already open keeps its snapshot: overwriting it would fold
      // the edits made so far into the "before" state and lose them to undo.
      if (get().gestureSnapshot) return;
      set({ gestureSnapshot: { project: get().project, assets: get().assets } });
    },

    cancelGesture: () => {
      const snap = get().gestureSnapshot;
      if (snap)
        set({
          project: snap.project,
          assets: reviveAssets(snap.assets, get().assets),
          gestureSnapshot: null,
        });
    },

    endGesture: () => {
      // Gesture steps write the project directly, bypassing `withHistory`, so
      // the clips playing a composition edited during the gesture are retimed
      // here, against the project as it was when the gesture began.
      const snap = get().gestureSnapshot;
      const live = get().project;
      const synced =
        snap && snap.project !== live
          ? produce(live, (draft) => syncCompClips(snap.project, draft))
          : live;
      // Settle any illegal overlap created during the gesture (drag/trim);
      // legal pairwise overlaps are kept - they are crossfades.
      const settled = resolveOverlaps(synced, get().selectedClipId);
      if (settled !== get().project) set({ project: settled });
      const { gestureSnapshot, project, assets, past } = get();
      if (
        gestureSnapshot &&
        (gestureSnapshot.project !== project || gestureSnapshot.assets !== assets)
      ) {
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
      // An undo landing mid-gesture first commits the gesture, so it is the
      // gesture that gets undone and no snapshot is left dangling.
      if (get().gestureSnapshot) get().endGesture();
      const { past, future, project, assets } = get();
      if (past.length === 0) return;
      const prev = past[past.length - 1]!;
      set({
        project: prev.project,
        assets: reviveAssets(prev.assets, assets),
        past: past.slice(0, -1),
        future: [{ project, assets }, ...future],
        selectedClipId: null,
        selectedClipIds: [],
        inspectorOpen: false,
        // Undoing the precompose that created the composition you are standing
        // in leaves the editor inside a timeline that no longer exists. Walk it
        // back to the root rather than render an empty one.
        activeCompId: standingIn(get(), prev.project),
      });
      disposeUnreachableAssets(Object.keys(assets), get());
      announce('a11y.announce.undo');
    },

    redo: () => {
      if (get().gestureSnapshot) get().endGesture();
      const { past, future, project, assets } = get();
      if (future.length === 0) return;
      const next = future[0]!;
      set({
        project: next.project,
        assets: reviveAssets(next.assets, assets),
        past: [...past, { project, assets }].slice(-HISTORY_LIMIT),
        future: future.slice(1),
        selectedClipId: null,
        selectedClipIds: [],
        inspectorOpen: false,
        activeCompId: standingIn(get(), next.project),
      });
      disposeUnreachableAssets(Object.keys(assets), get());
      announce('a11y.announce.redo');
    },
  };
}
