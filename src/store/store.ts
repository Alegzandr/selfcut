import { create } from 'zustand';
import { produce, setAutoFreeze } from 'immer';
import {
  Clip,
  ClipTransform,
  LoopRegion,
  Marker,
  MediaAsset,
  Project,
  Track,
  AspectRatio,
} from '../types';
import {
  DEFAULT_TRANSFORM,
  clipDurationMs,
  clipEndMs,
  outputDimensions,
  timelineToSourceMs,
  projectDurationMs,
  sortedMarkers,
} from '../model';
import { uid } from '../lib/id';
import {
  createEmptyProject,
  ensureTrack,
  findClip,
  insertTrack,
  patchClips,
  resolveOverlaps,
} from './projectOps';
import { clamp, type TimeFormat } from '../lib/time';
import { disposeAssetResources } from '../media/mediaCache';
import { t as translate } from '../i18n';
import {
  DEFAULT_PX_PER_SEC,
  MIN_CLIP_DURATION_MS,
  MIN_PX_PER_SEC,
  MAX_PX_PER_SEC,
  MIN_REGION_MS,
  TIMELINE_PAD_LEFT,
} from '../app/config';

const HISTORY_LIMIT = 50;

/** Persisted UI preferences (survive a reload, unlike the ephemeral session state). */
const TIME_FORMAT_KEY = 'selfcut.timeFormat';

function loadTimeFormat(): TimeFormat {
  try {
    const v = localStorage.getItem(TIME_FORMAT_KEY);
    if (v === 'decimal' || v === 'timecode') return v;
  } catch {
    /* private mode / no storage - fall through to the default */
  }
  return 'timecode';
}

interface ClipboardEntry {
  clip: Clip;
  kind: Track['kind'];
}

export interface EditorState {
  project: Project;
  assets: Record<string, MediaAsset>;
  /** Primary selection (last clicked) - the one the inspector edits. */
  selectedClipId: string | null;
  /** Full selection (multi-select via Ctrl/Cmd+click on desktop). */
  selectedClipIds: string[];
  currentTimeMs: number;
  /** Incremented on every user seek - the playback engine resyncs to it. */
  seekVersion: number;
  playing: boolean;
  /** Timeline selection (yellow corners): loop range and optional export range. */
  loopRegion: LoopRegion | null;
  /** Whether playback loops inside the region. */
  loopEnabled: boolean;
  /** Shuttle rate (J/K/L): 1 = normal. Reset to 1 whenever playback stops. */
  playbackRate: number;
  pxPerSec: number;
  /** Left padding of the timeline content in px (half the viewport on mobile, fixed on desktop). */
  timelinePadLeft: number;
  /** Clip-drag snapping (N toggles it; Alt inverts it for the current drag). */
  snapEnabled: boolean;
  /** Mobile only: the inspector opens on demand (Adjust button), not on every selection. */
  inspectorOpen: boolean;
  /** Mobile only: the media library lives in a drawer (desktop docks it permanently). */
  libraryOpen: boolean;
  shortcutsOpen: boolean;
  /** Preferences dialog (language, time format). */
  preferencesOpen: boolean;
  /** How the transport spells time out (persisted). */
  timeFormat: TimeFormat;
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
  /** Drop an asset at a specific timeline position (drag from the media library). */
  addClipFromAssetAt: (assetId: string, timelineMs: number, targetTrackId?: string) => void;
  /** Insert a generated text clip at the playhead, on a free topmost video track. */
  addTextClip: () => void;
  /** Insert a generated full-frame colour or gradient clip at the playhead. */
  addSolidClip: (kind: 'color' | 'gradient') => void;
  addTrack: (kind: Track['kind']) => void;
  /** Live track edit (volume/opacity slider drags) - wrap with begin/endGesture. */
  updateTrack: (trackId: string, patch: Partial<Track>) => void;
  updateTrackCommitted: (trackId: string, patch: Partial<Track>) => void;
  removeTrack: (trackId: string) => void;
  moveTrack: (trackId: string, dir: -1 | 1) => void;
  toggleTrackMuted: (trackId: string) => void;
  toggleTrackHidden: (trackId: string) => void;

  setAssetPeaks: (assetId: string, peaks: number[]) => void;
  setAssetThumbnails: (assetId: string, thumbnails: string[]) => void;

  selectClip: (id: string | null) => void;
  /** Ctrl/Cmd+A: every clip on every track. */
  selectAllClips: () => void;
  /** Ctrl/Cmd+click: add/remove a clip from the multi-selection. */
  toggleSelectClip: (id: string) => void;
  updateClip: (clipId: string, patch: Partial<Clip>) => void;
  updateClipCommitted: (clipId: string, patch: Partial<Clip>) => void;
  moveClip: (clipId: string, timelineStartMs: number, targetTrackId?: string) => void;
  /** Batch position update (multi-selection drag), no history - wrap with begin/endGesture. */
  moveClips: (entries: { clipId: string; timelineStartMs: number }[]) => void;
  trimClip: (clipId: string, edge: 'left' | 'right', timelineMs: number) => void;
  splitAtPlayhead: () => void;
  deleteClip: (clipId: string) => void;
  /** Delete a clip and close the gap: later clips on the same track shift left. */
  rippleDeleteClip: (clipId: string) => void;
  /** Delete several clips as one undo step; ripple closes the gaps. */
  deleteClips: (clipIds: string[], ripple: boolean) => void;
  duplicateClip: (clipId: string) => void;
  copyClip: (clipId: string) => void;
  cutClip: (clipId: string) => void;
  pasteAtPlayhead: () => void;
  /**
   * Punch-in zoom (the social-cut staple): cycle the scale of the selected
   * clip - or the topmost video clip under the playhead - 1 → 1.2 → 1.4 → 1.
   */
  punchZoomSelected: () => void;
  toggleSnap: () => void;
  /**
   * Import parsed subtitle cues as caption clips (outlined, lower-third) on a
   * dedicated topmost video track, one undo step for the whole file.
   */
  addSubtitleClips: (cues: { startMs: number; endMs: number; text: string }[]) => void;
  /**
   * Stream-clip layout: split the selected clip into a facecam band (top 30%,
   * cropped to the source's top-left corner by default) over a gameplay band
   * (bottom 70%, center crop). The duplicate lands on a track above; both
   * crops are then adjustable per clip (crop edit mode).
   */
  applyStreamLayout: (clipId: string) => void;
  /** Preview crop-edit mode for the selected video clip (session state). */
  cropEditing: boolean;
  setCropEditing: (v: boolean) => void;

  beginGesture: () => void;
  endGesture: () => void;
  undo: () => void;
  redo: () => void;

  seek: (ms: number) => void;
  setCurrentTimeFromEngine: (ms: number) => void;
  setPlaying: (playing: boolean) => void;
  setPlaybackRate: (rate: number) => void;

  /** Live during a drag on the region bar; a span shorter than MIN_REGION_MS clears it. */
  setLoopRegion: (region: LoopRegion | null) => void;
  /** I / O keys: pull one edge of the region to the playhead (creating it if needed). */
  setRegionEdgeAtPlayhead: (edge: 'in' | 'out') => void;
  toggleLoopEnabled: () => void;

  /** Drop a marker at the playhead (no-op if one already sits there). */
  addMarkerAtPlayhead: () => void;
  /** Live marker drag - wrap with begin/endGesture. */
  moveMarker: (markerId: string, timeMs: number) => void;
  renameMarker: (markerId: string, label: string) => void;
  removeMarker: (markerId: string) => void;
  /** Replace the whole editor content (restore from IndexedDB at boot). */
  hydrate: (project: Project, assets: MediaAsset[]) => void;
  /** Start over: empty project, empty library, empty history. */
  resetProject: () => void;
  setPxPerSec: (v: number) => void;
  setTimelinePadLeft: (px: number) => void;
  setInspectorOpen: (open: boolean) => void;
  setLibraryOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setPreferencesOpen: (open: boolean) => void;
  setTimeFormat: (format: TimeFormat) => void;
  setExportOpen: (open: boolean) => void;
  setImporting: (v: boolean) => void;
  setError: (msg: string | null) => void;
}


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
    timeFormat: loadTimeFormat(),
    clipboard: null,
    exportOpen: false,
    importing: false,
    error: null,
    past: [],
    future: [],
    gestureSnapshot: null,

    setAspectRatio: (a) => withHistory((p) => void (p.aspectRatio = a)),

    addAsset: (asset) => set({ assets: { ...get().assets, [asset.id]: asset } }),

    setAssetPeaks: (assetId, peaks) => {
      const asset = get().assets[assetId];
      if (!asset) return;
      set({ assets: { ...get().assets, [assetId]: { ...asset, peaks } } });
    },

    setAssetThumbnails: (assetId, thumbnails) => {
      const asset = get().assets[assetId];
      if (!asset) return;
      set({ assets: { ...get().assets, [assetId]: { ...asset, thumbnails } } });
    },

    removeAsset: (assetId) => {
      withHistory((p) => {
        for (const track of p.tracks) {
          track.clips = track.clips.filter((c) => c.assetId !== assetId);
        }
      });
      const assets = { ...get().assets };
      delete assets[assetId];
      set({ assets });
      disposeAssetResources(assetId);
      pruneSelection();
    },

    addClipFromAsset: (assetId) => {
      const asset = get().assets[assetId];
      if (!asset) return;
      let newClipId = '';
      withHistory((p) => {
        const track = ensureTrack(p, asset.kind);
        const start = track.clips.reduce((max, c) => Math.max(max, clipEndMs(c)), 0);
        const clip: Clip = {
          kind: 'media',
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
      set({ selectedClipId: newClipId, selectedClipIds: [newClipId] });
    },

    addClipFromAssetAt: (assetId, timelineMs, targetTrackId) => {
      const asset = get().assets[assetId];
      if (!asset) return;
      const newClipId = uid('clip');
      // The dropped clip keeps its position (priority) when overlaps settle.
      withHistory((p) => {
        const track = ensureTrack(p, asset.kind, targetTrackId);
        track.clips.push({
          kind: 'media',
          id: newClipId,
          assetId,
          trackId: track.id,
          timelineStartMs: Math.max(0, timelineMs),
          sourceInMs: 0,
          sourceOutMs: asset.durationMs,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
        });
      }, newClipId);
      set({ selectedClipId: newClipId, selectedClipIds: [newClipId] });
    },

    addTextClip: () => {
      const { currentTimeMs } = get();
      const newClipId = uid('clip');
      const durMs = 3000;
      withHistory((p) => {
        const start = Math.max(0, currentTimeMs);
        // Topmost video track with the interval free - a text clip is an overlay,
        // it must not crossfade with the footage it sits on. Otherwise stack a new track.
        let track = [...p.tracks]
          .reverse()
          .find(
            (t) =>
              t.kind === 'video' &&
              t.clips.every((c) => clipEndMs(c) <= start || c.timelineStartMs >= start + durMs),
          );
        if (!track) {
          track = { id: uid('track'), kind: 'video', clips: [] };
          insertTrack(p, track);
        }
        track.clips.push({
          kind: 'text',
          id: newClipId,
          assetId: '',
          trackId: track.id,
          timelineStartMs: start,
          sourceInMs: 0,
          sourceOutMs: durMs,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          text: { content: translate('clip.defaultText'), color: '#ffffff', sizeFrac: 0.08, bold: true },
        });
      }, newClipId);
      set({ selectedClipId: newClipId, selectedClipIds: [newClipId] });
    },

    addSolidClip: (kind) => {
      const { currentTimeMs } = get();
      const newClipId = uid('clip');
      const durMs = 3000;
      withHistory((p) => {
        const start = Math.max(0, currentTimeMs);
        let track = [...p.tracks]
          .reverse()
          .find(
            (t) =>
              t.kind === 'video' &&
              t.clips.every((c) => clipEndMs(c) <= start || c.timelineStartMs >= start + durMs),
          );
        if (!track) {
          track = { id: uid('track'), kind: 'video', clips: [] };
          insertTrack(p, track);
        }
        track.clips.push({
          kind: 'solid',
          id: newClipId,
          assetId: '',
          trackId: track.id,
          timelineStartMs: start,
          sourceInMs: 0,
          sourceOutMs: durMs,
          speed: 1,
          volume: 1,
          fadeInMs: 0,
          fadeOutMs: 0,
          solid:
            kind === 'color'
              ? { kind, color: '#6366f1' }
              : { kind, color: '#7c3aed', color2: '#ec4899', angle: 45 },
        });
      }, newClipId);
      set({ selectedClipId: newClipId, selectedClipIds: [newClipId] });
    },

    addTrack: (kind) =>
      withHistory((p) => {
        insertTrack(p, { id: uid('track'), kind, clips: [] });
      }),

    removeTrack: (trackId) => {
      withHistory((p) => {
        p.tracks = p.tracks.filter((t) => t.id !== trackId);
      });
      pruneSelection();
    },

    moveTrack: (trackId, dir) =>
      withHistory((p) => {
        const i = p.tracks.findIndex((t) => t.id === trackId);
        const j = i + dir;
        if (i === -1 || j < 0 || j >= p.tracks.length) return;
        [p.tracks[i], p.tracks[j]] = [p.tracks[j]!, p.tracks[i]!];
      }),

    toggleTrackMuted: (trackId) =>
      withHistory((p) => {
        const track = p.tracks.find((tr) => tr.id === trackId);
        if (track) track.muted = !track.muted;
      }),

    toggleTrackHidden: (trackId) =>
      withHistory((p) => {
        const track = p.tracks.find((tr) => tr.id === trackId);
        if (track) track.hidden = !track.hidden;
      }),

    updateTrack: (trackId, patch) => {
      const p = get().project;
      const tracks = p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t));
      set({ project: { ...p, tracks } });
    },

    updateTrackCommitted: (trackId, patch) =>
      withHistory((p) => {
        const track = p.tracks.find((tr) => tr.id === trackId);
        if (track) Object.assign(track, patch);
      }),

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

    updateClip: (clipId, patch) =>
      set({
        // The spread preserves the clip's discriminant `kind`; the cast tells TS
        // the patched object is still a valid Clip (a Partial<Clip> spread widens).
        project: patchClips(
          get().project,
          new Map([[clipId, (c: Clip): Clip => ({ ...c, ...patch }) as Clip]]),
        ),
      }),

    updateClipCommitted: (clipId, patch) =>
      withHistory((p) => {
        const found = findClip(p, clipId);
        if (found) Object.assign(found.clip, patch);
      }),

    moveClip: (clipId, timelineStartMs, targetTrackId) => {
      const p = get().project;
      const found = findClip(p, clipId);
      if (!found) return;
      const start = Math.max(0, timelineStartMs);
      const target =
        targetTrackId && targetTrackId !== found.track.id
          ? p.tracks.find((t) => t.id === targetTrackId)
          : undefined;
      if (target && target.kind === found.track.kind) {
        const moved: Clip = { ...found.clip, timelineStartMs: start, trackId: target.id };
        const tracks = p.tracks.map((t) => {
          if (t.id === found.track.id) return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
          if (t.id === target.id) return { ...t, clips: [...t.clips, moved] };
          return t;
        });
        set({ project: { ...p, tracks } });
        return;
      }
      if (found.clip.timelineStartMs === start) return;
      set({
        project: patchClips(p, new Map([[clipId, (c: Clip) => ({ ...c, timelineStartMs: start })]])),
      });
    },

    moveClips: (entries) => {
      const edits = new Map<string, (c: Clip) => Clip>();
      for (const { clipId, timelineStartMs } of entries) {
        const start = Math.max(0, timelineStartMs);
        edits.set(clipId, (c) => (c.timelineStartMs === start ? c : { ...c, timelineStartMs: start }));
      }
      set({ project: patchClips(get().project, edits) });
    },

    trimClip: (clipId, edge, timelineMs) => {
      const assets = get().assets;
      const edit = (clip: Clip): Clip => {
        const asset = assets[clip.assetId];
        const minSourceSpan = MIN_CLIP_DURATION_MS * clip.speed;
        if (edge === 'left') {
          const proposed = Math.max(0, timelineMs);
          let sourceIn = clip.sourceInMs + (proposed - clip.timelineStartMs) * clip.speed;
          sourceIn = clamp(sourceIn, 0, clip.sourceOutMs - minSourceSpan);
          if (sourceIn === clip.sourceInMs) return clip;
          return {
            ...clip,
            timelineStartMs: clip.timelineStartMs + (sourceIn - clip.sourceInMs) / clip.speed,
            sourceInMs: sourceIn,
          };
        }
        let sourceOut = clip.sourceInMs + (timelineMs - clip.timelineStartMs) * clip.speed;
        const maxOut = asset ? asset.durationMs : Infinity;
        sourceOut = clamp(sourceOut, clip.sourceInMs + minSourceSpan, maxOut);
        if (sourceOut === clip.sourceOutMs) return clip;
        return { ...clip, sourceOutMs: sourceOut };
      };
      set({ project: patchClips(get().project, new Map([[clipId, edit]])) });
    },

    splitAtPlayhead: () => {
      const { currentTimeMs, selectedClipId, project } = get();
      // Target: the selected clip if the playhead is inside it, otherwise every clip under it.
      const collect = (onlySelected: boolean): string[] => {
        const out: string[] = [];
        for (const track of project.tracks) {
          for (const clip of track.clips) {
            const inside =
              currentTimeMs > clip.timelineStartMs + 1 && currentTimeMs < clipEndMs(clip) - 1;
            if (inside && (!onlySelected || clip.id === selectedClipId)) out.push(clip.id);
          }
        }
        return out;
      };
      let targets = selectedClipId ? collect(true) : [];
      if (targets.length === 0) targets = collect(false);
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

    deleteClip: (clipId) => get().deleteClips([clipId], false),

    rippleDeleteClip: (clipId) => get().deleteClips([clipId], true),

    deleteClips: (clipIds, ripple) => {
      if (clipIds.length === 0) return;
      withHistory((p) => {
        for (const track of p.tracks) {
          // Right-to-left so each ripple shift leaves the earlier targets in place.
          const doomed = track.clips
            .filter((c) => clipIds.includes(c.id))
            .sort((a, b) => b.timelineStartMs - a.timelineStartMs);
          for (const clip of doomed) {
            const start = clip.timelineStartMs;
            const gap = clipDurationMs(clip);
            track.clips = track.clips.filter((c) => c.id !== clip.id);
            if (ripple) {
              for (const c of track.clips) {
                if (c.timelineStartMs >= start) {
                  c.timelineStartMs = Math.max(0, c.timelineStartMs - gap);
                }
              }
            }
          }
        }
      });
      pruneSelection();
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
      if (newId) set({ selectedClipId: newId, selectedClipIds: [newId] });
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
      const newId = uid('clip');
      // The pasted clip keeps the playhead position (priority) when overlaps settle.
      withHistory((p) => {
        const track = ensureTrack(p, clipboard.kind, clipboard.clip.trackId);
        track.clips.push({
          ...structuredClone(clipboard.clip),
          id: newId,
          trackId: track.id,
          timelineStartMs: currentTimeMs,
        });
      }, newId);
      set({ selectedClipId: newId, selectedClipIds: [newId] });
    },

    punchZoomSelected: () => {
      const { selectedClipId, currentTimeMs, project } = get();
      // Fall back to the topmost video clip under the playhead, so the
      // J/K/L → S → P flow works without ever touching the mouse.
      let targetId = selectedClipId;
      if (!targetId) {
        for (const track of [...project.tracks].reverse()) {
          if (track.kind !== 'video') continue;
          const hit = track.clips.find(
            (c) => currentTimeMs >= c.timelineStartMs && currentTimeMs < clipEndMs(c),
          );
          if (hit) {
            targetId = hit.id;
            break;
          }
        }
      }
      if (!targetId) return;
      withHistory((p) => {
        const found = findClip(p, targetId!);
        if (!found) return;
        const tf = found.clip.transform ?? structuredClone(DEFAULT_TRANSFORM);
        const next = tf.scale < 1.1 ? 1.2 : tf.scale < 1.3 ? 1.4 : 1;
        found.clip.transform = { ...tf, scale: next };
      }, targetId);
      set({ selectedClipId: targetId, selectedClipIds: [targetId] });
    },

    toggleSnap: () => set({ snapEnabled: !get().snapEnabled }),

    addSubtitleClips: (cues) => {
      if (cues.length === 0) return;
      withHistory((p) => {
        // Captions always live on their own dedicated video track, composited
        // above any footage. Z-order = array order (the last video track draws
        // on top), so the caption track goes LAST, not first.
        const track: Track = { id: uid('track'), kind: 'video', clips: [] };
        p.tracks.push(track);
        for (const cue of cues) {
          track.clips.push({
            kind: 'text',
            id: uid('clip'),
            assetId: '',
            trackId: track.id,
            timelineStartMs: cue.startMs,
            sourceInMs: 0,
            sourceOutMs: Math.max(MIN_CLIP_DURATION_MS, cue.endMs - cue.startMs),
            speed: 1,
            volume: 1,
            fadeInMs: 0,
            fadeOutMs: 0,
            // Caption defaults: outlined, slightly smaller than a title,
            // lower-third position (y 0.82).
            transform: { ...structuredClone(DEFAULT_TRANSFORM), y: 0.82 },
            text: { content: cue.text, color: '#ffffff', sizeFrac: 0.05, bold: true, outline: true },
          });
        }
      }, null);
    },

    applyStreamLayout: (clipId) => {
      const state = get();
      const found = findClip(state.project, clipId);
      const asset = found ? state.assets[found.clip.assetId] : undefined;
      if (!found || found.track.kind !== 'video' || !asset?.width || !asset?.height) return;
      const { width: outW, height: outH } = outputDimensions(state.project.aspectRatio);
      const srcW = asset.width;
      const srcH = asset.height;

      /** Transform that makes `crop` COVER a zone centered at (cx,cy), sized w×h (output px). */
      const coverZone = (
        crop: ClipTransform['crop'],
        cx: number,
        cy: number,
        w: number,
        h: number,
      ): ClipTransform => {
        const cropW = Math.max(1, crop.w * srcW);
        const cropH = Math.max(1, crop.h * srcH);
        const fit = Math.min(outW / cropW, outH / cropH);
        const scale = Math.max(w / (cropW * fit), h / (cropH * fit));
        return { crop, x: cx / outW, y: cy / outH, scale };
      };

      // Facecam: top-left corner of the source by default (adjust in crop mode).
      const camCrop = { x: 0, y: 0, w: 0.3, h: 0.35 };
      // Gameplay: centered band matching the bottom zone's aspect ratio.
      const zoneH = outH * 0.7;
      const gameW = Math.min(1, (outW / zoneH) * (srcH / srcW));
      const gameCrop = { x: (1 - gameW) / 2, y: 0, w: gameW, h: 1 };

      const camClipId = uid('clip');
      withHistory((p) => {
        const inner = findClip(p, clipId);
        if (!inner) return;
        // Gameplay stays on its track, filling the bottom zone.
        inner.clip.transform = coverZone(gameCrop, outW / 2, outH * 0.3 + zoneH / 2, outW, zoneH);
        // Facecam duplicate on a NEW track above (captions/titles keep their own).
        const camTrack: Track = { id: uid('track'), kind: 'video', clips: [] };
        const idx = p.tracks.findIndex((t) => t.id === inner.track.id);
        p.tracks.splice(idx, 0, camTrack);
        camTrack.clips.push({
          ...structuredClone(inner.clip),
          id: camClipId,
          trackId: camTrack.id,
          // The facecam layer is a picture layer: it must not add audio on top.
          volume: 0,
          transform: coverZone(camCrop, outW / 2, (outH * 0.3) / 2, outW, outH * 0.3),
        });
      }, clipId);
      set({ selectedClipId: camClipId, selectedClipIds: [camClipId], cropEditing: true });
    },

    cropEditing: false,
    setCropEditing: (v) => set({ cropEditing: v }),

    beginGesture: () => set({ gestureSnapshot: get().project }),

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

    seek: (ms) => {
      const duration = projectDurationMs(get().project);
      set({
        currentTimeMs: clamp(ms, 0, Math.max(duration, 0)),
        seekVersion: get().seekVersion + 1,
      });
    },

    setCurrentTimeFromEngine: (ms) => set({ currentTimeMs: ms }),

    setPlaying: (playing) => {
      const { loopEnabled, loopRegion, currentTimeMs } = get();
      // Hitting play with the loop armed from outside the region starts at its in point.
      if (
        playing &&
        loopEnabled &&
        loopRegion &&
        (currentTimeMs < loopRegion.startMs || currentTimeMs >= loopRegion.endMs)
      ) {
        get().seek(loopRegion.startMs);
      }
      set({ playing, ...(playing ? {} : { playbackRate: 1 }) });
    },

    setPlaybackRate: (rate) => set({ playbackRate: clamp(rate, 0.25, 8) }),

    setLoopRegion: (region) => {
      if (!region) {
        set({ loopRegion: null });
        return;
      }
      const startMs = Math.max(0, Math.min(region.startMs, region.endMs));
      const endMs = Math.max(0, Math.max(region.startMs, region.endMs));
      set({ loopRegion: endMs - startMs < MIN_REGION_MS ? null : { startMs, endMs } });
    },

    setRegionEdgeAtPlayhead: (edge) => {
      const { loopRegion, currentTimeMs } = get();
      const other = edge === 'in' ? loopRegion?.endMs : loopRegion?.startMs;
      // No region yet (or the edge would cross the other one): the untouched edge
      // falls back to the project end (I) or the origin (O).
      const fallback = edge === 'in' ? projectDurationMs(get().project) : 0;
      const anchor = other ?? fallback;
      get().setLoopRegion(
        edge === 'in'
          ? { startMs: currentTimeMs, endMs: Math.max(currentTimeMs, anchor) }
          : { startMs: Math.min(currentTimeMs, anchor), endMs: currentTimeMs },
      );
    },

    toggleLoopEnabled: () => set({ loopEnabled: !get().loopEnabled }),

    addMarkerAtPlayhead: () => {
      const { currentTimeMs, project } = get();
      if (sortedMarkers(project).some((m) => Math.abs(m.timeMs - currentTimeMs) < 1)) return;
      withHistory((p) => {
        p.markers = [
          ...p.markers,
          { id: uid('marker'), timeMs: Math.max(0, currentTimeMs), label: '' },
        ];
      });
    },

    moveMarker: (markerId, timeMs) => {
      const p = get().project;
      const at = Math.max(0, timeMs);
      const markers = p.markers.map((m) => (m.id === markerId ? { ...m, timeMs: at } : m));
      set({ project: { ...p, markers } });
    },

    renameMarker: (markerId, label) =>
      withHistory((p) => {
        const marker = p.markers.find((m) => m.id === markerId);
        if (marker) marker.label = label;
      }),

    removeMarker: (markerId) =>
      withHistory((p) => {
        p.markers = p.markers.filter((m) => m.id !== markerId);
      }),

    hydrate: (project, assets) => {
      const map: Record<string, MediaAsset> = {};
      for (const a of assets) map[a.id] = a;
      set({
        // Projects saved before markers existed restore without the field.
        project: { ...project, markers: project.markers ?? [] },
        assets: map,
        past: [],
        future: [],
        selectedClipId: null,
        selectedClipIds: [],
        currentTimeMs: 0,
        loopRegion: null,
        seekVersion: get().seekVersion + 1,
      });
    },

    resetProject: () => {
      for (const id of Object.keys(get().assets)) disposeAssetResources(id);
      set({
        project: createEmptyProject(),
        assets: {},
        past: [],
        future: [],
        selectedClipId: null,
        selectedClipIds: [],
        clipboard: null,
        inspectorOpen: false,
        currentTimeMs: 0,
        loopRegion: null,
        seekVersion: get().seekVersion + 1,
        playing: false,
      });
    },

    setPxPerSec: (v) => set({ pxPerSec: clamp(v, MIN_PX_PER_SEC, MAX_PX_PER_SEC) }),

    setTimelinePadLeft: (px) => {
      if (get().timelinePadLeft !== px) set({ timelinePadLeft: px });
    },

    setInspectorOpen: (open) => set({ inspectorOpen: open }),
    setLibraryOpen: (open) => set({ libraryOpen: open }),
    setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
    setPreferencesOpen: (open) => set({ preferencesOpen: open }),

    setTimeFormat: (format) => {
      try {
        localStorage.setItem(TIME_FORMAT_KEY, format);
      } catch {
        /* private mode / no storage - the choice just won't persist */
      }
      set({ timeFormat: format });
    },

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

export { clipDurationMs, clipEndMs, projectDurationMs, sortedMarkers };
export type { LoopRegion, Marker };
