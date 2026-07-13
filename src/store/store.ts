import { create } from 'zustand';
import {
  Clip,
  MediaAsset,
  Project,
  Track,
  AspectRatio,
  clipDurationMs,
  clipEndMs,
  timelineToSourceMs,
  projectDurationMs,
} from '../types';
import { uid } from '../lib/id';
import { clamp } from '../lib/time';
import { DEFAULT_PX_PER_SEC, MIN_CLIP_DURATION_MS, MIN_PX_PER_SEC, MAX_PX_PER_SEC, PROJECT_FPS, TIMELINE_PAD_LEFT } from '../app/config';

const HISTORY_LIMIT = 50;

interface ClipboardEntry {
  clip: Clip;
  kind: Track['kind'];
}

export interface EditorState {
  project: Project;
  assets: Record<string, MediaAsset>;
  selectedClipId: string | null;
  currentTimeMs: number;
  /** Incremented on every user seek — the playback engine resyncs to it. */
  seekVersion: number;
  playing: boolean;
  pxPerSec: number;
  /** Left padding of the timeline content in px (half the viewport on mobile, fixed on desktop). */
  timelinePadLeft: number;
  /** Mobile only: the inspector opens on demand (Adjust button), not on every selection. */
  inspectorOpen: boolean;
  shortcutsOpen: boolean;
  clipboard: ClipboardEntry | null;
  exportOpen: boolean;
  importing: boolean;
  error: string | null;

  past: Project[];
  future: Project[];
  gestureSnapshot: Project | null;

  setAspectRatio: (a: AspectRatio) => void;
  addAsset: (asset: MediaAsset) => void;
  removeAsset: (assetId: string) => void;
  addClipFromAsset: (assetId: string) => void;
  addTrack: (kind: Track['kind']) => void;
  removeTrack: (trackId: string) => void;
  moveTrack: (trackId: string, dir: -1 | 1) => void;
  toggleTrackMuted: (trackId: string) => void;
  toggleTrackHidden: (trackId: string) => void;

  selectClip: (id: string | null) => void;
  updateClip: (clipId: string, patch: Partial<Clip>) => void;
  updateClipCommitted: (clipId: string, patch: Partial<Clip>) => void;
  moveClip: (clipId: string, timelineStartMs: number, targetTrackId?: string) => void;
  trimClip: (clipId: string, edge: 'left' | 'right', timelineMs: number) => void;
  splitAtPlayhead: () => void;
  deleteClip: (clipId: string) => void;
  duplicateClip: (clipId: string) => void;
  copyClip: (clipId: string) => void;
  cutClip: (clipId: string) => void;
  pasteAtPlayhead: () => void;

  beginGesture: () => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;

  seek: (ms: number) => void;
  setCurrentTimeFromEngine: (ms: number) => void;
  setPlaying: (playing: boolean) => void;
  setPxPerSec: (v: number) => void;
  setTimelinePadLeft: (px: number) => void;
  setInspectorOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setExportOpen: (open: boolean) => void;
  setImporting: (v: boolean) => void;
  setError: (msg: string | null) => void;
}

function createEmptyProject(): Project {
  return { id: uid('proj'), aspectRatio: '16:9', fps: PROJECT_FPS, tracks: [] };
}

function findClip(project: Project, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index !== -1) return { track, clip: track.clips[index], index };
  }
  return null;
}

export const useStore = create<EditorState>((set, get) => {
  /** Mutation recorded in history (one-shot operation). */
  const withHistory = (fn: (p: Project) => void) => {
    const prev = get().project;
    const next = structuredClone(prev);
    fn(next);
    set({
      project: next,
      past: [...get().past, prev].slice(-HISTORY_LIMIT),
      future: [],
    });
  };

  /** Mutation without history (used mid-gesture; wrap with begin/endGesture). */
  const withoutHistory = (fn: (p: Project) => void) => {
    const next = structuredClone(get().project);
    fn(next);
    set({ project: next });
  };

  return {
    project: createEmptyProject(),
    assets: {},
    selectedClipId: null,
    currentTimeMs: 0,
    seekVersion: 0,
    playing: false,
    pxPerSec: DEFAULT_PX_PER_SEC,
    timelinePadLeft: TIMELINE_PAD_LEFT,
    inspectorOpen: false,
    shortcutsOpen: false,
    clipboard: null,
    exportOpen: false,
    importing: false,
    error: null,
    past: [],
    future: [],
    gestureSnapshot: null,

    setAspectRatio: (a) => withHistory((p) => void (p.aspectRatio = a)),

    addAsset: (asset) => set({ assets: { ...get().assets, [asset.id]: asset } }),

    removeAsset: (assetId) => {
      const selected = get().selectedClipId;
      let selectedRemoved = false;
      withHistory((p) => {
        for (const track of p.tracks) {
          if (selected && track.clips.some((c) => c.id === selected && c.assetId === assetId)) {
            selectedRemoved = true;
          }
          track.clips = track.clips.filter((c) => c.assetId !== assetId);
        }
      });
      const assets = { ...get().assets };
      delete assets[assetId];
      set({ assets, ...(selectedRemoved ? { selectedClipId: null } : {}) });
    },

    addClipFromAsset: (assetId) => {
      const asset = get().assets[assetId];
      if (!asset) return;
      let newClipId = '';
      withHistory((p) => {
        let track = p.tracks.find((t) => t.kind === asset.kind);
        if (!track) {
          track = { id: uid('track'), kind: asset.kind, clips: [] };
          if (asset.kind === 'video') {
            const lastVideoIdx = p.tracks.map((t) => t.kind).lastIndexOf('video');
            p.tracks.splice(lastVideoIdx + 1, 0, track);
          } else {
            p.tracks.push(track);
          }
        }
        const start = track.clips.reduce((max, c) => Math.max(max, clipEndMs(c)), 0);
        const clip: Clip = {
          id: uid('clip'),
          assetId,
          trackId: track.id,
          timelineStartMs: start,
          sourceInMs: 0,
          sourceOutMs: asset.durationMs,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
        };
        newClipId = clip.id;
        track.clips.push(clip);
      });
      set({ selectedClipId: newClipId });
    },

    addTrack: (kind) =>
      withHistory((p) => {
        const track: Track = { id: uid('track'), kind, clips: [] };
        if (kind === 'video') {
          const lastVideoIdx = p.tracks.map((t) => t.kind).lastIndexOf('video');
          p.tracks.splice(lastVideoIdx + 1, 0, track);
        } else {
          p.tracks.push(track);
        }
      }),

    removeTrack: (trackId) => {
      const selected = get().selectedClipId;
      const track = get().project.tracks.find((t) => t.id === trackId);
      withHistory((p) => {
        p.tracks = p.tracks.filter((t) => t.id !== trackId);
      });
      if (selected && track?.clips.some((c) => c.id === selected)) {
        set({ selectedClipId: null });
      }
    },

    moveTrack: (trackId, dir) =>
      withHistory((p) => {
        const i = p.tracks.findIndex((t) => t.id === trackId);
        const j = i + dir;
        if (i === -1 || j < 0 || j >= p.tracks.length) return;
        [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]];
      }),

    toggleTrackMuted: (trackId) =>
      withHistory((p) => {
        const t = p.tracks.find((t) => t.id === trackId);
        if (t) t.muted = !t.muted;
      }),

    toggleTrackHidden: (trackId) =>
      withHistory((p) => {
        const t = p.tracks.find((t) => t.id === trackId);
        if (t) t.hidden = !t.hidden;
      }),

    selectClip: (id) =>
      set({ selectedClipId: id, ...(id === null ? { inspectorOpen: false } : {}) }),

    updateClip: (clipId, patch) =>
      withoutHistory((p) => {
        const found = findClip(p, clipId);
        if (found) Object.assign(found.clip, patch);
      }),

    updateClipCommitted: (clipId, patch) =>
      withHistory((p) => {
        const found = findClip(p, clipId);
        if (found) Object.assign(found.clip, patch);
      }),

    moveClip: (clipId, timelineStartMs, targetTrackId) =>
      withoutHistory((p) => {
        const found = findClip(p, clipId);
        if (!found) return;
        const { track, clip, index } = found;
        clip.timelineStartMs = Math.max(0, timelineStartMs);
        if (targetTrackId && targetTrackId !== track.id) {
          const target = p.tracks.find((t) => t.id === targetTrackId);
          if (target && target.kind === track.kind) {
            track.clips.splice(index, 1);
            clip.trackId = target.id;
            target.clips.push(clip);
          }
        }
      }),

    trimClip: (clipId, edge, timelineMs) => {
      const assets = get().assets;
      withoutHistory((p) => {
        const found = findClip(p, clipId);
        if (!found) return;
        const clip = found.clip;
        const asset = assets[clip.assetId];
        const minSourceSpan = MIN_CLIP_DURATION_MS * clip.speed;
        if (edge === 'left') {
          const proposed = Math.max(0, timelineMs);
          let sourceIn = clip.sourceInMs + (proposed - clip.timelineStartMs) * clip.speed;
          sourceIn = clamp(sourceIn, 0, clip.sourceOutMs - minSourceSpan);
          clip.timelineStartMs += (sourceIn - clip.sourceInMs) / clip.speed;
          clip.sourceInMs = sourceIn;
        } else {
          let sourceOut = clip.sourceInMs + (timelineMs - clip.timelineStartMs) * clip.speed;
          const maxOut = asset ? asset.durationMs : Infinity;
          sourceOut = clamp(sourceOut, clip.sourceInMs + minSourceSpan, maxOut);
          clip.sourceOutMs = sourceOut;
        }
      });
    },

    splitAtPlayhead: () => {
      const { currentTimeMs, selectedClipId, project } = get();
      // Target: the selected clip if the playhead is inside it, otherwise every clip under it.
      const targets: string[] = [];
      for (const track of project.tracks) {
        for (const clip of track.clips) {
          const inside =
            currentTimeMs > clip.timelineStartMs + 1 && currentTimeMs < clipEndMs(clip) - 1;
          if (inside && (!selectedClipId || clip.id === selectedClipId)) targets.push(clip.id);
        }
      }
      if (targets.length === 0) return;
      withHistory((p) => {
        for (const track of p.tracks) {
          const additions: Clip[] = [];
          for (const clip of track.clips) {
            if (!targets.includes(clip.id)) continue;
            const splitSource = timelineToSourceMs(clip, currentTimeMs);
            const right: Clip = {
              ...structuredClone(clip),
              id: uid('clip'),
              timelineStartMs: currentTimeMs,
              sourceInMs: splitSource,
              fadeInMs: 0,
            };
            clip.sourceOutMs = splitSource;
            clip.fadeOutMs = 0;
            additions.push(right);
          }
          track.clips.push(...additions);
        }
      });
    },

    deleteClip: (clipId) => {
      withHistory((p) => {
        for (const track of p.tracks) {
          track.clips = track.clips.filter((c) => c.id !== clipId);
        }
      });
      if (get().selectedClipId === clipId) set({ selectedClipId: null, inspectorOpen: false });
    },

    duplicateClip: (clipId) => {
      let newId = '';
      withHistory((p) => {
        const found = findClip(p, clipId);
        if (!found) return;
        const copy: Clip = {
          ...structuredClone(found.clip),
          id: uid('clip'),
          timelineStartMs: clipEndMs(found.clip),
        };
        newId = copy.id;
        found.track.clips.push(copy);
      });
      if (newId) set({ selectedClipId: newId });
    },

    copyClip: (clipId) => {
      const found = findClip(get().project, clipId);
      if (found) set({ clipboard: { clip: structuredClone(found.clip), kind: found.track.kind } });
    },

    cutClip: (clipId) => {
      get().copyClip(clipId);
      get().deleteClip(clipId);
    },

    pasteAtPlayhead: () => {
      const { clipboard, currentTimeMs } = get();
      if (!clipboard) return;
      let newId = '';
      withHistory((p) => {
        let track =
          p.tracks.find((t) => t.id === clipboard.clip.trackId && t.kind === clipboard.kind) ??
          p.tracks.find((t) => t.kind === clipboard.kind);
        if (!track) {
          track = { id: uid('track'), kind: clipboard.kind, clips: [] };
          if (clipboard.kind === 'video') {
            const lastVideoIdx = p.tracks.map((t) => t.kind).lastIndexOf('video');
            p.tracks.splice(lastVideoIdx + 1, 0, track);
          } else {
            p.tracks.push(track);
          }
        }
        const clip: Clip = {
          ...structuredClone(clipboard.clip),
          id: uid('clip'),
          trackId: track.id,
          timelineStartMs: currentTimeMs,
        };
        newId = clip.id;
        track.clips.push(clip);
      });
      set({ selectedClipId: newId });
    },

    beginGesture: () => set({ gestureSnapshot: get().project }),

    endGesture: () => {
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
        inspectorOpen: false,
      });
    },

    seek: (ms) => {
      const duration = projectDurationMs(get().project);
      set({
        currentTimeMs: clamp(ms, 0, Math.max(duration, 0)),
        seekVersion: get().seekVersion + 1,
      });
    },

    setCurrentTimeFromEngine: (ms) => set({ currentTimeMs: ms }),

    setPlaying: (playing) => set({ playing }),

    setPxPerSec: (v) => set({ pxPerSec: clamp(v, MIN_PX_PER_SEC, MAX_PX_PER_SEC) }),

    setTimelinePadLeft: (px) => {
      if (get().timelinePadLeft !== px) set({ timelinePadLeft: px });
    },

    setInspectorOpen: (open) => set({ inspectorOpen: open }),
    setShortcutsOpen: (open) => set({ shortcutsOpen: open }),

    setExportOpen: (open) => set({ exportOpen: open }),
    setImporting: (v) => set({ importing: v }),
    setError: (msg) => set({ error: msg }),
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

export { clipDurationMs, clipEndMs, projectDurationMs };
