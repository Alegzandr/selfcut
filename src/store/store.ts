import { create } from 'zustand';
import { produce, setAutoFreeze } from 'immer';
import { Clip, Composition, LoopRegion, Marker, Project, Track } from '../types';
import {
  clipDurationMs,
  clipEndMs,
  compDurationMs,
  compHost,
  findComp,
  markersOf,
  projectDurationMs,
  setMarkersOf,
  setTracksOf,
  sortedMarkers,
  syncCompClips,
  timelineFps,
  tracksOf,
} from '../model';
import { createEmptyProject, linkableSelection, resolveOverlaps } from './projectOps';
import { editTargets } from './editTargets';
import { type TimeFormat } from '../lib/time';
import {
  DEFAULT_PX_PER_SEC,
  TIMELINE_PAD_LEFT,
  DEFAULT_PREVIEW_RESOLUTION,
  TRACK_HEIGHT_PX,
  MIN_TRACK_HEIGHT_PX,
  MAX_TRACK_HEIGHT_PX,
  TRACK_HEADER_WIDTH_PX,
  MIN_TRACK_HEADER_WIDTH_PX,
  MAX_TRACK_HEADER_WIDTH_PX,
  LIBRARY_WIDTH_PX,
  MIN_LIBRARY_WIDTH_PX,
  MAX_LIBRARY_WIDTH_PX,
  INSPECTOR_WIDTH_PX,
  MIN_INSPECTOR_WIDTH_PX,
  MAX_INSPECTOR_WIDTH_PX,
  type PreviewResolutionMode,
} from '../app/config';
import {
  HISTORY_LIMIT,
  TIME_FORMAT_KEY,
  TRACK_HEIGHT_KEY,
  TRACK_HEADER_WIDTH_KEY,
  LIBRARY_WIDTH_KEY,
  INSPECTOR_WIDTH_KEY,
  PREVIEW_RESOLUTION_KEY,
  PREVIEW_VOLUME_KEY,
  PREVIEW_MUTED_KEY,
  SCOPES_MODE_KEY,
  PREVIEW_BACKGROUND_KEY,
  PREVIEW_GUIDES_KEY,
  RIPPLE_ACROSS_TRACKS_KEY,
} from './constants';
import { PREVIEW_GUIDE_MODES, type PreviewGuides } from '../preview/guides';
import { DEFAULT_PREVIEW_BACKGROUND } from '../lib/palette';
import type { EditorState } from './editorState';
import { PREVIEW_VIEW_RESET } from '../preview/view';
import { SCOPE_MODES, type ScopeMode } from '../preview/scopes';
import { createProjectSlice } from './slices/projectSlice';
import { createAssetsSlice } from './slices/assetsSlice';
import { createSelectionSlice } from './slices/selectionSlice';
import { createPlaybackSlice } from './slices/playbackSlice';
import { createClipsSlice } from './slices/clipsSlice';
import { createKeyframesSlice } from './slices/keyframesSlice';
import { createEffectsSlice } from './slices/effectsSlice';
import { createLutsSlice } from './slices/lutsSlice';
import { createTracksSlice } from './slices/tracksSlice';
import { createMarkersSlice } from './slices/markersSlice';
import { createHistorySlice } from './slices/historySlice';
import { createClipboardSlice } from './slices/clipboardSlice';
import { createUiSlice } from './slices/uiSlice';
import { createCompsSlice } from './slices/compsSlice';

function loadTimeFormat(): TimeFormat {
  try {
    const v = localStorage.getItem(TIME_FORMAT_KEY);
    if (v === 'decimal' || v === 'timecode') return v;
  } catch {
    /* private mode / no storage - fall through to the default */
  }
  return 'timecode';
}

/**
 * Whether ripple edits move every track. Off unless the user has said so: the
 * per-track ripple is what the app has always done, and a preference read from
 * an empty store must not change how a delete behaves.
 */
function loadRippleAcrossTracks(): boolean {
  try {
    return localStorage.getItem(RIPPLE_ACROSS_TRACKS_KEY) === '1';
  } catch {
    /* private mode / no storage - fall through to the default */
  }
  return false;
}

function loadTrackHeight(): number {
  try {
    const v = Number(localStorage.getItem(TRACK_HEIGHT_KEY));
    if (Number.isFinite(v) && v >= MIN_TRACK_HEIGHT_PX && v <= MAX_TRACK_HEIGHT_PX) return v;
  } catch {
    /* private mode / no storage - fall through to the default */
  }
  return TRACK_HEIGHT_PX;
}

/** Read a persisted pane width, falling back to its default when out of bounds. */
function loadWidth(key: string, min: number, max: number, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    if (Number.isFinite(v) && v >= min && v <= max) return v;
  } catch {
    /* private mode / no storage - fall through to the default */
  }
  return fallback;
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

function loadScopesMode(): ScopeMode {
  try {
    const v = localStorage.getItem(SCOPES_MODE_KEY);
    if (v === 'off' || (v && SCOPE_MODES.includes(v as ScopeMode))) return v as ScopeMode;
  } catch {
    /* private mode / no storage - fall through to the default */
  }
  return 'off';
}

function loadPreviewVolume(): number {
  try {
    // Guard the raw string first: `Number(null)` is 0, which would silence the
    // preview for anyone who has never touched the fader.
    const raw = localStorage.getItem(PREVIEW_VOLUME_KEY);
    const v = raw === null ? NaN : Number(raw);
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
  } catch {
    /* private mode / no storage - fall through to the default */
  }
  return 1;
}

function loadPreviewBackground(): string {
  try {
    const v = localStorage.getItem(PREVIEW_BACKGROUND_KEY);
    // Any `#rrggbb` is allowed (the picker is free-form), but it goes straight
    // into a style attribute, so anything else is dropped rather than trusted.
    if (v && /^#[0-9a-f]{6}$/i.test(v)) return v;
  } catch {
    /* private mode / no storage - fall through to the default */
  }
  return DEFAULT_PREVIEW_BACKGROUND;
}

function loadPreviewGuides(): PreviewGuides {
  try {
    const v = localStorage.getItem(PREVIEW_GUIDES_KEY);
    if (v && PREVIEW_GUIDE_MODES.includes(v as PreviewGuides)) return v as PreviewGuides;
  } catch {
    /* private mode / no storage - fall through to the default */
  }
  return 'off';
}

function loadPreviewMuted(): boolean {
  try {
    return localStorage.getItem(PREVIEW_MUTED_KEY) === '1';
  } catch {
    /* private mode / no storage - fall through to the default */
    return false;
  }
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
    // An edit INSIDE a composition changes how long the clips that PLAY it are,
    // everywhere else in the project - which no single action can know about
    // itself. Settled here, against the project as it was, before overlaps are
    // resolved: a comp clip that just grew has to be laid out at its new length.
    const grown = produce(mutated, (draft) => syncCompClips(prev, draft));
    // Every committed edit leaves the tracks in a legal layout (pairwise crossfades only).
    const next = resolveOverlaps(
      grown,
      priorityClipId !== undefined ? priorityClipId : get().selectedClipId,
    );
    // Inside a gesture the whole sequence is one undo step: endGesture pushes
    // the entry taken at beginGesture, so nested edits must not push their own.
    if (get().gestureSnapshot) {
      set({ project: next });
      return;
    }
    set({
      project: next,
      past: [...get().past, { project: prev, assets: get().assets }].slice(-HISTORY_LIMIT),
      future: [],
    });
  };

  /**
   * The lanes every edit lands on: the project's own, or the nested composition
   * the user has open. One place resolves it, so no slice has to.
   */
  const lanes = (p: Project): Track[] => tracksOf(p, get().activeCompId);
  const setLanes = (p: Project, tracks: Track[]): void =>
    setTracksOf(p, get().activeCompId, tracks);
  const withLanes = (p: Project, tracks: Track[]): Project => {
    const compId = get().activeCompId;
    if (compId === null) return { ...p, tracks };
    return {
      ...p,
      comps: (p.comps ?? []).map((comp) => (comp.id === compId ? { ...comp, tracks } : comp)),
    };
  };
  const host = (p: Project) => compHost(p, get().activeCompId);
  const cues = (p: Project): Marker[] => markersOf(p, get().activeCompId);
  const setCues = (p: Project, markers: Marker[]): void =>
    setMarkersOf(p, get().activeCompId, markers);
  const withCues = (p: Project, markers: Marker[]): Project => {
    const compId = get().activeCompId;
    if (compId === null) return { ...p, markers };
    return {
      ...p,
      comps: (p.comps ?? []).map((comp) => (comp.id === compId ? { ...comp, markers } : comp)),
    };
  };

  /** Drop any selected ids - clips and boxed keyframes - whose clip is gone. */
  const pruneSelection = () => {
    const live = new Set<string>();
    // Scoped to the open composition: a clip that is still alive elsewhere in
    // the project is not selectable from here, so it must not survive in the
    // selection either.
    for (const t of lanes(get().project)) for (const c of t.clips) live.add(c.id);
    const ids = get().selectedClipIds.filter((id) => live.has(id));
    if (ids.length !== get().selectedClipIds.length) {
      set({
        selectedClipIds: ids,
        selectedClipId: ids[ids.length - 1] ?? null,
        ...(ids.length === 0 ? { inspectorOpen: false } : {}),
      });
    }
    const keys = get().selectedKeyframes;
    if (keys.some((k) => !live.has(k.clipId))) {
      set({ selectedKeyframes: keys.filter((k) => live.has(k.clipId)) });
    }
  };

  /**
   * The clips an edit aimed at `clipId` reaches. Every property action routes
   * through it, so one control changed with several clips selected lands on
   * all of them instead of on the primary alone.
   */
  const targetsOf = (clipId: string) => editTargets(get().project, get().selectedClipIds, clipId);

  const helpers = {
    withHistory,
    pruneSelection,
    targetsOf,
    lanes,
    setLanes,
    withLanes,
    host,
    cues,
    setCues,
    withCues,
  };

  const initialProject = createEmptyProject();

  return {
    project: initialProject,
    activeCompId: null,
    renamingCompId: null,
    currentProjectId: initialProject.id,
    projects: [],
    projectLibraryOpen: false,
    assets: {},
    selectedClipId: null,
    selectedClipIds: [],
    selectedKeyframes: [],
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
    newTrackHintKind: null,
    hoveredLinkId: null,
    dropPreview: null,
    previewOverrideMs: null,
    inspectorOpen: false,
    inspectorTab: 'clip',
    libraryOpen: false,
    libraryTab: 'media',
    loadedPresets: [],
    shortcutsOpen: false,
    curveEditorOpen: false,
    preferencesOpen: false,
    aboutOpen: false,
    contextMenu: null,
    confirmDialog: null,
    renamingMarkerId: null,
    trackSettingsTrackId: null,
    fxTrackId: null,
    expandedTrackIds: [],
    trackHeightPx: loadTrackHeight(),
    trackHeaderWidthPx: loadWidth(
      TRACK_HEADER_WIDTH_KEY,
      MIN_TRACK_HEADER_WIDTH_PX,
      MAX_TRACK_HEADER_WIDTH_PX,
      TRACK_HEADER_WIDTH_PX,
    ),
    libraryWidthPx: loadWidth(
      LIBRARY_WIDTH_KEY,
      MIN_LIBRARY_WIDTH_PX,
      MAX_LIBRARY_WIDTH_PX,
      LIBRARY_WIDTH_PX,
    ),
    inspectorWidthPx: loadWidth(
      INSPECTOR_WIDTH_KEY,
      MIN_INSPECTOR_WIDTH_PX,
      MAX_INSPECTOR_WIDTH_PX,
      INSPECTOR_WIDTH_PX,
    ),
    timeFormat: loadTimeFormat(),
    rippleAcrossTracks: loadRippleAcrossTracks(),
    previewResolution: loadPreviewResolution(),
    scopesMode: loadScopesMode(),
    previewGuides: loadPreviewGuides(),
    renamingTrackId: null,
    previewBackground: loadPreviewBackground(),
    previewVolume: loadPreviewVolume(),
    previewMuted: loadPreviewMuted(),
    clipboard: null,
    exportOpen: false,
    importing: false,
    importStatus: null,
    transcodes: {},
    error: null,
    notice: null,
    noticeAction: null,
    past: [],
    future: [],
    gestureSnapshot: null,
    cropEditing: false,
    selectedRedactionId: null,
    selectedLocalAdjustId: null,
    previewTool: 'select',
    previewShapeKind: 'rect',
    previewView: PREVIEW_VIEW_RESET,

    ...createProjectSlice(set, get, helpers),
    ...createAssetsSlice(set, get, helpers),
    ...createSelectionSlice(set, get, helpers),
    ...createPlaybackSlice(set, get, helpers),
    ...createClipsSlice(set, get, helpers),
    ...createKeyframesSlice(set, get, helpers),
    ...createEffectsSlice(set, get, helpers),
    ...createLutsSlice(set, get, helpers),
    ...createTracksSlice(set, get, helpers),
    ...createMarkersSlice(set, get, helpers),
    ...createHistorySlice(set, get, helpers),
    ...createClipboardSlice(set, get, helpers),
    ...createUiSlice(set, get, helpers),
    ...createCompsSlice(set, get, helpers),
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
/**
 * The lanes the editor is showing and editing: the project's own timeline, or
 * those of the composition the user has opened.
 *
 * The selector every component reads instead of `project.tracks`. Returns the
 * live array, so it stays reference-stable across the 60 commits a second
 * playback makes and memoized rows keep skipping their re-render.
 */
export function getLanes(state: EditorState): Track[] {
  return tracksOf(state.project, state.activeCompId);
}

/**
 * The timeline on screen, as one object: the project itself at the root, the
 * open composition otherwise. What the pure timeline helpers take (snap points,
 * keyframe bounds, a ripple), so none of them has to know which it is.
 */
export function getTimeline(state: EditorState): Project | Composition {
  return compHost(state.project, state.activeCompId);
}

/** The cues of the timeline on screen - a composition keeps its own. */
export function getCues(state: EditorState): Marker[] {
  return markersOf(state.project, state.activeCompId);
}

/**
 * How long the timeline on screen runs. The transport, the ruler and the seek
 * clamp all read this, so entering a precomp really does rescale the timeline
 * rather than leaving the parent's length behind.
 */
export function getDurationMs(state: EditorState): number {
  return compDurationMs(state.project, state.activeCompId);
}

/** The composition on screen, or null at the root. */
export function getActiveComp(state: EditorState) {
  return state.activeCompId ? (findComp(state.project, state.activeCompId) ?? null) : null;
}

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
    for (const track of getLanes(state)) {
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

let selectedTrackCache: { project: Project; id: string | null; kind: Track['kind'] | null } | null = null;

/**
 * Selector: the kind of the track holding the selected clip (or null).
 * The clip alone cannot answer it: the audio half of a linked A/V pair comes
 * from a video asset, so anything picture-only ("blur a region", the colour
 * sections) must key off the lane the clip actually sits on.
 */
export function getSelectedTrackKind(state: EditorState): Track['kind'] | null {
  const { project, selectedClipId } = state;
  if (
    selectedTrackCache &&
    selectedTrackCache.project === project &&
    selectedTrackCache.id === selectedClipId
  ) {
    return selectedTrackCache.kind;
  }
  let kind: Track['kind'] | null = null;
  if (selectedClipId) {
    for (const track of getLanes(state)) {
      if (track.clips.some((c) => c.id === selectedClipId)) {
        kind = track.kind;
        break;
      }
    }
  }
  selectedTrackCache = { project, id: selectedClipId, kind };
  return kind;
}

let linkTargetsCache: {
  project: Project;
  ids: string[];
  targets: string[] | null;
} | null = null;

/** Selector: the clips a "Link" action would join, or null (drives the command). */
export function getLinkTargets(state: EditorState): string[] | null {
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

/** The frame rate the timeline steps and counts in (see `timelineFps`). */
export const getTimelineFps = (s: EditorState): number =>
  timelineFps(s.project, s.assets, getLanes(s));
