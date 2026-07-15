import {
  Clip,
  LoopRegion,
  MediaAsset,
  Project,
  Track,
  AspectRatio,
} from '../types';
import type { TimeFormat } from '../lib/time';

export interface ClipboardEntry {
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
  /** About dialog (app name, version). */
  aboutOpen: boolean;
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
  /**
   * Re-probe a user-chosen file for an asset whose persisted File went stale
   * (see `MediaAsset.disconnected`), keeping the asset id so its clips reconnect.
   */
  reconnectAsset: (assetId: string, file: File) => Promise<void>;
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
  setAboutOpen: (open: boolean) => void;
  setTimeFormat: (format: TimeFormat) => void;
  setExportOpen: (open: boolean) => void;
  setImporting: (v: boolean) => void;
  setError: (msg: string | null) => void;
}
