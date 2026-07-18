import { create } from 'zustand';
import { produce, setAutoFreeze } from 'immer';
import { Clip, LoopRegion, Marker, Project } from '../types';
import { clipDurationMs, clipEndMs, projectDurationMs, sortedMarkers } from '../model';
import { createEmptyProject, linkableSelection, resolveOverlaps } from './projectOps';
import { type TimeFormat } from '../lib/time';
import {
  DEFAULT_PX_PER_SEC,
  TIMELINE_PAD_LEFT,
  DEFAULT_PREVIEW_RESOLUTION,
  type PreviewResolutionMode,
} from '../app/config';
import { HISTORY_LIMIT, TIME_FORMAT_KEY, PREVIEW_RESOLUTION_KEY } from './constants';
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

function loadPreviewResolution(): PreviewResolutionMode {
  try {
    const v = localStorage.getItem(PREVIEW_RESOLUTION_KEY);
    if (v === 'full' || v === 'half' || v === 'quarter' || v === 'eighth') return v;
  } catch {
    /* private mode / no storage - fall through to the default */
  }
  return DEFAULT_PREVIEW_RESOLUTION;
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
    snapGuideMs: null,
    dragBadge: null,
    inspectorOpen: false,
    libraryOpen: false,
    shortcutsOpen: false,
    preferencesOpen: false,
    aboutOpen: false,
    contextMenu: null,
    renamingMarkerId: null,
    timeFormat: loadTimeFormat(),
    previewResolution: loadPreviewResolution(),
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

// These two selectors scan the whole project, and Zustand re-runs every
// subscribed selector on each store commit - which happens ~60×/s during
// playback (the engine writes currentTimeMs each frame). Their inputs (project,
// selection) are stable across those frames, so a one-entry cache keyed on the
// exact inputs returns instantly and the scan runs only when the selection or
// the project actually changes. Every consumer sees the same state object per
// commit, so a single slot serves them all. Correctness is guaranteed by the
// identity checks: a miss simply recomputes.
let selectedClipCache: { project: Project; id: string | null; clip: Clip | null } | null = null;

/** Selector: the currently selected clip (or null). */
export function getSelectedClip(state: EditorState): Clip | null {
  const { project, selectedClipId } = state;
  if (
    selectedClipCache &&
    selectedClipCache.project === project &&
    selectedClipCache.id === selectedClipId
  ) {
    return selectedClipCache.clip;
  }
  let clip: Clip | null = null;
  if (selectedClipId) {
    for (const track of project.tracks) {
      const found = track.clips.find((c) => c.id === selectedClipId);
      if (found) {
        clip = found;
        break;
      }
    }
  }
  selectedClipCache = { project, id: selectedClipId, clip };
  return clip;
}

let linkTargetsCache: {
  project: Project;
  ids: string[];
  targets: [string, string] | null;
} | null = null;

/** Selector: the clip pair a "Link" action would join, or null (drives the command). */
export function getLinkTargets(state: EditorState): [string, string] | null {
  const { project, selectedClipIds } = state;
  if (
    linkTargetsCache &&
    linkTargetsCache.project === project &&
    linkTargetsCache.ids === selectedClipIds
  ) {
    return linkTargetsCache.targets;
  }
  const targets = linkableSelection(project, selectedClipIds);
  linkTargetsCache = { project, ids: selectedClipIds, targets };
  return targets;
}

export { clipDurationMs, clipEndMs, projectDurationMs, sortedMarkers };
export type { LoopRegion, Marker };
