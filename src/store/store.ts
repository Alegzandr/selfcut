import { create } from 'zustand';
import { produce, setAutoFreeze } from 'immer';
import { Clip, LoopRegion, Marker, Project } from '../types';
import { clipDurationMs, clipEndMs, projectDurationMs, sortedMarkers } from '../model';
import { createEmptyProject, resolveOverlaps } from './projectOps';
import { type TimeFormat } from '../lib/time';
import { DEFAULT_PX_PER_SEC, TIMELINE_PAD_LEFT } from '../app/config';
import { HISTORY_LIMIT, TIME_FORMAT_KEY } from './constants';
import type { EditorState } from './editorState';
import { createProjectSlice } from './slices/projectSlice';
import { createAssetsSlice } from './slices/assetsSlice';
import { createSelectionSlice } from './slices/selectionSlice';
import { createPlaybackSlice } from './slices/playbackSlice';
import { createClipsSlice } from './slices/clipsSlice';
import { createTracksSlice } from './slices/tracksSlice';
import { createMarkersSlice } from './slices/markersSlice';
import { createHistorySlice } from './slices/historySlice';
import { createClipboardSlice } from './slices/clipboardSlice';
import { createUiSlice } from './slices/uiSlice';

function loadTimeFormat(): TimeFormat {
  try {
    const v = localStorage.getItem(TIME_FORMAT_KEY);
    if (v === 'decimal' || v === 'timecode') return v;
  } catch {
    /* private mode / no storage - fall through to the default */
  }
  return 'timecode';
}

export type { EditorState } from './editorState';

// Keep produced projects mutable (the store treats project state as immutable
// via copy-on-write, but some code paths still read-then-mutate a fresh copy,
// matching the previous structuredClone semantics).
setAutoFreeze(false);

export const useStore = create<EditorState>((set, get) => {
  /**
   * Mutation recorded in history (one-shot operation). `priorityClipId`
   * names the clip that keeps its position when overlaps are settled
   * (defaults to the current selection).
   */
  const withHistory = (fn: (p: Project) => void, priorityClipId?: string | null) => {
    const prev = get().project;
    // Immer's structural sharing: `fn` mutates a draft, but only the touched
    // tracks/clips get a new identity - no full deep clone of the project per
    // edit, and `prev` stays intact for undo.
    const mutated = produce(prev, fn);
    // Every committed edit leaves the tracks in a legal layout (pairwise crossfades only).
    const next = resolveOverlaps(
      mutated,
      priorityClipId !== undefined ? priorityClipId : get().selectedClipId,
    );
    set({
      project: next,
      past: [...get().past, prev].slice(-HISTORY_LIMIT),
      future: [],
    });
  };

  /** Drop any selected ids whose clip no longer exists. */
  const pruneSelection = () => {
    const live = new Set<string>();
    for (const t of get().project.tracks) for (const c of t.clips) live.add(c.id);
    const ids = get().selectedClipIds.filter((id) => live.has(id));
    if (ids.length !== get().selectedClipIds.length) {
      set({
        selectedClipIds: ids,
        selectedClipId: ids[ids.length - 1] ?? null,
        ...(ids.length === 0 ? { inspectorOpen: false } : {}),
      });
    }
  };

  const helpers = { withHistory, pruneSelection };

  return {
    project: createEmptyProject(),
    assets: {},
    selectedClipId: null,
    selectedClipIds: [],
    currentTimeMs: 0,
    seekVersion: 0,
    playing: false,
    loopRegion: null,
    loopEnabled: false,
    playbackRate: 1,
    pxPerSec: DEFAULT_PX_PER_SEC,
    timelinePadLeft: TIMELINE_PAD_LEFT,
    snapEnabled: true,
    inspectorOpen: false,
    libraryOpen: false,
    shortcutsOpen: false,
    preferencesOpen: false,
    aboutOpen: false,
    timeFormat: loadTimeFormat(),
    clipboard: null,
    exportOpen: false,
    importing: false,
    error: null,
    past: [],
    future: [],
    gestureSnapshot: null,
    cropEditing: false,

    ...createProjectSlice(set, get, helpers),
    ...createAssetsSlice(set, get, helpers),
    ...createSelectionSlice(set, get, helpers),
    ...createPlaybackSlice(set, get, helpers),
    ...createClipsSlice(set, get, helpers),
    ...createTracksSlice(set, get, helpers),
    ...createMarkersSlice(set, get, helpers),
    ...createHistorySlice(set, get, helpers),
    ...createClipboardSlice(set, get, helpers),
    ...createUiSlice(set, get, helpers),
  };
});

/** Selector: the currently selected clip (or null). */
export function getSelectedClip(state: EditorState): Clip | null {
  if (!state.selectedClipId) return null;
  for (const track of state.project.tracks) {
    const clip = track.clips.find((c) => c.id === state.selectedClipId);
    if (clip) return clip;
  }
  return null;
}

export { clipDurationMs, clipEndMs, projectDurationMs, sortedMarkers };
export type { LoopRegion, Marker };
